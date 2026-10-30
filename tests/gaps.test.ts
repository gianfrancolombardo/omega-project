import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultDeps } from "@/lib/http/deps";
import { resetStoreForTests } from "@/lib/db/index";
import { createMemoryStore } from "@/lib/db/memory-store";
import { migrate } from "@/lib/db/schema";
import { openSqliteMemory } from "@/lib/db/sqlite";
import { sqlParams, type Db, type SqlRow, type SqlValue } from "@/lib/db/sql";
import { scoreFact } from "@/lib/db/memory-store";
import { parseEnv } from "@/lib/env";
import { handleCreateSession, handleEndSession, handleProactive, parseTranscript } from "@/lib/http/session-api";
import { handleSafety, handleTool } from "@/lib/http/tools-api";
import { handleHealth, handlePublicProfile, handleSetupGet, handleSetupPost } from "@/lib/http/setup-api";
import { mintClientSecret } from "@/lib/openai/mint";
import { extractResponseText, fallbackSummary, parseSummaryJson, summarizeSession } from "@/lib/openai/summarize";
import { describeMemory, assembleInstructions } from "@/lib/prompt/assemble";
import { createLiveState, reduceLive, type LiveContext, type LiveState } from "@/lib/realtime/logic";
import { assessUtterance, safetyScript } from "@/lib/safety/assess";
import { CHECKIN_ITEMS, selectCheckinItem, spokenCheckin } from "@/lib/session/instruments";
import { chooseModule, planDay } from "@/lib/session/planner";
import { evaluateSilence } from "@/lib/session/policy";
import { proactiveDecision } from "@/lib/session/proactive";
import { accidentalLine, inviteLabel, listeningLabel, proactiveSilenceLine, silenceCloseLine } from "@/lib/copy";
import { isConsentNo, isConsentYes, isDecline, isGoodbye } from "@/lib/session/phrases";
import { metricsToCsv, toMetrics } from "@/lib/metrics/csv";
import { clip, countWords, uniqueStrings } from "@/lib/text";
import { zonedParts } from "@/lib/time";
import { dispatchAlert } from "@/lib/notify";
import { EMPTY_USAGE, type Profile, type SessionRecord } from "@/lib/domain";
import { depsFor, memoryDb, pinHeaders } from "./helpers";

const ctx: LiveContext = { addressForm: "vos", initiator: "user", closeAfterMs: 75_000 };
const mintInput = {
  apiKey: "sk-test-secret",
  model: "gpt-realtime-2.1-mini",
  voice: "marin",
  speed: 0.92,
  transcriptionModel: "gpt-4o-mini-transcribe",
  noiseReduction: "far_field" as const,
  instructions: "hola",
};

function okSecret(): Response {
  return new Response(JSON.stringify({ value: "ek_test" }), { status: 200 });
}

function summaryResponse(concern: unknown): Response {
  return new Response(
    JSON.stringify({
      output_text: JSON.stringify({
        summary: "Elena dijo que le gusta el tango.",
        open_threads: ["el tango", 1, ""],
        facts: [
          { category: "gusto", content: "Le gusta el tango de Troilo" },
          { category: "gusto", content: " " },
          { category: "nope", content: "nada" },
          null,
        ],
        concern,
      }),
    }),
    { status: 200 },
  );
}

function fetchRoutes(concern: unknown = null): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes("client_secrets")) return okSecret();
    if (url.includes("/responses")) return summaryResponse(concern);
    if (url.includes("example.test")) return new Response("ok", { status: 200 });
    return new Response("no", { status: 500 });
  };
}

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    displayName: "Elena",
    addressForm: "vos",
    timezone: "America/Montevideo",
    dailyTime: "11:00",
    proactiveEnabled: true,
    tastes: "tango",
    lifeNotes: "Creció en el Cerro",
    avoidTopics: "",
    importantPeople: "Su hija Lucía.",
    emergencyName: "Lucía",
    emergencyPhone: "099",
    emergencyRelation: "hija",
    reducedHearing: false,
    subtitles: true,
    userConsentAt: "2026-10-01T00:00:00.000Z",
    memoryDeclinedAt: null,
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  };
}

