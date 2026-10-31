import type { NormalizedUsage, SessionInitiator, SessionStatus, TranscriptTurn } from "@/lib/domain";
import { EMPTY_USAGE } from "@/lib/domain";
import { MISSING_KEY_MESSAGE } from "@/lib/copy";
import type { AppDeps } from "@/lib/http/deps";
import { awaitDefer } from "@/lib/http/defer";
import { recordSafetyAlert } from "@/lib/http/alerts";
import type { HttpResult } from "@/lib/http/guard";
import { requirePin } from "@/lib/http/guard";
import { transcriptionHint } from "@/lib/openai/asr";
import { mintClientSecret } from "@/lib/openai/mint";
import { shouldAlertFromSummary, summarizeSession } from "@/lib/openai/summarize";
import { extractFactsFromTranscript } from "@/lib/memory/extract";
import { mergeIncomingFacts } from "@/lib/memory/reconcile";
import { mentionsAvoidedTopic } from "@/lib/memory/select";
import { memoryIsOpen } from "@/lib/profile";
import { assembleInstructions } from "@/lib/prompt/assemble";
import { planDay } from "@/lib/session/planner";
import { proactiveDecision } from "@/lib/session/proactive";
import { tallyTranscript } from "@/lib/metrics/tally";
import { priceUsage, sumUsage } from "@/lib/metrics/cost";
import { formatDayContext, localDateInZone, zonedParts } from "@/lib/time";
import { threeLowMoodDays } from "@/lib/safety/phq";

const STALE_MS = 45 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DECLINED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const OUTCOMES: SessionStatus[] = ["completed", "accidental", "declined", "no_response", "error"];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function initiatorOf(body: unknown): SessionInitiator {
  const record = asRecord(body);
  return record?.initiator === "proactive" ? "proactive" : "user";
}

export function parseTranscript(value: unknown): TranscriptTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: TranscriptTurn[] = [];
  for (const item of value.slice(0, 400)) {
    const record = asRecord(item);
    if (!record) continue;
    if (record.role !== "user" && record.role !== "assistant") continue;
    if (typeof record.text !== "string") continue;
    const text = record.text.trim().slice(0, 4000);
    if (!text) continue;
    const at = typeof record.at === "string" && record.at.trim() ? record.at.slice(0, 40) : new Date().toISOString();
    const itemId = typeof record.itemId === "string" && record.itemId.trim() ? record.itemId.slice(0, 80) : undefined;
    turns.push({ role: record.role, text, at, itemId });
  }
  return turns;
}

function parseUsageEvents(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object").slice(0, 200);
}

function isNormalizedUsage(value: unknown): value is NormalizedUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.inputTokens === "number" && typeof record.outputTokens === "number";
}

function priceSessionUsage(
  model: string,
  record: Record<string, unknown> | null,
): { usage: NormalizedUsage; usd: number; approximate: boolean } {
  if (record && isNormalizedUsage(record.usage)) {
    const priced = priceUsage(model, record.usage, false);
    return { usage: record.usage, usd: priced.usd, approximate: priced.approximate };
  }
  const events = parseUsageEvents(record?.usageEvents ?? record?.usage);
  if (!events.length) {
    const priced = priceUsage(model, EMPTY_USAGE, true);
    return { usage: { ...EMPTY_USAGE }, usd: priced.usd, approximate: true };
  }
  return sumUsage(model, events);
}

function instrumentFromItemId(itemId: string): "ucla3" | "who5" | "phq2" | null {
  if (itemId.startsWith("phq")) return "phq2";
  if (itemId.startsWith("who")) return "who5";
  if (itemId.startsWith("ucla")) return "ucla3";
  return null;
}

function declinedTopicsSince(sessions: Array<{ startedAt: string; summaryMeta?: { declinedTopics?: string[] } | null }>, now: Date): string[] {
  const cutoff = now.getTime() - DECLINED_WINDOW_MS;
  const topics: string[] = [];
  for (const session of sessions) {
    const at = Date.parse(session.startedAt);
    if (!Number.isFinite(at) || at < cutoff) continue;
    for (const topic of session.summaryMeta?.declinedTopics ?? []) {
      if (topic.trim()) topics.push(topic.trim());
    }
  }
  return topics;
}

