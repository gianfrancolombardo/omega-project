import { createHash, randomBytes, randomUUID } from "node:crypto";

import type {
  AlertKind,
  AlertRecord,
  Fact,
  FactCategory,
  FactSource,
  Microgoal,
  MoodInstrument,
  MoodSignal,
  NormalizedUsage,
  ProactiveDay,
  ProactiveEvent,
  Profile,
  ProfilePatch,
  SessionInitiator,
  SessionRecord,
  SessionStatus,
  TranscriptTurn,
} from "@/lib/domain";
import { EMPTY_USAGE } from "@/lib/domain";
import { isClinicalContent, isFactCategory } from "@/lib/profile";
import type { Db, SqlRow, SqlValue } from "@/lib/db/sql";
import { normalize } from "@/lib/text";
import { applyProactiveEvent } from "@/lib/session/proactive";

export type MemoryStore = {
  getProfile(): Promise<Profile>;
  updateProfile(patch: ProfilePatch): Promise<Profile>;
  recordConsent(at: string, accepted: boolean): Promise<Profile>;
  addFact(input: {
    category: FactCategory;
    content: string;
    sourceSessionId?: string | null;
    source?: FactSource;
  }): Promise<{ ok: true; fact: Fact; created: boolean } | { ok: false; reason: "clinical" | "invalid" }>;
  listFacts(): Promise<Fact[]>;
  searchFacts(query: string, limit?: number): Promise<Fact[]>;
  forgetFact(query: string): Promise<Fact | null>;
  deleteFact(id: string): Promise<boolean>;
  clearMemory(nowIso: string): Promise<void>;
  createSession(input: {
    initiator: SessionInitiator;
    module: string;
    model: string;
    voice: string;
  }): Promise<{ session: SessionRecord; token: string }>;
  getSessionByToken(token: string): Promise<SessionRecord | null>;
  updateSession(id: string, patch: SessionUpdate): Promise<SessionRecord>;
  listSessions(limit: number): Promise<SessionRecord[]>;
  hasOpenSession(sinceIso: string): Promise<boolean>;
  expireStaleSessions(olderThanIso: string, nowIso: string): Promise<void>;
  addMood(input: {
    sessionId: string | null;
    instrument: MoodInstrument;
    itemId: string;
    rawAnswer: string;
    score: number | null;
    note: string;
  }): Promise<MoodSignal>;
  listMood(limit: number): Promise<MoodSignal[]>;
  addAlert(input: {
    sessionId: string | null;
    level: 2 | 3;
    kind: AlertKind;
    reason: string;
    excerpt: string;
    notifyStatus: AlertRecord["notifyStatus"];
    notifyDetail: string;
  }): Promise<AlertRecord>;
  listAlerts(limit: number): Promise<AlertRecord[]>;
  addMicrogoal(content: string, sessionId: string | null): Promise<Microgoal>;
  listOpenMicrogoals(): Promise<Microgoal[]>;
  completeMicrogoal(query: string): Promise<Microgoal | null>;
  getProactiveDay(localDate: string): Promise<ProactiveDay>;
  tryClaimProactive(input: { localDate: string; mode: "first" | "retry"; nowIso: string }): Promise<boolean>;
  undoProactiveClaim(localDate: string): Promise<void>;
  updateProactive(localDate: string, event: ProactiveEvent, now: Date): Promise<ProactiveDay>;
};

export type SessionUpdate = {
  status?: SessionStatus;
  endedAt?: string | null;
  transcript?: TranscriptTurn[];
  summary?: string;
  openThreads?: string[];
  durationSeconds?: number | null;
  userWords?: number;
  agentWords?: number;
  misunderstoodCount?: number;
  elderspeakHits?: number;
  usage?: NormalizedUsage;
  costUsd?: number | null;
  costApproximate?: boolean;
  summarySource?: "model" | "fallback" | null;
};

type StoreOptions = {
  now?: () => Date;
  newId?: () => string;
};