describe("session edges", () => {
  it("limits mints, slows speech for hearing, and undoes a failed proactive claim", async () => {
    const { store, close } = await memoryDb();
    await store.updateProfile({ displayName: "Elena", reducedHearing: true, emergencyName: "Lucía" });
    let speed = 0;
    const deps = depsFor(store, {}, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { session: { audio: { output: { speed: number } } } };
      speed = body.session.audio.output.speed;
      return okSecret();
    });
    const created = await handleCreateSession(deps, pinHeaders(), { initiator: "user" });
    expect(created.status).toBe(200);
    expect(speed).toBe(0.86);
    const token = (created.body as { sessionToken: string }).sessionToken;
    expect((await handleCreateSession(deps, pinHeaders(), {})).status).toBe(409);
    await handleEndSession(deps, pinHeaders(), { sessionToken: token, outcome: "error", transcript: [] });

    await store.tryClaimProactive({ localDate: "2026-10-29", mode: "first", nowIso: "2026-10-29T14:00:00.000Z" });
    const originalDay = store.getProactiveDay.bind(store);
    store.getProactiveDay = async (date) => ({
      ...(await originalDay(date)),
      attempts: 0,
      nextRetryAt: null,
      declined: false,
      engaged: false,
    });
    const raced = await handleCreateSession(deps, pinHeaders(), { initiator: "proactive" });
    expect(raced.status).toBe(409);
    expect(JSON.stringify(raced.body)).toContain("ya arrancó");

    const missed = await handleCreateSession(
      depsFor(store, {}, fetchRoutes(), () => new Date("2026-10-29T18:00:00.000Z")),
      pinHeaders(),
      { initiator: "proactive" },
    );
    expect(missed.status).toBe(409);

    const undone = await handleCreateSession(
      depsFor(store, {}, async () => new Response("down", { status: 500 }), () => new Date("2026-10-31T14:00:00.000Z")),
      pinHeaders(),
      { initiator: "proactive" },
    );
    expect(undone.status).toBe(502);
    expect((await originalDay("2026-10-31")).attempts).toBe(0);
    const broken = await store.listSessions(5);
    expect(broken.some((session) => session.summary.includes("voz"))).toBe(true);

    const limited = depsFor(store, {}, fetchRoutes());
    limited.takeMint = () => ({ ok: false });
    expect((await handleCreateSession(limited, pinHeaders(), {})).status).toBe(429);
    expect(token.length).toBeGreaterThan(10);
    close();
  });

  it("syncs the daily claim from each ending and alerts only when the scanner agrees", async () => {
    const { store, close } = await memoryDb();
    await store.recordConsent("2026-10-01T00:00:00.000Z", true);
    await store.updateProfile({ displayName: "Elena", emergencyName: "Lucía", emergencyPhone: "", emergencyRelation: "" });
    const concern = { level: 3, reason: "dijo que se quiere morir", excerpt: "me quiero morir" };
    const deps = depsFor(store, { notifyWebhookUrl: "https://example.test/hook" }, fetchRoutes(concern));

    const proactive = await handleCreateSession(deps, pinHeaders(), { initiator: "proactive" });
    const proactiveToken = (proactive.body as { sessionToken: string }).sessionToken;
    const silent = await handleEndSession(deps, pinHeaders(), {
      sessionToken: proactiveToken,
      outcome: "no_response",
      transcript: [{ role: "assistant", text: "Hola", at: "t" }],
      usageEvents: [null, "x", { input_tokens: 1 }],
    });
    expect(silent.status).toBe(200);
    expect((await store.getProactiveDay("2026-10-29")).nextRetryAt).toBeTruthy();
    const again = await handleCreateSession(deps, pinHeaders(), { initiator: "user" });
    const againToken = (again.body as { sessionToken: string }).sessionToken;
    await handleEndSession(deps, pinHeaders(), { sessionToken: againToken, outcome: "no_response", transcript: [] });
    expect((await store.getProactiveDay("2026-10-29")).nextRetryAt).toBeTruthy();

    const accidental = await handleCreateSession(deps, pinHeaders(), { initiator: "proactive" });
    expect(accidental.status).toBe(409);

    const user = await handleCreateSession(
      depsFor(store, { notifyWebhookUrl: "https://example.test/hook" }, fetchRoutes(concern), () => new Date("2026-10-30T16:00:00.000Z")),
      pinHeaders(),
      {},
    );
    const userToken = (user.body as { sessionToken: string }).sessionToken;
    const ended = await handleEndSession(
      depsFor(store, { notifyWebhookUrl: "https://example.test/hook" }, fetchRoutes(concern), () => new Date("2026-10-30T16:10:00.000Z")),
      pinHeaders(),
      {
        sessionToken: userToken,
        outcome: "completed",
        transcript: [{ role: "user", text: "Me quiero morir", at: "2026-10-30T16:05:00.000Z" }],
      },
    );
    expect(ended.body).toMatchObject({ summarySource: "model" });
    expect((await store.listFacts()).some((fact) => fact.content.includes("Troilo"))).toBe(true);
    expect((await store.listAlerts(5)).some((alert) => alert.kind === "suicide")).toBe(true);

    await store.recordConsent("2026-10-30T16:00:00.000Z", false);
    const hidden = await handleCreateSession(
      depsFor(store, {}, fetchRoutes(concern), () => new Date("2026-10-30T18:00:00.000Z")),
      pinHeaders(),
      {},
    );
    const hiddenToken = (hidden.body as { sessionToken: string }).sessionToken;
    const before = (await store.listFacts()).length;
    await handleEndSession(
      depsFor(store, {}, fetchRoutes(concern), () => new Date("2026-10-30T18:10:00.000Z")),
      pinHeaders(),
      {
        sessionToken: hiddenToken,
        outcome: "weird",
        userSpoke: true,
        transcript: [{ role: "user", text: "Me gusta el río", at: "t" }],
      },
    );
    expect((await store.listFacts()).length).toBe(before);

    const calls = { n: 0 };
    const watched = depsFor(store, {}, async (input) => {
      if (String(input).includes("/responses")) calls.n += 1;
      return okSecret();
    });
    const skipped = await handleCreateSession(watched, pinHeaders(), {});
    const skippedToken = (skipped.body as { sessionToken: string }).sessionToken;
    await handleEndSession(watched, pinHeaders(), { sessionToken: skippedToken, outcome: "accidental", transcript: [{ role: "user", text: "ups", at: "t" }] });
    await handleEndSession(watched, pinHeaders(), { sessionToken: "missing" });
    expect(calls.n).toBe(0);
    expect((await handleEndSession(watched, pinHeaders(), { sessionToken: skippedToken, outcome: "error" })).body).toMatchObject({
      alreadyEnded: true,
    });

    const turns = parseTranscript([
      null,
      { role: "user", text: "  hola  " },
      { role: "user", text: "   " },
      { role: "assistant", text: 4 },
      { role: "user", text: "ok", at: "   " },
      { role: "user", text: "x".repeat(5000), at: "t".repeat(80) },
      ...Array.from({ length: 10 }, () => ({ role: "user", text: "más" })),
    ]);
    expect(turns[0].text).toBe("hola");
    expect(turns.some((turn) => turn.text.length === 4000)).toBe(true);
    expect(parseTranscript({ role: "user" })).toEqual([]);

    const day = await store.getProactiveDay("2026-10-29");
    expect(day.engaged).toBe(true);
    close();
  });

  it("marks a declined day and an accidental proactive retry without double booking", async () => {
    const { store, close } = await memoryDb();
    const deps = depsFor(store, {}, fetchRoutes());
    const first = await handleCreateSession(deps, pinHeaders(), { initiator: "proactive" });
    const token = (first.body as { sessionToken: string }).sessionToken;
    await handleEndSession(deps, pinHeaders(), { sessionToken: token, outcome: "declined", userSpoke: false, transcript: [] });
    expect((await store.getProactiveDay("2026-10-29")).declined).toBe(true);
    let updates = 0;
    const original = store.updateProactive.bind(store);
    store.updateProactive = async (date, event, when) => {
      updates += 1;
      return original(date, event, when);
    };
    const second = await handleCreateSession(deps, pinHeaders(), { initiator: "user" });
    const secondToken = (second.body as { sessionToken: string }).sessionToken;
    await handleEndSession(deps, pinHeaders(), { sessionToken: secondToken, outcome: "declined", transcript: [] });
    expect(updates).toBe(0);

    const { store: other, close: closeOther } = await memoryDb();
    const otherDeps = depsFor(other, {}, fetchRoutes());
    const started = await handleCreateSession(otherDeps, pinHeaders(), { initiator: "proactive" });
    await handleEndSession(otherDeps, pinHeaders(), {
      sessionToken: (started.body as { sessionToken: string }).sessionToken,
      outcome: "accidental",
      transcript: [],
    });
    expect((await other.getProactiveDay("2026-10-29")).nextRetryAt).toBeTruthy();
    const spoken = await handleCreateSession(otherDeps, pinHeaders(), { initiator: "user" });
    await handleEndSession(otherDeps, pinHeaders(), {
      sessionToken: (spoken.body as { sessionToken: string }).sessionToken,
      outcome: "accidental",
      userSpoke: true,
      transcript: [],
    });
    expect((await other.getProactiveDay("2026-10-29")).engaged).toBe(true);
    expect((await handleProactive(otherDeps, new Headers())).status).toBe(401);
    close();
    closeOther();
  });
});