export async function handleCreateSession(deps: AppDeps, headers: Headers, body: unknown): Promise<HttpResult> {
  const denied = requirePin(deps, headers);
  if (denied) return denied;
  if (!deps.takeMint().ok) {
    return { status: 429, body: { error: "rate_limited", message: "Demasiadas charlas en esta hora. Esperá un rato." } };
  }

  const now = deps.now();
  const initiator = initiatorOf(body);
  const staleBefore = new Date(now.getTime() - STALE_MS).toISOString();
  await deps.store.expireStaleSessions(staleBefore, now.toISOString());
  await deps.store.purgeOldTranscripts(new Date(now.getTime() - RETENTION_MS).toISOString());
  if (await deps.store.hasOpenSession(staleBefore)) {
    return { status: 409, body: { error: "busy", message: "Ya hay una charla abierta." } };
  }

  const profile = await deps.store.getProfile();
  const timezone = profile.timezone || deps.config.timezone;
  const localDate = localDateInZone(now, timezone);
  let claimed = false;
  if (initiator === "proactive") {
    const day = await deps.store.getProactiveDay(localDate);
    const decision = proactiveDecision({
      now,
      timezone,
      dailyTime: profile.dailyTime,
      enabled: profile.proactiveEnabled,
      day,
      sessionActive: false,
    });
    if (!decision.start || !decision.mode) {
      return { status: 409, body: { error: "not_now", message: decision.reason } };
    }
    claimed = await deps.store.tryClaimProactive({ localDate, mode: decision.mode, nowIso: now.toISOString() });
    if (!claimed) {
      return { status: 409, body: { error: "not_now", message: "La charla de hoy ya arrancó." } };
    }
  }

  if (!deps.config.openAiApiKey) {
    if (claimed) await deps.store.undoProactiveClaim(localDate);
    return { status: 503, body: { error: "missing_api_key", message: MISSING_KEY_MESSAGE } };
  }

  const [facts, sessions, moods, goals] = await Promise.all([
    deps.store.listFacts(),
    deps.store.listSessions(12),
    deps.store.listMood(40),
    deps.store.listOpenMicrogoals(),
  ]);
  if (goals[0]) await deps.store.bumpMicrogoalFollowup(goals[0].id);
  const recent = sessions
    .filter((session) => session.status === "completed" || session.userWords > 0)
    .map((session) => ({
      module: session.module,
      localDate: localDateInZone(new Date(session.startedAt), timezone),
    }));
  const plan = planDay({
    today: localDate,
    recent,
    sessionCount: sessions.filter((session) => session.status === "completed").length,
    history: moods.map((signal) => ({
      instrument: signal.instrument,
      itemId: signal.itemId,
      createdAt: signal.createdAt,
    })),
    now,
    addressForm: profile.addressForm,
    lifeNotes: profile.lifeNotes,
    declinedTopics: declinedTopicsSince(sessions, now),
  });

  const created = await deps.store.createSession({
    initiator,
    module: plan.module,
    model: deps.config.realtimeModel,
    voice: deps.config.voice,
  });
  const hour = zonedParts(now, timezone).hour;
  const assembled = assembleInstructions({
    profile,
    facts,
    summaries: sessions
      .filter((session) => session.summary.trim())
      .slice(0, 2)
      .map((session) => ({
        startedAt: session.startedAt,
        module: session.module,
        summary: session.summary,
        openThreads: session.openThreads,
      })),
    microgoals: goals,
    plan,
    dateLabel: formatDayContext(now, timezone),
    firstSession: !sessions.some((session) => session.status !== "error"),
    openerKind: created.session.openerKind ?? "today",
    hour,
  });

  const speed = profile.reducedHearing ? Math.min(deps.config.voiceSpeed, 0.86) : deps.config.voiceSpeed;
  const minted = await mintClientSecret(
    {
      apiKey: deps.config.openAiApiKey,
      model: deps.config.realtimeModel,
      voice: deps.config.voice,
      speed,
      transcriptionModel: deps.config.transcriptionModel,
      noiseReduction: deps.config.noiseReduction,
      instructions: assembled.instructions,
      transcriptionPrompt: transcriptionHint({
        displayName: profile.displayName,
        importantPeople: profile.importantPeople,
        tastes: profile.tastes,
        lifeNotes: profile.lifeNotes,
      }),
    },
    deps.fetchImpl,
  );
  if (!minted.ok) {
    await deps.store.updateSession(created.session.id, {
      status: "error",
      endedAt: now.toISOString(),
      summary: "No se pudo abrir la voz.",
    });
    if (claimed) await deps.store.undoProactiveClaim(localDate);
    return { status: minted.status, body: { error: minted.code, message: minted.message } };
  }

  return {
    status: 200,
    body: {
      clientSecret: minted.value,
      sessionId: created.session.id,
      sessionToken: created.token,
      greetingCue: assembled.greetingCue,
      module: plan.module,
      subtitles: profile.subtitles,
      displayName: profile.displayName,
      addressForm: profile.addressForm,
      silenceCloseSeconds: deps.config.silenceCloseSeconds,
      model: deps.config.realtimeModel,
      openerKind: created.session.openerKind,
    },
  };
}

