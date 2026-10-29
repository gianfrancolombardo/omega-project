import { describe, expect, it } from "vitest";

import { handleCreateSession, handleEndSession, handleProactive, parseTranscript } from "@/lib/http/session-api";
import { handleSafety, handleTool } from "@/lib/http/tools-api";
import { handleHealth, handlePublicProfile, handleSetupGet, handleSetupPost, handleSetupPut } from "@/lib/http/setup-api";
import { defaultDeps } from "@/lib/http/deps";
import { resetStoreForTests } from "@/lib/db/index";
import { depsFor, memoryDb, pinHeaders } from "./helpers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function fetchMock(): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes("client_secrets")) {
      return new Response(JSON.stringify({ value: "ek_test", expires_at: "2026-10-29T15:00:00.000Z" }), { status: 200 });
    }
    if (url.includes("/responses")) {
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            summary: "Elena dijo que le gusta el tango.",
            open_threads: ["el tango"],
            facts: [{ category: "gusto", content: "Le gusta el tango de Troilo" }],
            concern: null,
          }),
        }),
        { status: 200 },
      );
    }
    if (url.includes("example.test")) return new Response("ok", { status: 200 });
    return new Response("no", { status: 500 });
  };
}

describe("http handlers", () => {
  it("mints a secret, stores memory and ends the session", async () => {
    const { store, close } = await memoryDb();
    const deps = depsFor(store, {}, fetchMock());
    await store.updateProfile({ displayName: "Elena", tastes: "tango", emergencyName: "Lucía", emergencyPhone: "099" });
    await store.recordConsent("2026-10-29T14:00:00.000Z", true);
    await store.addFact({ category: "lugar", content: "Vivió en el Cerro", source: "setup" });

    const missingPin = await handleCreateSession(depsFor(store, { setupPin: null }), pinHeaders(), {});
    expect(missingPin.status).toBe(503);

    const created = await handleCreateSession(deps, pinHeaders(), { initiator: "user" });
    expect(created.status).toBe(200);
    const body = created.body as { clientSecret: string; sessionToken: string; greetingCue: string };
    expect(body.clientSecret).toBe("ek_test");
    expect(JSON.stringify(created.body)).not.toContain("sk-test-secret");
    expect(body.greetingCue.length).toBeGreaterThan(10);

    const remembered = await handleTool(deps, pinHeaders(), {
      sessionToken: body.sessionToken,
      name: "remember_fact",
      arguments: { category: "gusto", content: "Le gusta el tango de Troilo" },
    });
    expect(JSON.stringify(remembered.body)).toContain("Guardado");
    const recalled = await handleTool(deps, pinHeaders(), {
      sessionToken: body.sessionToken,
      name: "recall_facts",
      arguments: { query: "cerro" },
    });
    expect(JSON.stringify(recalled.body)).toContain("Cerro");
    const known = await handleTool(deps, pinHeaders(), { sessionToken: body.sessionToken, name: "what_do_you_know", arguments: {} });
    expect(JSON.stringify(known.body)).toContain("Elena");
    const forgotten = await handleTool(deps, pinHeaders(), {
      sessionToken: body.sessionToken,
      name: "forget_fact",
      arguments: { query: "troilo" },
    });
    expect(JSON.stringify(forgotten.body)).toContain("Borré");
    const concern = await handleTool(deps, pinHeaders(), {
      sessionToken: body.sessionToken,
      name: "flag_concern",
      arguments: { level: 2, reason: "frase", excerpt: "me quiero morir" },
    });
    expect(JSON.stringify(concern.body)).toContain("0800 0767");
    const safety = await handleSafety(deps, pinHeaders(), { sessionToken: body.sessionToken, text: "No puedo respirar" });
    expect(safety.body).toMatchObject({ level: 3, interrupt: true });
    expect(JSON.stringify(safety.body)).toContain("911");

    const ended = await handleEndSession(deps, pinHeaders(), {
      sessionToken: body.sessionToken,
      outcome: "completed",
      userSpoke: true,
      transcript: [
        { role: "user", text: "Me gusta el tango", at: "2026-10-29T14:01:00.000Z" },
        { role: "assistant", text: "Qué lindo.", at: "2026-10-29T14:02:00.000Z" },
        { role: "nope", text: "x" },
      ],
      usageEvents: [{ input_tokens: 1000, output_tokens: 500, input_token_details: { audio_tokens: 1000, text_tokens: 0 }, output_token_details: { audio_tokens: 500, text_tokens: 0 } }],
    });
    expect(ended.status).toBe(200);
    const again = await handleEndSession(deps, pinHeaders(), { sessionToken: body.sessionToken, outcome: "completed" });
    expect(again.body).toMatchObject({ alreadyEnded: true });
    const facts = await store.listFacts();
    expect(facts.some((fact) => fact.content.includes("Troilo"))).toBe(true);
    expect(parseTranscript("no")).toEqual([]);

    const health = await handleHealth(deps);
    expect(health.body).toMatchObject({ openai: true, pin: true });
    const pub = await handlePublicProfile(deps, pinHeaders());
    expect(pub.body).toMatchObject({ displayName: "Elena" });
    expect(JSON.stringify(pub.body)).not.toContain("099");
    const setup = await handleSetupGet(deps, pinHeaders());
    expect(JSON.stringify(setup.body)).toContain("Elena");
    const saved = await handleSetupPut(deps, pinHeaders(), { displayName: "Elena", dailyTime: "11:15" });
    expect(saved.status).toBe(200);
    const added = await handleSetupPost(deps, pinHeaders(), { action: "add_fact", category: "familia", content: "Su hija se llama Lucía" });
    expect(added.status).toBe(200);
    const factId = (added.body as { fact: { id: string } }).fact.id;
    expect((await handleSetupPost(deps, pinHeaders(), { action: "delete_fact", id: factId })).status).toBe(200);
    expect((await handleSetupPost(deps, pinHeaders(), { action: "clear_memory", confirm: "no" })).status).toBe(400);
    expect((await handleSetupPost(deps, pinHeaders(), { action: "clear_memory", confirm: "BORRAR" })).status).toBe(200);
    expect((await store.getProfile()).displayName).toBe("Elena");
    expect(await store.listFacts()).toEqual([]);

    const proactive = await handleProactive(deps, pinHeaders());
    expect(proactive.body).toMatchObject({ shouldStart: false });
    close();
  });

  it("refuses a second proactive start and a missing key", async () => {
    const { store, close } = await memoryDb();
    const deps = depsFor(store, { openAiApiKey: null }, fetchMock());
    const blocked = await handleCreateSession(deps, pinHeaders(), { initiator: "proactive" });
    expect(blocked.status).toBe(503);
    expect((await store.getProactiveDay("2026-10-29")).attempts).toBe(0);
    const withKey = depsFor(store, {}, fetchMock());
    const first = await handleCreateSession(withKey, pinHeaders(), { initiator: "proactive" });
    expect(first.status).toBe(200);
    const second = await handleCreateSession(withKey, pinHeaders(), { initiator: "proactive" });
    expect(second.status).toBe(409);
    const token = (first.body as { sessionToken: string }).sessionToken;
    const declined = await handleTool(withKey, pinHeaders(), {
      sessionToken: token,
      name: "decline_session",
      arguments: "{\"retry_ok\":false}",
    });
    expect(declined.body).toMatchObject({ hangup: "declined" });
    expect((await store.getProactiveDay("2026-10-29")).declined).toBe(true);
    expect((await handleTool(withKey, pinHeaders(), { sessionToken: "no", name: "end_session", arguments: {} })).status).toBe(401);
    expect((await handleTool(withKey, new Headers(), { sessionToken: token, name: "end_session" })).status).toBe(401);
    expect((await handleEndSession(withKey, pinHeaders(), {})).status).toBe(400);
    expect((await handleSetupPut(withKey, pinHeaders(), { dailyTime: "99:00" })).status).toBe(400);
    expect((await handleSetupPost(withKey, pinHeaders(), { action: "add_fact", category: "gusto", content: "diagnóstico de algo" })).status).toBe(400);
    expect((await handleSafety(withKey, pinHeaders(), { sessionToken: token, text: "el día está lindo" })).body).toMatchObject({ level: 0 });
    close();
  });

  it("logs a mood and a micro goal", async () => {
    const { store, close } = await memoryDb();
    const deps = depsFor(store, {}, fetchMock());
    await store.recordConsent("2026-10-01T15:00:00.000Z", true);
    const created = await handleCreateSession(deps, pinHeaders(), {});
    const token = (created.body as { sessionToken: string }).sessionToken;
    const goal = await handleTool(deps, pinHeaders(), { sessionToken: token, name: "save_microgoal", arguments: { content: "Llamar a Lucía" } });
    expect(JSON.stringify(goal.body)).toContain("Lucía");
    const done = await handleTool(deps, pinHeaders(), { sessionToken: token, name: "complete_microgoal", arguments: { query: "llamar" } });
    expect(JSON.stringify(done.body)).toContain("hecha");
    const mood = await handleTool(deps, pinHeaders(), {
      sessionToken: token,
      name: "log_mood",
      arguments: { instrument: "who5", item_id: "who_calm", raw_answer: "bastante", score: 4 },
    });
    expect(JSON.stringify(mood.body)).toContain("Señal");
    const consent = await handleTool(deps, pinHeaders(), { sessionToken: token, name: "record_consent", arguments: { accepted: false } });
    expect(JSON.stringify(consent.body)).toContain("no guardamos");
    const blocked = await handleTool(deps, pinHeaders(), {
      sessionToken: token,
      name: "remember_fact",
      arguments: { category: "gusto", content: "Le gusta el río" },
    });
    expect(JSON.stringify(blocked.body)).toContain("permiso");
    expect((await handleTool(deps, pinHeaders(), { sessionToken: token, name: "nope", arguments: {} })).status).toBe(400);
    const retry = await handleTool(deps, pinHeaders(), {
      sessionToken: token,
      name: "decline_session",
      arguments: { retry_ok: true },
    });
    expect(retry.body).toMatchObject({ hangup: "declined" });
    expect((await store.getProactiveDay("2026-10-29")).nextRetryAt).toBeTruthy();
    const goodbye = await handleTool(deps, pinHeaders(), { sessionToken: token, name: "end_session", arguments: { reason: "chau" } });
    expect(goodbye.body).toMatchObject({ hangup: "completed" });
    close();
  });
});

describe("default dependencies", () => {
  it("opens the local store from the environment", async () => {
    const previous = {
      DATABASE_URL: process.env.DATABASE_URL,
      CHARLA_DB_PATH: process.env.CHARLA_DB_PATH,
      SETUP_PIN: process.env.SETUP_PIN,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    const file = path.join(os.tmpdir(), `charla-deps-${Date.now()}.sqlite`);
    delete process.env.DATABASE_URL;
    process.env.CHARLA_DB_PATH = file;
    process.env.SETUP_PIN = "1357";
    process.env.OPENAI_API_KEY = "sk-env";
    resetStoreForTests();
    const deps = await defaultDeps();
    expect((await deps.store.getProfile()).dailyTime).toBe("11:00");
    expect(deps.authorize("1357").ok).toBe(true);
    expect(deps.takeMint().ok).toBe(true);
    const health = await handleHealth(deps);
    expect(health.body).toMatchObject({ openai: true, pin: true, store: "sqlite" });
    resetStoreForTests();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(file, { force: true });
  });
});