describe("tool and setup edges", () => {
  it("rejects bad tools, forgets a miss, and flags two low days once", async () => {
    const db = openSqliteMemory();
    await migrate(db, "2026-10-20T15:00:00.000Z", "America/Montevideo");
    let clock = new Date("2026-10-20T15:00:00.000Z");
    const store = createMemoryStore(db, { now: () => clock });
    const deps = depsFor(store, { notifyWebhookUrl: null }, fetchRoutes(), () => clock);
    await store.updateProfile({ displayName: "Elena", emergencyName: "Lucía" });
    await store.recordConsent("2026-10-01T00:00:00.000Z", true);
    const created = await handleCreateSession(deps, pinHeaders(), {});
    const token = (created.body as { sessionToken: string }).sessionToken;
    const call = (name: string, args: unknown) => handleTool(deps, pinHeaders(), { sessionToken: token, name, arguments: args });

    expect(JSON.stringify((await call("remember_fact", "{")).body)).toContain("categoría");
    expect(JSON.stringify((await call("remember_fact", { category: "gusto", content: "Toma una pastilla" })).body)).toContain("medicación");
    await call("remember_fact", { category: "gusto", content: "Le gusta el mate" });
    expect(JSON.stringify((await call("remember_fact", { category: "gusto", content: "Le gusta el mate" })).body)).toContain("ya estaba");
    expect(JSON.stringify((await call("recall_facts", { query: "playa" })).body)).toContain("No hay");
    expect(JSON.stringify((await call("forget_fact", { query: "playa" })).body)).toContain("No encontré");
    expect((await call("log_mood", { instrument: "nope", raw_answer: "bien" })).body).toMatchObject({ hangup: null });
    expect(JSON.stringify((await call("log_mood", { instrument: "who5", raw_answer: "  " })).body)).toContain("falta la respuesta");
    expect(JSON.stringify((await call("save_microgoal", { content: "x" })).body)).toContain("corta");
    expect(JSON.stringify((await call("complete_microgoal", { query: "nada" })).body)).toContain("No encontré");
    expect(JSON.stringify((await call("record_consent", { accepted: true })).body)).toContain("Permiso");

    await call("log_mood", { instrument: "phq2", item_id: "phq_down", raw_answer: "bajo", score: 9 });
    clock = new Date("2026-10-28T15:00:00.000Z");
    const flagged = await call("log_mood", { instrument: "phq2", item_id: "phq_interest", raw_answer: "casi nada", score: 2 });
    expect(JSON.stringify(flagged.body)).toContain("Señal");
    expect((await store.listAlerts(5)).some((alert) => alert.kind === "distress")).toBe(true);
    clock = new Date("2026-10-29T15:00:00.000Z");
    await call("log_mood", { instrument: "phq2", item_id: "phq_down", raw_answer: "bajo otra vez", score: 3 });
    expect(await store.listAlerts(10)).toHaveLength(1);

    const benign = await call("flag_concern", { level: 3, reason: "ruido", excerpt: "el día está lindo" });
    expect(JSON.stringify(benign.body)).toContain("911");
    expect(JSON.stringify(benign.body)).not.toContain("0800");
    const repeated = await call("flag_concern", { level: 2, reason: "ruido", excerpt: "el día está lindo" });
    expect(JSON.stringify(repeated.body)).toContain("ya estaba");
    const distress = await call("flag_concern", { level: 2, reason: "ánimo", excerpt: "hace días que no duermo" });
    expect(JSON.stringify(distress.body)).toContain("médico");

    expect((await handleTool(deps, pinHeaders(), { sessionToken: token })).status).toBe(400);
    expect((await handleSafety(deps, pinHeaders(), { sessionToken: token, text: "Hace días que no como" })).body).toMatchObject({
      level: 2,
      interrupt: false,
    });
    await handleEndSession(deps, pinHeaders(), { sessionToken: token, outcome: "error", transcript: [{ role: "user", text: "chau", at: "t" }] });
    expect((await handleSafety(deps, pinHeaders(), { sessionToken: token, text: "me quiero morir" })).status).toBe(401);
    expect((await handleSafety(deps, pinHeaders(), { text: "hola" })).status).toBe(400);
    expect((await call("end_session", {})).status).toBe(401);

    expect((await handleSetupPost(deps, pinHeaders(), { action: "inventar" })).status).toBe(400);
    expect((await handleSetupPost(deps, pinHeaders(), { action: "delete_fact" })).status).toBe(400);
    expect((await handleSetupPost(deps, pinHeaders(), null)).status).toBe(400);
    const warned = await handleSetupGet(depsFor(store, { ephemeral: true }, fetchRoutes(), () => clock), pinHeaders());
    expect(JSON.stringify(warned.body)).toContain("DATABASE_URL");
    expect((await handlePublicProfile(deps, new Headers())).status).toBe(401);
    expect((await handleHealth(depsFor(store, { openAiApiKey: null, setupPin: null }))).body).toMatchObject({ openai: false, pin: false });
    db.close();
  });
});