async function syncProactive(
  deps: AppDeps,
  input: {
    initiator: "user" | "proactive";
    outcome: SessionStatus;
    userSpoke: boolean;
    timezone: string;
    startedAt: string;
  },
): Promise<void> {
  const date = localDateInZone(new Date(input.startedAt), input.timezone);
  const day = await deps.store.getProactiveDay(date);
  if (input.outcome === "declined") {
    if (!day.declined && !day.nextRetryAt) await deps.store.updateProactive(date, "decline", deps.now());
    return;
  }
  if (input.outcome === "no_response" || (input.outcome === "accidental" && input.initiator === "proactive")) {
    if (!day.declined && !day.engaged && !day.nextRetryAt) {
      await deps.store.updateProactive(date, "no_response", deps.now());
    }
    return;
  }
  if (input.userSpoke || input.outcome === "completed") {
    if (!day.declined) await deps.store.updateProactive(date, "engage", deps.now());
  }
}

async function finalizeEndedSession(
  deps: AppDeps,
  sessionId: string,
  turns: TranscriptTurn[],
  outcome: SessionStatus,
): Promise<{ summarySource: "model" | "fallback" | null }> {
  const hasUser = turns.some((turn) => turn.role === "user");
  if (!hasUser || outcome === "accidental" || outcome === "error") {
    return { summarySource: null };
  }
  const profile = await deps.store.getProfile();
  const sessions = await deps.store.listSessions(5);
  const previousThreads = sessions.flatMap((item) => item.openThreads).slice(0, 8);
  const produced = await summarizeSession({
    apiKey: deps.config.openAiApiKey,
    model: deps.config.summaryModel,
    turns,
    fetchImpl: deps.fetchImpl,
    avoidTopics: profile.avoidTopics,
    previousThreads,
  });
  if (memoryIsOpen(profile)) {
    const incoming =
      produced.source === "model"
        ? mergeIncomingFacts(produced.facts)
        : mergeIncomingFacts([...extractFactsFromTranscript(turns), ...produced.facts]);
    for (const fact of incoming) {
      if (mentionsAvoidedTopic(fact.content, profile.avoidTopics)) continue;
      await deps.store.addFact({
        category: fact.category,
        content: fact.content,
        source: "summary",
        sourceSessionId: sessionId,
      });
    }
  }
  const alert = shouldAlertFromSummary(produced.concern);
  if (alert) {
    await recordSafetyAlert(deps, { sessionId, ...alert });
  }
  if (produced.meta.mood != null) {
    await deps.store.addMood({
      sessionId,
      instrument: "daily",
      itemId: "daily_mood",
      rawAnswer: "",
      score: produced.meta.mood,
      note: "",
    });
  }
  const moods = await deps.store.listMood(40);
  const asked = new Set(moods.filter((item) => item.sessionId === sessionId).map((item) => item.itemId));
  for (const itemId of produced.meta.checkinItemsAsked) {
    const instrument = instrumentFromItemId(itemId);
    if (!instrument || asked.has(itemId)) continue;
    await deps.store.addMood({
      sessionId,
      instrument,
      itemId,
      rawAnswer: "",
      score: null,
      note: "asked",
    });
    asked.add(itemId);
  }
  const latestMoods = produced.meta.mood != null ? await deps.store.listMood(40) : moods;
  if (threeLowMoodDays(latestMoods)) {
    await recordSafetyAlert(deps, {
      sessionId,
      level: 2,
      kind: "distress",
      reason: "Tres días seguidos con ánimo bajo. No es un diagnóstico.",
      excerpt: "ánimo diario",
      windowMs: 2 * 24 * 60 * 60 * 1000,
    });
  }
  await deps.store.updateSession(sessionId, {
    summary: produced.summary,
    openThreads: produced.openThreads,
    summarySource: produced.source,
    summaryMeta: produced.meta,
  });
  return { summarySource: produced.source };
}