const PROFILE_COLUMNS: Record<keyof ProfilePatch, string> = {
  displayName: "display_name",
  addressForm: "address_form",
  timezone: "timezone",
  dailyTime: "daily_time",
  proactiveEnabled: "proactive_enabled",
  tastes: "tastes",
  lifeNotes: "life_notes",
  avoidTopics: "avoid_topics",
  importantPeople: "important_people",
  emergencyName: "emergency_name",
  emergencyPhone: "emergency_phone",
  emergencyRelation: "emergency_relation",
  reducedHearing: "reduced_hearing",
  subtitles: "subtitles",
};

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function scoreFact(query: string, content: string): number {
  const q = normalize(query);
  const c = normalize(content);
  if (!q || !c) return 0;
  if (c.includes(q) || q.includes(c)) return 10 + Math.min(q.length, c.length);
  const words = q.split(" ").filter((word) => word.length > 2);
  if (!words.length) return 0;
  let hits = 0;
  for (const word of words) {
    if (c.includes(word)) hits += 1;
  }
  return hits / words.length >= 0.5 ? hits : 0;
}

function text(row: SqlRow, key: string): string {
  const value = row[key];
  return value == null ? "" : String(value);
}

function nullable(row: SqlRow, key: string): string | null {
  const value = row[key];
  return value == null || value === "" ? null : String(value);
}

function flag(row: SqlRow, key: string): boolean {
  const value = row[key];
  return value === true || value === 1 || value === "1";
}