describe("mint, summary and prompt edges", () => {
  it("rejects a secret that is not ephemeral", async () => {
    const bad = await mintClientSecret(mintInput, async () => new Response(JSON.stringify({ value: "sk-test-secret" }), { status: 200 }));
    expect(bad.ok).toBe(false);
    const empty = await mintClientSecret(mintInput, async () => new Response(JSON.stringify({ expires_at: 1 }), { status: 200 }));
    expect(empty.ok).toBe(false);
    const nested = await mintClientSecret(mintInput, async () => new Response(JSON.stringify({ client_secret: { value: 1 } }), { status: 200 }));
    expect(nested.ok).toBe(false);
    const thrown = await mintClientSecret(mintInput, async () => {
      throw "down";
    });
    expect(thrown.ok).toBe(false);
    if (!thrown.ok) expect(thrown.code).toBe("openai_unreachable");
  });

  it("ignores a broken summary and a concern the scanner does not share", async () => {
    expect(parseSummaryJson("{oops}")).toBeNull();
    expect(parseSummaryJson('{"summary":"","open_threads":[],"facts":[]}')).toBeNull();
    expect(parseSummaryJson('{"summary":"Hola","facts":"no","concern":{"level":1,"reason":"x","excerpt":"y"}}')?.concern).toBeNull();
    expect(extractResponseText({ output: "no" })).toBe("");
    expect(extractResponseText({ output: [null, { content: "x" }, { content: [{ text: 1 }, { nope: true }] }] })).toBe("");
    expect(fallbackSummary([{ role: "assistant", text: "Hola", at: "t" }]).summary).toContain("no dejó");
    const failed = await summarizeSession({
      apiKey: "sk-test",
      model: "gpt-5.4-mini",
      turns: [{ role: "user", text: "Hola", at: "t" }],
      fetchImpl: async () => new Response("no", { status: 500 }),
    });
    expect(failed.source).toBe("fallback");
    const malformed = await summarizeSession({
      apiKey: "sk-test",
      model: "gpt-5.4-mini",
      turns: [{ role: "user", text: "Hola", at: "t" }],
      fetchImpl: async () => new Response(JSON.stringify({ output_text: "{oops" }), { status: 200 }),
    });
    expect(malformed.source).toBe("fallback");
    expect(malformed.facts).toEqual([]);
  });

  it("caps the instructions and speaks in usted when that is the trato", () => {
    const empty = describeMemory(profile({ displayName: "", importantPeople: "", tastes: "", addressForm: "usted" }), []);
    expect(empty).toContain("usted");
    const full = describeMemory(
      profile({ addressForm: "usted", importantPeople: "p".repeat(400), tastes: "t".repeat(400) }),
      Array.from({ length: 6 }, (_, index) => ({
        id: String(index),
        category: "historia" as const,
        content: `Historia ${index} ${"larga ".repeat(40)}`,
        createdAt: "t",
        sourceSessionId: null,
        source: "summary" as const,
      })),
    );
    expect(full).toContain("dígame");
    const huge = assembleInstructions({
      profile: profile({
        displayName: "",
        addressForm: "usted",
        tastes: "m".repeat(3000),
        lifeNotes: "n".repeat(3000),
        avoidTopics: "evitar el hospital",
        memoryDeclinedAt: null,
      }),
      facts: Array.from({ length: 80 }, (_, index) => ({
        id: String(index),
        category: "historia" as const,
        content: `Hecho ${index} ${"palabra ".repeat(40)}`,
        createdAt: "t",
        sourceSessionId: null,
        source: "tool" as const,
      })),
      summaries: Array.from({ length: 3 }, (_, index) => ({
        startedAt: `2026-10-2${index}T14:00:00.000Z`,
        module: "charla",
        summary: "s".repeat(2000),
        openThreads: ["la rambla", "La Rambla"],
      })),
      microgoals: [],
      plan: {
        module: "opinion",
        reason: "hoy",
        theme: "la plaza",
        checkin: CHECKIN_ITEMS[0],
        checkinLine: "Una pregunta de ánimo, con cuidado.",
      },
      dateLabel: "jueves",
      maxFacts: 80,
    });
    expect(huge.instructions.length).toBe(12_000);
    expect(huge.instructions).toContain("pregunta de ánimo");
    expect(huge.greetingCue).toContain("usted");
    expect(listeningLabel("vos")).toContain("Te escucho");
    expect(inviteLabel("usted", "Elena")).toContain("Elena");
    expect(inviteLabel("vos", "")).toContain("Buen día");
    expect(accidentalLine("usted")).toContain("necesita");
    expect(silenceCloseLine("usted")).toContain("quiere");
    expect(proactiveSilenceLine("vos")).toContain("quieras");
  });
});