export async function handleEndSession(deps: AppDeps, headers: Headers, body: unknown): Promise<HttpResult> {
  const denied = requirePin(deps, headers);
  if (denied) return denied;
  const record = asRecord(body);
  const token = typeof record?.sessionToken === "string" ? record.sessionToken : "";
  if (!token) return { status: 400, body: { error: "bad_request", message: "Falta la charla." } };
  const session = await deps.store.getSessionByToken(token);
  if (!session) return { status: 401, body: { error: "unknown_session", message: "No encuentro esa charla." } };
  if (session.endedAt) {
    return { status: 200, body: { ok: true, alreadyEnded: true, status: session.status } };
  }

  const requested = typeof record?.outcome === "string" ? record.outcome : "";
  const outcome = OUTCOMES.includes(requested as SessionStatus) ? (requested as SessionStatus) : "completed";
  const turns = parseTranscript(record?.transcript);
  const userSpoke = record?.userSpoke === true || turns.some((turn) => turn.role === "user");
  const now = deps.now();
  const started = Date.parse(session.startedAt);
  const durationSeconds = Number.isFinite(started) ? Math.max(0, Math.round((now.getTime() - started) / 1000)) : 0;
  const tally = tallyTranscript(turns);
  const priced = priceSessionUsage(session.model, record);
  const profile = await deps.store.getProfile();

  await deps.store.updateSession(session.id, {
    status: outcome,
    endedAt: now.toISOString(),
    transcript: turns,
    durationSeconds,
    userWords: tally.userWords,
    agentWords: tally.agentWords,
    misunderstoodCount: tally.misunderstood,
    elderspeakHits: tally.elderspeakHits,
    usage: priced.usage,
    costUsd: priced.usd,
    costApproximate: priced.approximate,
  });

  let summarySource: "model" | "fallback" | null = null;
  await awaitDefer(deps.defer, async () => {
    const finalized = await finalizeEndedSession(deps, session.id, turns, outcome);
    summarySource = finalized.summarySource;
  });

  await syncProactive(deps, {
    initiator: session.initiator,
    outcome,
    userSpoke,
    timezone: profile.timezone || deps.config.timezone,
    startedAt: session.startedAt,
  });
  return {
    status: 200,
    body: {
      ok: true,
      status: outcome,
      durationSeconds,
      costUsd: priced.usd,
      summarySource,
    },
  };
}

export async function handleProactive(deps: AppDeps, headers: Headers): Promise<HttpResult> {
  const denied = requirePin(deps, headers);
  if (denied) return denied;
  const now = deps.now();
  const staleBefore = new Date(now.getTime() - STALE_MS).toISOString();
  await deps.store.expireStaleSessions(staleBefore, now.toISOString());
  const profile = await deps.store.getProfile();
  const timezone = profile.timezone || deps.config.timezone;
  const localDate = localDateInZone(now, timezone);
  const [day, sessionActive] = await Promise.all([
    deps.store.getProactiveDay(localDate),
    deps.store.hasOpenSession(staleBefore),
  ]);
  const decision = proactiveDecision({
    now,
    timezone,
    dailyTime: profile.dailyTime,
    enabled: profile.proactiveEnabled,
    day,
    sessionActive,
  });
  return {
    status: 200,
    body: {
      shouldStart: decision.start,
      mode: decision.mode,
      reason: decision.reason,
      dailyTime: profile.dailyTime,
      displayName: profile.displayName,
    },
  };
}