function num(row: SqlRow, key: string): number {
  const value = row[key];
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNum(row: SqlRow, key: string): number | null {
  const value = row[key];
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapProfile(row: SqlRow): Profile {
  const address = text(row, "address_form") === "usted" ? "usted" : "vos";
  return {
    displayName: text(row, "display_name"),
    addressForm: address,
    timezone: text(row, "timezone"),
    dailyTime: text(row, "daily_time"),
    proactiveEnabled: flag(row, "proactive_enabled"),
    tastes: text(row, "tastes"),
    lifeNotes: text(row, "life_notes"),
    avoidTopics: text(row, "avoid_topics"),
    importantPeople: text(row, "important_people"),
    emergencyName: text(row, "emergency_name"),
    emergencyPhone: text(row, "emergency_phone"),
    emergencyRelation: text(row, "emergency_relation"),
    reducedHearing: flag(row, "reduced_hearing"),
    subtitles: flag(row, "subtitles"),
    userConsentAt: nullable(row, "user_consent_at"),
    memoryDeclinedAt: nullable(row, "memory_declined_at"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function mapFact(row: SqlRow): Fact {
  const category = text(row, "category");
  const source = text(row, "source");
  return {
    id: text(row, "id"),
    category: isFactCategory(category) ? category : "otro",
    content: text(row, "content"),
    createdAt: text(row, "created_at"),
    sourceSessionId: nullable(row, "source_session_id"),
    source: source === "setup" || source === "summary" || source === "tool" ? source : "tool",
  };
}

function mapUsage(value: string): NormalizedUsage {
  const parsed = parseJson<Partial<NormalizedUsage>>(value, {});
  return { ...EMPTY_USAGE, ...parsed };
}

function mapSession(row: SqlRow, includeTranscript: boolean): SessionRecord {
  const initiator = text(row, "initiator") === "proactive" ? "proactive" : "user";
  const status = text(row, "status");
  const known: SessionStatus[] = ["active", "completed", "accidental", "declined", "no_response", "error"];
  return {
    id: text(row, "id"),
    startedAt: text(row, "started_at"),
    endedAt: nullable(row, "ended_at"),
    initiator,
    module: text(row, "module"),
    status: known.includes(status as SessionStatus) ? (status as SessionStatus) : "error",
    transcript: includeTranscript ? parseJson<TranscriptTurn[]>(text(row, "transcript_json"), []) : [],
    summary: text(row, "summary"),
    openThreads: parseJson<string[]>(text(row, "open_threads_json"), []),
    durationSeconds: nullableNum(row, "duration_seconds"),
    userWords: num(row, "user_words"),
    agentWords: num(row, "agent_words"),
    misunderstoodCount: num(row, "misunderstood_count"),
    elderspeakHits: num(row, "elderspeak_hits"),
    usage: mapUsage(text(row, "usage_json")),
    costUsd: nullableNum(row, "cost_usd"),
    costApproximate: flag(row, "cost_approximate"),
    model: text(row, "model"),
    voice: text(row, "voice"),
    summarySource:
      text(row, "summary_source") === "model" || text(row, "summary_source") === "fallback"
        ? (text(row, "summary_source") as "model" | "fallback")
        : null,
  };
}

function mapMood(row: SqlRow): MoodSignal {
  const instrument = text(row, "instrument");
  const known: MoodInstrument[] = ["ucla3", "who5", "phq2", "daily"];
  return {
    id: text(row, "id"),
    sessionId: nullable(row, "session_id"),
    instrument: known.includes(instrument as MoodInstrument) ? (instrument as MoodInstrument) : "daily",
    itemId: text(row, "item_id"),
    rawAnswer: text(row, "raw_answer"),
    score: nullableNum(row, "score"),
    note: text(row, "note"),
    createdAt: text(row, "created_at"),
  };
}

function mapAlert(row: SqlRow): AlertRecord {
  const level = num(row, "level") >= 3 ? 3 : 2;
  const kindText = text(row, "kind");
  const kinds: AlertKind[] = ["suicide", "emergency", "distress", "concern"];
  const notify = text(row, "notify_status");
  return {
    id: text(row, "id"),
    sessionId: nullable(row, "session_id"),
    level,
    kind: kinds.includes(kindText as AlertKind) ? (kindText as AlertKind) : "concern",
    reason: text(row, "reason"),
    excerpt: text(row, "excerpt"),
    createdAt: text(row, "created_at"),
    notifyStatus: notify === "sent" || notify === "failed" ? notify : "stub",
    notifyDetail: text(row, "notify_detail"),
  };
}

function mapGoal(row: SqlRow): Microgoal {
  return {
    id: text(row, "id"),
    content: text(row, "content"),
    status: text(row, "status") === "done" ? "done" : "open",
    createdAt: text(row, "created_at"),
    sessionId: nullable(row, "session_id"),
  };
}

function mapDay(row: SqlRow, localDate: string): ProactiveDay {
  return {
    localDate: text(row, "local_date") || localDate,
    attempts: num(row, "attempts"),
    declined: flag(row, "declined"),
    engaged: flag(row, "engaged"),
    nextRetryAt: nullable(row, "next_retry_at"),
  };
}

const FORGET_LATEST = /^(eso|esto|el ultimo|lo ultimo|la ultima|el ultimo hecho|ultimo|ultima)$/;

export function createMemoryStore(db: Db, options: StoreOptions = {}): MemoryStore {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());
  let queue: Promise<void> = Promise.resolve();

  function lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function readProfile(): Promise<Profile> {
    const row = await db.get("SELECT * FROM profile WHERE id = 'primary'");
    if (!row) throw new Error("Profile row is missing. Run migrations before using the store.");
    return mapProfile(row);
  }

  async function loadSession(where: string, params: SqlValue[], includeTranscript: boolean): Promise<SessionRecord | null> {
    const row = await db.get(`SELECT * FROM sessions WHERE ${where}`, params);
    return row ? mapSession(row, includeTranscript) : null;
  }

  return {
    getProfile: readProfile,
    async updateProfile(patch) {
      const assignments: string[] = [];
      const params: SqlValue[] = [];
      for (const key of Object.keys(PROFILE_COLUMNS) as Array<keyof ProfilePatch>) {
        if (patch[key] === undefined) continue;
        assignments.push(`${PROFILE_COLUMNS[key]} = ?`);
        const value = patch[key];
        params.push(typeof value === "boolean" ? (value ? 1 : 0) : (value as string));
      }
      assignments.push("updated_at = ?");
      params.push(now().toISOString());
      if (assignments.length > 1) {
        await db.run(`UPDATE profile SET ${assignments.join(", ")} WHERE id = 'primary'`, params);
      }
      return readProfile();
    },
    async recordConsent(at, accepted) {
      if (accepted) {
        await db.run(
          "UPDATE profile SET user_consent_at = ?, memory_declined_at = NULL, updated_at = ? WHERE id = 'primary'",
          [at, at],
        );
      } else {
        await db.run(
          "UPDATE profile SET user_consent_at = NULL, memory_declined_at = ?, updated_at = ? WHERE id = 'primary'",
          [at, at],
        );
      }
      return readProfile();
    },
    async addFact(input) {
      const content = input.content.trim().slice(0, 500);
      if (content.length < 2 || !isFactCategory(input.category)) return { ok: false, reason: "invalid" };
      if (isClinicalContent(content)) return { ok: false, reason: "clinical" };
      const existing = await db.all("SELECT * FROM facts ORDER BY created_at DESC");
      const duplicate = existing.map(mapFact).find((fact) => normalize(fact.content) === normalize(content));
      if (duplicate) return { ok: true, fact: duplicate, created: false };
      const fact: Fact = {
        id: newId(),
        category: input.category,
        content,
        createdAt: now().toISOString(),
        sourceSessionId: input.sourceSessionId ?? null,
        source: input.source ?? "tool",
      };
      await db.run(
        "INSERT INTO facts (id, category, content, created_at, source_session_id, source) VALUES (?, ?, ?, ?, ?, ?)",
        [fact.id, fact.category, fact.content, fact.createdAt, fact.sourceSessionId, fact.source],
      );
      return { ok: true, fact, created: true };
    },
    async listFacts() {
      const rows = await db.all("SELECT * FROM facts ORDER BY created_at DESC");
      return rows.map(mapFact);
    },
    async searchFacts(query, limit = 5) {
      const facts = await this.listFacts();
      if (!query.trim()) return facts.slice(0, limit);
      return facts
        .map((fact) => ({ fact, score: scoreFact(query, fact.content) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || b.fact.createdAt.localeCompare(a.fact.createdAt))
        .slice(0, limit)
        .map((item) => item.fact);
    },
    async forgetFact(query) {
      const facts = await this.listFacts();
      if (!facts.length) return null;
      const normalized = normalize(query);
      let target: Fact | undefined;
      if (!normalized || FORGET_LATEST.test(normalized)) {
        target = facts[0];
      } else {
        const ranked = facts
          .map((fact) => ({ fact, score: scoreFact(query, fact.content) }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score);
        target = ranked[0]?.fact;
      }
      if (!target) return null;
      await db.run("DELETE FROM facts WHERE id = ?", [target.id]);
      return target;
    },
    async deleteFact(id) {
      const result = await db.run("DELETE FROM facts WHERE id = ?", [id]);
      return result.changes > 0;
    },
    async clearMemory(nowIso) {
      await db.exec("DELETE FROM facts");
      await db.exec("DELETE FROM sessions");
      await db.exec("DELETE FROM mood_signals");
      await db.exec("DELETE FROM alerts");
      await db.exec("DELETE FROM microgoals");
      await db.exec("DELETE FROM proactive_days");
      await db.run(
        "UPDATE profile SET user_consent_at = NULL, memory_declined_at = NULL, updated_at = ? WHERE id = 'primary'",
        [nowIso],
      );
    },
    async createSession(input) {
      const token = randomBytes(32).toString("base64url");
      const createdAt = now().toISOString();
      const session: SessionRecord = {
        id: newId(),
        startedAt: createdAt,
        endedAt: null,
        initiator: input.initiator,
        module: input.module,
        status: "active",
        transcript: [],
        summary: "",
        openThreads: [],
        durationSeconds: null,
        userWords: 0,
        agentWords: 0,
        misunderstoodCount: 0,
        elderspeakHits: 0,
        usage: { ...EMPTY_USAGE },
        costUsd: null,
        costApproximate: false,
        model: input.model,
        voice: input.voice,
        summarySource: null,
      };
      await db.run(
        `INSERT INTO sessions (
          id, token_hash, started_at, ended_at, initiator, module, status,
          transcript_json, summary, open_threads_json, duration_seconds,
          user_words, agent_words, misunderstood_count, elderspeak_hits,
          usage_json, cost_usd, cost_approximate, model, voice, summary_source
        ) VALUES (?, ?, ?, NULL, ?, ?, 'active', '[]', '', '[]', NULL, 0, 0, 0, 0, ?, NULL, 0, ?, ?, NULL)`,
        [session.id, hashSecret(token), createdAt, input.initiator, input.module, JSON.stringify(EMPTY_USAGE), input.model, input.voice],
      );
      return { session, token };
    },
    getSessionByToken(token) {
      return loadSession("token_hash = ?", [hashSecret(token)], true);
    },
    async updateSession(id, patch) {
      const assignments: string[] = [];
      const params: SqlValue[] = [];
      const set = (column: string, value: SqlValue) => {
        assignments.push(`${column} = ?`);
        params.push(value);
      };
      if (patch.status) set("status", patch.status);
      if (patch.endedAt !== undefined) set("ended_at", patch.endedAt);
      if (patch.transcript) set("transcript_json", JSON.stringify(patch.transcript));
      if (patch.summary !== undefined) set("summary", patch.summary);
      if (patch.openThreads) set("open_threads_json", JSON.stringify(patch.openThreads));
      if (patch.durationSeconds !== undefined) set("duration_seconds", patch.durationSeconds);
      if (patch.userWords !== undefined) set("user_words", patch.userWords);
      if (patch.agentWords !== undefined) set("agent_words", patch.agentWords);
      if (patch.misunderstoodCount !== undefined) set("misunderstood_count", patch.misunderstoodCount);
      if (patch.elderspeakHits !== undefined) set("elderspeak_hits", patch.elderspeakHits);
      if (patch.usage) set("usage_json", JSON.stringify(patch.usage));
      if (patch.costUsd !== undefined) set("cost_usd", patch.costUsd);
      if (patch.costApproximate !== undefined) set("cost_approximate", patch.costApproximate ? 1 : 0);
      if (patch.summarySource !== undefined) set("summary_source", patch.summarySource);
      if (assignments.length) {
        params.push(id);
        await db.run(`UPDATE sessions SET ${assignments.join(", ")} WHERE id = ?`, params);
      }
      const row = await db.get("SELECT * FROM sessions WHERE id = ?", [id]);
      if (!row) throw new Error("Session disappeared during update.");
      return mapSession(row, true);
    },
    async listSessions(limit) {
      const rows = await db.all(
        `SELECT id, token_hash, started_at, ended_at, initiator, module, status,
          '' AS transcript_json, summary, open_threads_json, duration_seconds,
          user_words, agent_words, misunderstood_count, elderspeak_hits,
          usage_json, cost_usd, cost_approximate, model, voice, summary_source
         FROM sessions ORDER BY started_at DESC LIMIT ?`,
        [limit],
      );
      return rows.map((row) => mapSession(row, false));
    },
    async hasOpenSession(sinceIso) {
      const row = await db.get(
        "SELECT id FROM sessions WHERE status = 'active' AND started_at >= ? LIMIT 1",
        [sinceIso],
      );
      return Boolean(row);
    },
    async expireStaleSessions(olderThanIso, nowIso) {
      await db.run(
        `UPDATE sessions
         SET status = 'error', ended_at = ?, summary = CASE WHEN summary = '' THEN 'La sesión quedó interrumpida.' ELSE summary END
         WHERE status = 'active' AND started_at < ?`,
        [nowIso, olderThanIso],
      );
    },
    async addMood(input) {
      const signal: MoodSignal = {
        id: newId(),
        sessionId: input.sessionId,
        instrument: input.instrument,
        itemId: input.itemId.slice(0, 80),
        rawAnswer: input.rawAnswer.trim().slice(0, 500),
        score: input.score,
        note: input.note.trim().slice(0, 500),
        createdAt: now().toISOString(),
      };
      await db.run(
        `INSERT INTO mood_signals (id, session_id, instrument, item_id, raw_answer, score, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [signal.id, signal.sessionId, signal.instrument, signal.itemId, signal.rawAnswer, signal.score, signal.note, signal.createdAt],
      );
      return signal;
    },
    async listMood(limit) {
      const rows = await db.all("SELECT * FROM mood_signals ORDER BY created_at DESC LIMIT ?", [limit]);
      return rows.map(mapMood);
    },
    async addAlert(input) {
      const alert: AlertRecord = {
        id: newId(),
        sessionId: input.sessionId,
        level: input.level,
        kind: input.kind,
        reason: input.reason.trim().slice(0, 500),
        excerpt: input.excerpt.trim().slice(0, 240),
        createdAt: now().toISOString(),
        notifyStatus: input.notifyStatus,
        notifyDetail: input.notifyDetail.slice(0, 500),
      };
      await db.run(
        `INSERT INTO alerts (id, session_id, level, kind, reason, excerpt, created_at, notify_status, notify_detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [alert.id, alert.sessionId, alert.level, alert.kind, alert.reason, alert.excerpt, alert.createdAt, alert.notifyStatus, alert.notifyDetail],
      );
      return alert;
    },
    async listAlerts(limit) {
      const rows = await db.all("SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?", [limit]);
      return rows.map(mapAlert);
    },
    async addMicrogoal(content, sessionId) {
      const goal: Microgoal = {
        id: newId(),
        content: content.trim().slice(0, 200),
        status: "open",
        createdAt: now().toISOString(),
        sessionId,
      };
      await db.run(
        "INSERT INTO microgoals (id, content, status, created_at, session_id) VALUES (?, ?, 'open', ?, ?)",
        [goal.id, goal.content, goal.createdAt, goal.sessionId],
      );
      return goal;
    },
    async listOpenMicrogoals() {
      const rows = await db.all("SELECT * FROM microgoals WHERE status = 'open' ORDER BY created_at ASC");
      return rows.map(mapGoal);
    },
    async completeMicrogoal(query) {
      const goals = await this.listOpenMicrogoals();
      if (!goals.length) return null;
      const normalized = normalize(query);
      const target =
        !normalized || FORGET_LATEST.test(normalized)
          ? goals[goals.length - 1]
          : goals
              .map((goal) => ({ goal, score: scoreFact(query, goal.content) }))
              .filter((item) => item.score > 0)
              .sort((a, b) => b.score - a.score)[0]?.goal;
      if (!target) return null;
      await db.run("UPDATE microgoals SET status = 'done' WHERE id = ?", [target.id]);
      return { ...target, status: "done" };
    },
    async getProactiveDay(localDate) {
      const row = await db.get("SELECT * FROM proactive_days WHERE local_date = ?", [localDate]);
      if (!row) {
        return { localDate, attempts: 0, declined: false, engaged: false, nextRetryAt: null };
      }
      return mapDay(row, localDate);
    },
    tryClaimProactive(input) {
      return lock(async () => {
        const existing = await db.get("SELECT * FROM proactive_days WHERE local_date = ?", [input.localDate]);
        const day = existing
          ? mapDay(existing, input.localDate)
          : { localDate: input.localDate, attempts: 0, declined: false, engaged: false, nextRetryAt: null };
        if (day.declined || day.engaged) return false;
        if (input.mode === "first" && day.attempts !== 0) return false;
        if (input.mode === "retry") {
          if (day.attempts !== 1 || !day.nextRetryAt || day.nextRetryAt > input.nowIso) return false;
        }
        const next = applyProactiveEvent(day, "attempt", new Date(input.nowIso));
        await db.run(
          `INSERT INTO proactive_days (local_date, attempts, declined, engaged, next_retry_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (local_date) DO UPDATE SET
             attempts = excluded.attempts,
             declined = excluded.declined,
             engaged = excluded.engaged,
             next_retry_at = excluded.next_retry_at`,
          [next.localDate, next.attempts, next.declined ? 1 : 0, next.engaged ? 1 : 0, next.nextRetryAt],
        );
        return true;
      });
    },
    undoProactiveClaim(localDate) {
      return lock(async () => {
        const existing = await db.get("SELECT * FROM proactive_days WHERE local_date = ?", [localDate]);
        if (!existing) return;
        const day = mapDay(existing, localDate);
        if (day.declined || day.engaged) return;
        const attempts = Math.max(0, day.attempts - 1);
        await db.run(
          `INSERT INTO proactive_days (local_date, attempts, declined, engaged, next_retry_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (local_date) DO UPDATE SET
             attempts = excluded.attempts,
             declined = excluded.declined,
             engaged = excluded.engaged,
             next_retry_at = excluded.next_retry_at`,
          [localDate, attempts, day.declined ? 1 : 0, day.engaged ? 1 : 0, null],
        );
      });
    },
    updateProactive(localDate, event, when) {
      return lock(async () => {
        const existing = await db.get("SELECT * FROM proactive_days WHERE local_date = ?", [localDate]);
        const day = existing
          ? mapDay(existing, localDate)
          : { localDate, attempts: 0, declined: false, engaged: false, nextRetryAt: null };
        const next = applyProactiveEvent(day, event, when);
        await db.run(
          `INSERT INTO proactive_days (local_date, attempts, declined, engaged, next_retry_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (local_date) DO UPDATE SET
             attempts = excluded.attempts,
             declined = excluded.declined,
             engaged = excluded.engaged,
             next_retry_at = excluded.next_retry_at`,
          [next.localDate, next.attempts, next.declined ? 1 : 0, next.engaged ? 1 : 0, next.nextRetryAt],
        );
        return next;
      });
    },
  };
}