describe("planner and safety phrases", () => {
  it("rotates modules and asks the oldest due item", () => {
    const today = "2026-10-29";
    const yesterday = "2026-10-28";
    const base = {
      today,
      tastes: "ajedrez",
      sessionCount: 3,
      history: [] as { instrument: string; itemId: string; createdAt: string }[],
      now: new Date("2026-10-29T14:00:00.000Z"),
      addressForm: "vos" as const,
      consented: true,
    };
    expect(planDay({ ...base, recent: [], sessionCount: 0 }).theme).toContain("gusto");
    expect(
      planDay({
        ...base,
        recent: [
          { module: "charla", localDate: today },
          { module: "mi_historia", localDate: yesterday },
        ],
      }).theme,
    ).toContain("atardecer");
    const history = planDay({
      ...base,
      recent: [
        { module: "charla", localDate: today },
        { module: "curiosidad", localDate: today },
        { module: "opinion", localDate: today },
        { module: "mi_historia", localDate: yesterday },
      ],
    });
    expect(history.module).toBe("mi_historia");
    expect(history.theme.length).toBeGreaterThan(8);
    expect(
      planDay({
        ...base,
        recent: [
          { module: "charla", localDate: today },
          { module: "mi_historia", localDate: today },
          { module: "curiosidad", localDate: yesterday },
        ],
        addressForm: "usted",
      }).module,
    ).toBe("opinion");
    expect(chooseModule("no-es-fecha", [{ module: "juego", localDate: "ayer" }]).module).toBe("charla");
    expect(planDay({ ...base, recent: [], consented: true, sessionCount: 2 }).checkinLine).toContain("log_mood");

    const ucla = CHECKIN_ITEMS.filter((item) => item.instrument === "ucla3");
    const picked = selectCheckinItem({
      sessionCount: 4,
      now: new Date("2026-10-29T00:00:00.000Z"),
      history: [
        ...ucla.map((item, index) => ({ instrument: "ucla3", itemId: item.itemId, createdAt: `2026-10-0${index + 1}T00:00:00.000Z` })),
        ...CHECKIN_ITEMS.filter((item) => item.instrument !== "ucla3").map((item) => ({
          instrument: item.instrument,
          itemId: item.itemId,
          createdAt: "2026-10-28T00:00:00.000Z",
        })),
        { instrument: "daily", itemId: "animo", createdAt: "2026-10-01T00:00:00.000Z" },
        { instrument: "ucla3", itemId: "ucla_company", createdAt: "2026-09-01T00:00:00.000Z" },
      ],
    });
    expect(picked?.itemId).toBe("ucla_company");
    expect(
      selectCheckinItem({
        sessionCount: 2,
        now: new Date("2026-10-29T00:00:00.000Z"),
        history: [
          { instrument: "ucla3", itemId: "ucla_company", createdAt: "not-a-date" },
          ...CHECKIN_ITEMS.filter((item) => item.instrument !== "ucla3").map((item) => ({
            instrument: item.instrument,
            itemId: item.itemId,
            createdAt: "2026-10-28T00:00:00.000Z",
          })),
        ],
      })?.itemId,
    ).toBe("ucla_left_out");
    expect(spokenCheckin(CHECKIN_ITEMS[0], "vos")).toContain("sentís");
    const idle = {
      phase: "listening" as const,
      now: 1_000,
      startedAt: 0,
      lastActivityAt: 1_000,
      userSpoke: true,
      agentSpoke: true,
      promptedStillThere: true,
      closing: false,
      initiator: "user" as const,
      closeAfterMs: 75_000,
    };
    expect(evaluateSilence(idle)).toBe("none");
    expect(evaluateSilence({ ...idle, phase: "connecting", now: 1_000, startedAt: 0 })).toBe("none");
    const now = new Date("2026-10-29T14:00:00.000Z");
    const empty = { localDate: "2026-10-29", attempts: 1, declined: false, engaged: false, nextRetryAt: null };
    expect(proactiveDecision({ now, timezone: "America/Montevideo", dailyTime: "11:00", enabled: true, day: empty, sessionActive: false }).start).toBe(false);
    expect(
      proactiveDecision({
        now,
        timezone: "America/Montevideo",
        dailyTime: "11:00",
        enabled: true,
        day: { ...empty, nextRetryAt: "2026-10-29T18:00:00.000Z" },
        sessionActive: false,
      }).start,
    ).toBe(false);
  });

  it("names each physical emergency and ignores the figurative ones", () => {
    for (const line of [
      "Me duele mucho el pecho",
      "El pecho me aprieta",
      "No puedo respirar",
      "Me falta el aire",
      "Me estoy ahogando",
      "No me entra el aire",
      "Creo que es un infarto",
      "Me caí de la cama",
      "Estoy en el piso y no me puedo levantar",
      "Me caí y no puedo levantarme",
      "No me puedo levantar",
      "Me están pegando",
      "Alguien me pega",
      "Me maltrata",
      "Me muero de risa y me duele el pecho",
    ]) {
      expect(assessUtterance(line).kind, line).toBe("emergency");
    }
    expect(assessUtterance("No me puedo levantar temprano").level).toBe(0);
    expect(assessUtterance("Me caí en la cuenta").level).toBe(0);
    expect(assessUtterance("Estoy matando el tiempo").level).toBe(0);
    expect(assessUtterance("Me duele la cadera").level).toBe(0);
    expect(safetyScript("emergency", "usted")).toContain("Llame ahora al 911");
    expect(safetyScript("distress", "vos")).toContain("médico");
    expect(isDecline("después")).toBe(true);
    expect(isDecline("más tarde")).toBe(true);
    expect(isDecline("hoy no")).toBe(true);
    expect(isDecline("no gracias")).toBe(true);
    expect(isDecline("dejame en paz")).toBe(true);
    expect(isDecline("no quiero charlar")).toBe(true);
    expect(isDecline("para un poco")).toBe(true);
    expect(isGoodbye("adiós")).toBe(true);
    expect(isGoodbye("hasta luego")).toBe(true);
    expect(isGoodbye("basta por hoy")).toBe(true);
    expect(isGoodbye("corto acá")).toBe(true);
    expect(isConsentYes("sí, gracias")).toBe(true);
    expect(isConsentYes("ok")).toBe(true);
    expect(isConsentYes("x".repeat(41))).toBe(false);
    expect(isConsentNo("prefiero que no")).toBe(true);
    expect(isConsentNo("no guardes nada")).toBe(true);
    expect(isDecline("???")).toBe(false);
  });
});

