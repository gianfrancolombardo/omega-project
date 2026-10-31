import type { AlertKind, MoodInstrument, SessionStatus } from "@/lib/domain";
import type { AppDeps } from "@/lib/http/deps";
import { awaitDefer } from "@/lib/http/defer";
import { recordSafetyAlert } from "@/lib/http/alerts";
import type { HttpResult } from "@/lib/http/guard";
import { requirePin } from "@/lib/http/guard";
import { extractFactsFromTranscript } from "@/lib/memory/extract";
import { memoryIsOpen, parseFactInput } from "@/lib/profile";
import { describeMemory } from "@/lib/prompt/assemble";
import { AFTERCARE, assessUtterance, safetyScript } from "@/lib/safety/assess";
import { sustainedLowMood } from "@/lib/safety/phq";
import { localDateInZone } from "@/lib/time";
import { normalize } from "@/lib/text";

const MOODS: MoodInstrument[] = ["ucla3", "who5", "phq2", "daily"];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toolArgs(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return toolArgs(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return asRecord(value) ?? {};
}

function text(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function toolResult(output: string, hangup: SessionStatus | null = null): HttpResult {
  return { status: 200, body: { output, hangup } };
}

export async function handleTool(deps: AppDeps, headers: Headers, body: unknown): Promise<HttpResult> {
  const denied = requirePin(deps, headers);
  if (denied) return denied;
  const record = asRecord(body);
  const token = text(record?.sessionToken, 200);
  const name = text(record?.name, 80);
  if (!token || !name) return { status: 400, body: { error: "bad_request", message: "Falta la herramienta." } };
  const session = await deps.store.getSessionByToken(token);
  if (!session || session.status !== "active") {
    return { status: 401, body: { error: "unknown_session", message: "No encuentro esa charla." } };
  }
  const args = toolArgs(record?.arguments);
  const profile = await deps.store.getProfile();
  const now = deps.now();

  if (name === "remember_fact") {
    if (!memoryIsOpen(profile)) {
      return toolResult("No hay permiso para guardar. No lo digas. Seguí la charla.");
    }
    const parsed = parseFactInput({ category: args.category, content: args.content });
    if (!parsed.ok) return toolResult(parsed.message);
    const saved = await deps.store.addFact({
      category: parsed.category,
      content: parsed.content,
      source: "tool",
      sourceSessionId: session.id,
    });
    if (!saved.ok) return toolResult("No guardo medicación ni diagnósticos. No lo menciones.");
    return toolResult("Silencio. No digas que guardaste, actualizaste o anotaste nada. Seguí la charla.");
  }

  if (name === "capture_memory") {
    if (!memoryIsOpen(profile)) {
      return toolResult("No hay permiso para guardar.");
    }
    const spoken = text(args.text, 2000);
    const incoming = extractFactsFromTranscript([{ role: "user", text: spoken, at: now.toISOString() }]);
    const notes: string[] = [];
    for (const fact of incoming) {
      const saved = await deps.store.addFact({
        category: fact.category,
        content: fact.content,
        source: "tool",
        sourceSessionId: session.id,
      });
      if (saved.ok && (saved.created || saved.updated)) notes.push(saved.fact.content);
    }
    return toolResult(notes.length ? `Silencio. ${notes.join(" | ")}` : "Nada nuevo para guardar.");
  }

  if (name === "recall_facts") {
    const facts = await deps.store.searchFacts(text(args.query, 200), 5);
    if (!facts.length) return toolResult("No hay un dato que coincida. No lo inventes y no digas que buscaste en una memoria.");
    return toolResult(
      `Usalo solo si hace falta, sin decir que lo buscaste. ${facts.map((fact) => `(${fact.category}) ${fact.content}`).join(" | ")}`,
    );
  }

  if (name === "forget_fact") {
    const query = text(args.query, 200);
    const normalized = normalize(query);
    if (!normalized || /^(eso|esto|el ultimo|lo ultimo|la ultima|ultimo|ultima)$/.test(normalized)) {
      return toolResult("No borres nada todavía. Preguntá «¿lo de …?» con un dato reciente y, si confirma, llamá forget_fact con ese dato.");
    }
    const forgotten = await deps.store.forgetFact(query);
    if (!forgotten) {
      return toolResult("No encontré ese dato suelto. No le pidas que lo administre ni hables de una memoria. Seguí la charla.");
    }
    await deps.store.addAvoidTopic(forgotten.content);
    return toolResult("Listo. No digas que borraste nada ni que hay una memoria. Seguí la charla.");
  }

  if (name === "what_do_you_know") {
    const facts = await deps.store.listFacts();
    return toolResult(describeMemory(profile, facts));
  }

  if (name === "log_mood") {
    const instrument = MOODS.find((item) => item === args.instrument);
    if (!instrument) return toolResult("No registré la señal: falta el instrumento.");
    const rawAnswer = text(args.raw_answer, 300);
    if (!rawAnswer) return toolResult("No registré la señal: falta la respuesta.");
    const score = typeof args.score === "number" && Number.isFinite(args.score) ? Math.min(5, Math.max(0, args.score)) : null;
    await deps.store.addMood({
      sessionId: session.id,
      instrument,
      itemId: text(args.item_id, 80) || instrument,
      rawAnswer,
      score,
      note: text(args.note, 300),
    });
    const moods = await deps.store.listMood(40);
    if (sustainedLowMood(moods, now)) {
      await recordSafetyAlert(deps, {
        sessionId: session.id,
        level: 2,
        kind: "distress",
        reason: "Dos mediciones PHQ-2 de 3 o más en 21 días. No es un diagnóstico.",
        excerpt: rawAnswer,
        windowMs: 7 * 24 * 60 * 60 * 1000,
      });
    }
    const low =
      (instrument === "phq2" && (score ?? 0) >= 2) ||
      (instrument === "ucla3" && score === 3) ||
      (instrument === "who5" && score != null && score <= 1);
    return toolResult(
      low
        ? "Señal guardada. No cambies de tema todavía: reflejá en una frase lo que dijo, preguntá qué le haría bien hoy y, si encaja, proponé contárselo a alguien de su gente o a su médico. Una sola pregunta."
        : "Señal guardada. Seguí la charla con naturalidad.",
    );
  }

  if (name === "save_microgoal") {
    const content = text(args.content, 240);
    if (content.length < 2) return toolResult("La micro-meta es demasiado corta.");
    const goal = await deps.store.addMicrogoal(content, session.id);
    return toolResult(`Micro-meta guardada: ${goal.content}`);
  }

  if (name === "complete_microgoal") {
    const goal = await deps.store.completeMicrogoal(text(args.query, 200) || "ultimo");
    if (!goal) return toolResult("No encontré esa micro-meta abierta.");
    return toolResult(`Marqué hecha: ${goal.content}`);
  }

  if (name === "flag_concern") {
    const reason = text(args.reason, 300) || "Preocupación marcada en la charla";
    const excerpt = text(args.excerpt, 500);
    const scan = assessUtterance(`${excerpt} ${reason}`);
    const level: 2 | 3 = args.level === 3 || scan.level === 3 ? 3 : 2;
    const kind: AlertKind = scan.kind === "none" ? "concern" : scan.kind;
    const alreadyScripted = record?.emergency === true;
    if (alreadyScripted) {
      void awaitDefer(deps.defer, async () => {
        await recordSafetyAlert(deps, { sessionId: session.id, level, kind, reason, excerpt });
      });
      return toolResult(AFTERCARE);
    }
    const script =
      level === 3
        ? safetyScript(kind === "suicide" ? "suicide" : "emergency", profile.addressForm)
        : safetyScript("distress", profile.addressForm);
    const alerts = await deps.store.listAlerts(10);
    const recent = alerts.some((item) => item.kind === kind && Date.parse(item.createdAt) >= now.getTime() - 10 * 60 * 1000);
    void awaitDefer(deps.defer, async () => {
      await recordSafetyAlert(deps, { sessionId: session.id, level, kind, reason, excerpt });
    });
    const note = recent ? "El aviso ya estaba anotado." : "Dejé un aviso.";
    return toolResult(`${note} Decí ahora, sin otra pregunta: ${script}`);
  }

  if (name === "record_consent") {
    const accepted = args.accepted === true;
    await deps.store.recordConsent(now.toISOString(), accepted);
    return toolResult(
      accepted
        ? "Permiso anotado. No hables de memoria. Seguí la charla."
        : "Quedó anotado que no guardamos memoria. No lo digas. Seguí la charla.",
    );
  }

  if (name === "decline_session") {
    const retry = args.retry_ok === true;
    const date = localDateInZone(now, profile.timezone || deps.config.timezone);
    await deps.store.updateProactive(date, retry ? "no_response" : "decline", now);
    return toolResult("La persona no quiere seguir ahora. Despedite en una frase y no insistas.", "declined");
  }

  if (name === "end_session") {
    return toolResult("Despedite en una frase, cálida y breve.", "completed");
  }

  return { status: 400, body: { error: "unknown_tool", message: "No conozco esa herramienta." } };
}

export async function handleSafety(deps: AppDeps, headers: Headers, body: unknown): Promise<HttpResult> {
  const denied = requirePin(deps, headers);
  if (denied) return denied;
  const record = asRecord(body);
  const token = text(record?.sessionToken, 200);
  const spoken = text(record?.text, 2000);
  if (!token || !spoken) return { status: 400, body: { error: "bad_request", message: "Falta el texto." } };
  const session = await deps.store.getSessionByToken(token);
  if (!session || session.status !== "active") {
    return { status: 401, body: { error: "unknown_session", message: "No encuentro esa charla." } };
  }
  const assessment = assessUtterance(spoken);
  if (assessment.level === 0 || assessment.kind === "none") {
    return { status: 200, body: { level: 0, kind: "none", sayNow: null, interrupt: false } };
  }
  const level = assessment.level === 3 ? 3 : 2;
  await recordSafetyAlert(deps, {
    sessionId: session.id,
    level,
    kind: assessment.kind,
    reason: assessment.reason,
    excerpt: spoken,
  });
  const profile = await deps.store.getProfile();
  return {
    status: 200,
    body: {
      level,
      kind: assessment.kind,
      sayNow: safetyScript(assessment.kind, profile.addressForm),
      interrupt: level === 3,
    },
  };
}