describe("reducer leftovers", () => {
  function server(state: LiveState, type: string, extra: Record<string, unknown> = {}, now = 1_000) {
    return reduceLive(state, { type: "server", event: { type, ...extra }, now }, ctx);
  }

  it("ends a closing turn, ignores unknown events and nudges the dose", () => {
    const idle = createLiveState(0);
    expect(server(idle, "session.created").effects).toEqual([]);
    expect(server(idle, "response.done", { response: {} }).state.usageEvents).toEqual([]);
    expect(server(idle, "response.done", {}).state.usageEvents).toEqual([]);
    const closing = { ...idle, closing: "completed" as const, playback: false, phase: "listening" as const };
    expect(server(closing, "response.done", { response: { usage: { input_tokens: 2 } } }).effects[0]).toMatchObject({ type: "end" });
    const stillPlaying = server({ ...closing, playback: true, phase: "speaking" }, "response.done", { response: { usage: { input_tokens: 2 } } });
    expect(stillPlaying.effects).toEqual([]);
    expect(stillPlaying.state.usageEvents).toHaveLength(1);

    const waiting = { ...idle, closing: "completed" as const, phase: "listening" as const, closeMarkedAt: 0 };
    expect(reduceLive(waiting, { type: "tick", now: 1_000 }, ctx).effects).toEqual([]);
    expect(reduceLive({ ...waiting, phase: "speaking" }, { type: "tick", now: 12_000 }, ctx).effects).toEqual([]);
    expect(reduceLive(waiting, { type: "tick", now: 12_000 }, ctx).effects[0]).toMatchObject({ type: "end", outcome: "completed" });
    expect(reduceLive({ ...idle, emergency: true, phase: "listening" }, { type: "tick", now: 99_000 }, ctx).effects).toEqual([]);

    const listening = { ...idle, phase: "listening" as const, userSpoke: true, agentSpoke: true, lastActivityAt: 15 * 60_000, startedAt: 0 };
    expect(reduceLive(listening, { type: "tick", now: 15 * 60_000 }, ctx).state.dose15).toBe(true);
    const firm = reduceLive({ ...listening, dose15: true, lastActivityAt: 20 * 60_000 }, { type: "tick", now: 20 * 60_000 }, ctx);
    expect(firm.state.dose20).toBe(true);
    expect(reduceLive({ ...firm.state, phase: "listening", lastActivityAt: 20 * 60_000 }, { type: "tick", now: 20 * 60_000 }, ctx).effects).toEqual([]);
    expect(reduceLive({ ...idle, phase: "thinking" }, { type: "tick", now: 30_000 }, ctx).effects[0]).toMatchObject({ type: "end", outcome: "error" });

    const started = server(idle, "input_audio_buffer.speech_started", {}, 10);
    expect(started.state.userSpoke).toBe(true);
    expect(server(started.state, "input_audio_buffer.speech_stopped").state.phase).toBe("thinking");
    expect(server(idle, "response.output_audio.delta").state.phase).toBe("speaking");
    expect(server({ ...idle, playback: false }, "response.output_audio.done").state.phase).toBe("listening");
    expect(server({ ...idle, playback: true, phase: "speaking" }, "response.output_audio.done").state.phase).toBe("speaking");
    expect(server(idle, "output_audio_buffer.stopped").state.phase).toBe("listening");

    const duplicate = server(idle, "response.function_call_arguments.done", { name: "end_session", call_id: "a", arguments: { reason: "chau" } });
    expect(server(duplicate.state, "response.function_call_arguments.done", { name: "end_session", call_id: "a" }).effects).toEqual([]);
    expect(server(idle, "response.function_call_arguments.done", { name: "", call_id: "b" }).effects).toEqual([]);
    const low = server(idle, "conversation.item.input_audio_transcription.completed", { transcript: "Hace días que no duermo" });
    expect(low.effects[0]).toMatchObject({ type: "safety", level: 2, interrupt: false });
    expect(low.state.emergency).toBe(false);
    const crisis = server(idle, "conversation.item.input_audio_transcription.completed", { transcript: "Me quiero morir" });
    const second = server(crisis.state, "conversation.item.input_audio_transcription.completed", { transcript: "Me quiero morir" }, 2_000);
    expect(second.effects.some((effect) => effect.type === "send")).toBe(false);
    expect(server(idle, "conversation.item.input_audio_transcription.completed", { transcript: "   " }).state.userSpoke).toBe(true);
    const buffered = server(idle, "response.output_audio_transcript.delta", { delta: "Hola" });
    expect(server(buffered.state, "response.output_audio_transcript.done", {}).state.turns[0].text).toBe("Hola");
    expect(server(idle, "response.output_audio_transcript.done", { transcript: "  " }).state.turns).toEqual([]);
    expect(reduceLive({ ...idle, phase: "listening" }, { type: "connected", now: 5 }, ctx).state.phase).toBe("listening");
    const hung = reduceLive(duplicate.state, { type: "tool_result", callId: "a", output: "ok", hangup: "declined", now: 30 }, ctx);
    const again = reduceLive(hung.state, { type: "tool_result", callId: "missing", output: "x", hangup: "completed", now: 40 }, ctx);
    expect(again.state.closing).toBe("declined");
  });
});

describe("store leftovers", () => {
  it("scores facts, claims a retry and reads messy rows", async () => {
    expect(scoreFact("", "hola")).toBe(0);
    expect(scoreFact("ab", "hola")).toBe(0);
    expect(scoreFact("tango rio", "el tango de la casa")).toBe(1);
    expect(scoreFact("tango futbol playa", "solo tango")).toBe(0);
    expect(scoreFact("rambla de pocitos", "pocitos")).toBeGreaterThan(10);
    expect(sqlParams([{ a: 1 }, Number.POSITIVE_INFINITY, false])).toEqual(["[object Object]", null, 0]);
    expect(countWords("...")).toBe(0);
    expect(uniqueStrings(["uno", "dos", "tres"], 1)).toEqual(["uno"]);
    expect(clip("hola", 10)).toBe("hola");
    expect(parseEnv({ OPENAI_VOICE_SPEED: "nope", SILENCE_CLOSE_SECONDS: "nope", OPENAI_API_KEY: "  " }).openAiApiKey).toBeNull();
    expect(parseEnv({ OPENAI_VOICE_SPEED: "  " }).voiceSpeed).toBe(0.92);

    const { store, close } = await memoryDb();
    await store.updateProfile({});
    await store.updateProfile({
      displayName: "Elena",
      addressForm: "usted",
      timezone: "America/Montevideo",
      dailyTime: "09:30",
      proactiveEnabled: false,
      tastes: "mate",
      lifeNotes: "Cerro",
      avoidTopics: "hospital",
      importantPeople: "Lucía",
      emergencyName: "Lucía",
      emergencyPhone: "099",
      emergencyRelation: "hija",
      reducedHearing: true,
      subtitles: false,
    });
    expect((await store.addFact({ category: "nope" as "gusto", content: "hola" })).ok).toBe(false);
    await store.addFact({ category: "gusto", content: "Le gusta el tango uno" });
    await store.addFact({ category: "gusto", content: "Le gusta el tango dos" });
    expect((await store.searchFacts("tango", 2)).length).toBe(2);
    expect(await store.forgetFact("")).toBeTruthy();
    expect(await store.forgetFact("esto")).toBeTruthy();
    expect(await store.forgetFact("ultimo")).toBeNull();
    const created = await store.createSession({ initiator: "user", module: "charla", model: "m", voice: "marin" });
    expect(await store.updateSession(created.session.id, {})).toMatchObject({ status: "active" });
    await expect(store.updateSession("missing", { status: "error" })).rejects.toThrow(/disappeared/);
    await store.updateSession(created.session.id, {
      misunderstoodCount: 1,
      elderspeakHits: 1,
      costApproximate: true,
      summarySource: "model",
      openThreads: ["uno"],
      agentWords: 3,
      userWords: 2,
    });
    expect(await store.completeMicrogoal("ultimo")).toBeNull();
    await store.addMicrogoal("Llamar a Lucía", created.session.id);
    await store.addMicrogoal("Regar la planta", null);
    expect((await store.completeMicrogoal(""))?.content).toContain("planta");
    expect(await store.tryClaimProactive({ localDate: "2026-10-29", mode: "retry", nowIso: "2026-10-29T14:00:00.000Z" })).toBe(false);
    expect(await store.tryClaimProactive({ localDate: "2026-10-29", mode: "first", nowIso: "2026-10-29T14:00:00.000Z" })).toBe(true);
    expect(await store.tryClaimProactive({ localDate: "2026-10-29", mode: "retry", nowIso: "2026-10-29T14:00:00.000Z" })).toBe(false);
    await store.updateProactive("2026-10-29", "no_response", new Date("2026-10-29T14:00:00.000Z"));
    expect(await store.tryClaimProactive({ localDate: "2026-10-29", mode: "retry", nowIso: "2026-10-29T14:10:00.000Z" })).toBe(false);
    expect(await store.tryClaimProactive({ localDate: "2026-10-29", mode: "retry", nowIso: "2026-10-29T14:40:00.000Z" })).toBe(true);
    await store.updateProactive("2026-10-29", "decline", new Date("2026-10-29T15:00:00.000Z"));
    await store.undoProactiveClaim("2026-10-29");
    expect((await store.getProactiveDay("2026-10-29")).declined).toBe(true);
    await store.updateProactive("2026-11-01", "engage", new Date("2026-11-01T14:00:00.000Z"));
    await store.undoProactiveClaim("2026-11-01");
    expect((await store.getProactiveDay("2026-11-01")).engaged).toBe(true);

    const inner = openSqliteMemory();
    await migrate(inner, "2026-10-29T14:00:00.000Z", "America/Montevideo");
    const real = createMemoryStore(inner, { now: () => new Date("2026-10-29T14:00:00.000Z") });
    const session = await real.createSession({ initiator: "user", module: "charla", model: "m", voice: "marin" });
    await real.addFact({ category: "lugar", content: "La rambla" });
    await real.addMood({ sessionId: session.session.id, instrument: "who5", itemId: "who_calm", rawAnswer: "bien", score: 4, note: "" });
    await real.addAlert({
      sessionId: session.session.id,
      level: 2,
      kind: "distress",
      reason: "ánimo",
      excerpt: "bajo",
      notifyStatus: "failed",
      notifyDetail: "no",
    });
    await real.addMicrogoal("Caminar", session.session.id);
    await real.updateProactive("2026-10-29", "attempt", new Date("2026-10-29T14:00:00.000Z"));
    const view = createMemoryStore(messy(inner), { now: () => new Date("2026-10-29T14:00:00.000Z") });
    expect((await view.getProfile()).addressForm).toBe("vos");
    expect((await view.listFacts())[0].category).toBe("otro");
    expect((await view.getSessionByToken(session.token))?.status).toBe("error");
    expect((await view.listSessions(3))[0].summarySource).toBe("model");
    expect((await view.listMood(3))[0].instrument).toBe("daily");
    expect((await view.listAlerts(3)).some((alert) => alert.notifyStatus === "sent")).toBe(true);
    expect((await view.listOpenMicrogoals())[0].status).toBe("done");
    expect((await view.getProactiveDay("2026-10-29")).declined).toBe(true);
    inner.close();
    close();
  });

  it("keeps the claim queue alive after a database error", async () => {
    const inner = openSqliteMemory();
    await migrate(inner, "2026-10-29T14:00:00.000Z", "America/Montevideo");
    let fail = true;
    const db: Db = {
      exec: (sql) => inner.exec(sql),
      all: (sql, params) => inner.all(sql, params),
      run: (sql, params) => inner.run(sql, params),
      async get(sql, params) {
        if (fail && sql.includes("proactive_days")) {
          fail = false;
          throw new Error("boom");
        }
        return inner.get(sql, params);
      },
    };
    const store = createMemoryStore(db, { now: () => new Date("2026-10-29T14:00:00.000Z") });
    await expect(store.tryClaimProactive({ localDate: "2026-10-29", mode: "first", nowIso: "2026-10-29T14:00:00.000Z" })).rejects.toThrow("boom");
    expect(await store.tryClaimProactive({ localDate: "2026-10-29", mode: "first", nowIso: "2026-10-29T14:00:00.000Z" })).toBe(true);
    inner.close();
  });
});

describe("clock and process deps", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats hour 24 as midnight and exercises the default dependencies", async () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function MockDateTimeFormat() {
      return {
        formatToParts() {
          return [
            { type: "year", value: "2026" },
            { type: "month", value: "10" },
            { type: "day", value: "29" },
            { type: "hour", value: "24" },
            { type: "minute", value: "05" },
            { type: "second", value: "06" },
          ];
        },
      } as unknown as Intl.DateTimeFormat;
    });
    expect(zonedParts(new Date("2026-10-29T03:00:00.000Z"), "UTC").hour).toBe(0);
    vi.restoreAllMocks();

    const previous = process.env.SETUP_PIN;
    const previousDb = process.env.DATABASE_URL;
    const previousPath = process.env.CHARLA_DB_PATH;
    const file = path.join(os.tmpdir(), `charla-gap-${Date.now()}.sqlite`);
    delete process.env.DATABASE_URL;
    process.env.CHARLA_DB_PATH = file;
    process.env.SETUP_PIN = "1357";
    resetStoreForTests();
    const deps = await defaultDeps();
    expect(deps.now()).toBeInstanceOf(Date);
    expect(deps.authorize("0000").ok).toBe(false);
    for (let attempt = 0; attempt < 40; attempt += 1) deps.takeMint();
    expect(deps.takeMint().ok).toBe(false);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    const sent = await dispatchAlert({
      webhookUrl: "https://example.test/hook",
      level: 2,
      reason: "ánimo",
      excerpt: "bajo",
      elderName: "Elena",
      emergencyContact: "",
      at: "2026-10-29T14:00:00.000Z",
    });
    globalThis.fetch = originalFetch;
    expect(sent.status).toBe("sent");
    resetStoreForTests();
    if (previous === undefined) delete process.env.SETUP_PIN;
    else process.env.SETUP_PIN = previous;
    if (previousDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDb;
    if (previousPath === undefined) delete process.env.CHARLA_DB_PATH;
    else process.env.CHARLA_DB_PATH = previousPath;
    fs.rmSync(file, { force: true });
  });
});

function messy(inner: Db): Db {
  return {
    exec: (sql: string) => inner.exec(sql),
    run: (sql: string, params?: SqlValue[]) => inner.run(sql, params),
    async get(sql: string, params?: SqlValue[]): Promise<SqlRow | undefined> {
      const row = await inner.get(sql, params);
      if (!row) return row;
      if (sql.includes("profile")) {
        return { ...row, address_form: "raro", proactive_enabled: true, reduced_hearing: "1", subtitles: false, user_consent_at: "" };
      }
      if (sql.includes("sessions")) {
        return {
          ...row,
          status: "nope",
          initiator: "proactive",
          transcript_json: "{",
          open_threads_json: "[",
          usage_json: "{",
          summary_source: "otro",
          duration_seconds: "",
          cost_usd: "nope",
          cost_approximate: "1",
          user_words: "x",
          agent_words: true,
          misunderstood_count: Number.NaN,
        };
      }
      if (sql.includes("proactive_days")) {
        return { ...row, local_date: "", attempts: "3", declined: "1", engaged: true, next_retry_at: "" };
      }
      return row;
    },
    async all(sql: string, params?: SqlValue[]): Promise<SqlRow[]> {
      if (sql.includes("facts")) {
        return [{ id: "f", category: "nope", content: "x", created_at: "t", source_session_id: "", source: "imported" }];
      }
      if (sql.includes("mood_signals")) {
        return [
          { id: "m", session_id: "", instrument: "nope", item_id: "i", raw_answer: "a", score: "", note: null, created_at: "t" },
          { id: "m2", session_id: "s", instrument: "phq2", item_id: "i", raw_answer: "a", score: "no", note: "n", created_at: "t" },
        ];
      }
      if (sql.includes("alerts")) {
        return [
          { id: "a", session_id: null, level: 2, kind: "suicide", reason: "r", excerpt: "e", created_at: "t", notify_status: "failed", notify_detail: "d" },
          { id: "b", session_id: "s", level: "9", kind: "nope", reason: "r", excerpt: "e", created_at: "t", notify_status: "sent", notify_detail: "d" },
        ];
      }
      if (sql.includes("microgoals")) {
        return [{ id: "g", content: "x", status: "done", created_at: "t", session_id: "" }];
      }
      if (sql.includes("sessions")) {
        const rows = await inner.all<SqlRow>(sql, params as SqlValue[]);
        return rows.map((row) => ({ ...row, summary_source: "model", cost_approximate: 0, duration_seconds: 4, cost_usd: 1.2 }));
      }
      return inner.all(sql, params);
    },
  } as Db;
}

function quoteCsv(): string {
  const row: SessionRecord = {
    id: "1",
    startedAt: "t",
    endedAt: null,
    initiator: "user",
    module: "charla",
    status: "completed",
    transcript: [],
    summary: 'hola, "mundo"',
    openThreads: [],
    durationSeconds: null,
    userWords: 1,
    agentWords: 1,
    misunderstoodCount: 0,
    elderspeakHits: 0,
    usage: EMPTY_USAGE,
    costUsd: null,
    costApproximate: true,
    model: "m",
    voice: "marin",
    summarySource: null,
  };
  return metricsToCsv([toMetrics(row)]);
}

describe("csv quoting", () => {
  it("quotes commas and doubled quotes", () => {
    expect(quoteCsv()).toContain('"hola, ""mundo"""');
  });
});
