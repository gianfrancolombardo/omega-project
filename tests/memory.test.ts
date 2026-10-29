import { describe, expect, it } from "vitest";

import { openSqliteFile, openSqliteMemory } from "@/lib/db/sqlite";
import { migrate, POSTGRES_LOCKDOWN, SCHEMA_STATEMENTS } from "@/lib/db/schema";
import { createMemoryStore } from "@/lib/db/memory-store";
import {
  bindPostgresValues,
  createPostgresDb,
  createSimplePostgresClient,
  openPostgres,
  postgresClientConfig,
  postgresLiteral,
} from "@/lib/db/postgres";
import { sqlParams, toPostgresSql, type Db } from "@/lib/db/sql";
import { openStoreFromConfig, resetStoreForTests, getStore } from "@/lib/db/index";
import { parseEnv } from "@/lib/env";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

describe("sqlite memory", () => {
  it("stores one person's facts, sessions and the daily claim", async () => {
    const db = openSqliteMemory();
    await migrate(db, "2026-10-29T14:00:00.000Z", "America/Montevideo");
    await migrate(db, "2026-10-29T14:00:00.000Z", "America/Montevideo");
    const store = createMemoryStore(db, { now: () => new Date("2026-10-29T14:00:00.000Z") });
    const profile = await store.updateProfile({ displayName: "Elena", tastes: "tango", importantPeople: "Lucía" });
    expect(profile.displayName).toBe("Elena");
    expect(await store.recordConsent("2026-10-29T14:00:00.000Z", true)).toMatchObject({ userConsentAt: "2026-10-29T14:00:00.000Z" });
    const saved = await store.addFact({ category: "gusto", content: "Le gusta el tango de Troilo", source: "setup" });
    expect(saved.ok && saved.created).toBe(true);
    expect((await store.addFact({ category: "gusto", content: "le gusta el tango de troilo" })).ok && true).toBe(true);
    const again = await store.addFact({ category: "gusto", content: "Le gusta el tango de Troilo" });
    expect(again.ok && again.created).toBe(false);
    expect((await store.addFact({ category: "otro", content: "Toma una pastilla" })).ok).toBe(false);
    expect((await store.addFact({ category: "gusto", content: " " })).ok).toBe(false);
    expect((await store.searchFacts("troilo", 3)).length).toBe(1);
    expect((await store.searchFacts("", 1)).length).toBe(1);
    expect(await store.searchFacts("inexistente")).toEqual([]);
    const created = await store.createSession({ initiator: "user", module: "charla", model: "gpt-realtime-2.1-mini", voice: "marin" });
    expect(await store.getSessionByToken(created.token)).toMatchObject({ status: "active" });
    expect(await store.getSessionByToken("nope")).toBeNull();
    expect(await store.hasOpenSession("2026-10-29T00:00:00.000Z")).toBe(true);
    await store.addMood({ sessionId: created.session.id, instrument: "daily", itemId: "animo", rawAnswer: "bien", score: 4, note: "" });
    expect((await store.listMood(5)).length).toBe(1);
    await store.addAlert({
      sessionId: created.session.id,
      level: 2,
      kind: "distress",
      reason: "ánimo",
      excerpt: "bajo",
      notifyStatus: "stub",
      notifyDetail: "guardado",
    });
    expect((await store.listAlerts(5))[0].kind).toBe("distress");
    const goal = await store.addMicrogoal("Llamar a Lucía", created.session.id);
    expect(await store.completeMicrogoal("lucía")).toMatchObject({ status: "done" });
    expect(await store.completeMicrogoal("nada")).toBeNull();
    expect(await store.addMicrogoal("Otra", null)).toBeTruthy();
    expect((await store.listOpenMicrogoals()).map((item) => item.id)).not.toContain(goal.id);
    const claimed = await Promise.all([
      store.tryClaimProactive({ localDate: "2026-10-29", mode: "first", nowIso: "2026-10-29T14:00:00.000Z" }),
      store.tryClaimProactive({ localDate: "2026-10-29", mode: "first", nowIso: "2026-10-29T14:00:00.000Z" }),
    ]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect((await store.getProactiveDay("2026-10-29")).attempts).toBe(1);
    await store.undoProactiveClaim("2026-10-29");
    expect((await store.getProactiveDay("2026-10-29")).attempts).toBe(0);
    await store.undoProactiveClaim("1999-01-01");
    const forgotten = await store.forgetFact("ultimo");
    expect(forgotten?.content).toContain("tango");
    expect(await store.forgetFact("playa")).toBeNull();
    await store.addFact({ category: "lugar", content: "La rambla de Pocitos" });
    expect((await store.forgetFact("rambla"))?.content).toContain("rambla");
    expect(await store.deleteFact("missing")).toBe(false);
    await store.updateSession(created.session.id, {
      status: "completed",
      endedAt: "2026-10-29T14:20:00.000Z",
      transcript: [{ role: "user", text: "Hola", at: "t" }],
      summary: "Saludó",
      openThreads: [],
      durationSeconds: 120,
      userWords: 1,
      agentWords: 2,
      usage: { inputText: 1, inputAudio: 0, cachedText: 0, cachedAudio: 0, outputText: 1, outputAudio: 0, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      costApproximate: false,
      summarySource: "fallback",
    });
    expect((await store.listSessions(5))[0].summary).toBe("Saludó");
    await store.expireStaleSessions("2026-10-29T13:00:00.000Z", "2026-10-29T15:00:00.000Z");
    await store.clearMemory("2026-10-29T16:00:00.000Z");
    expect((await store.getProfile()).displayName).toBe("Elena");
    expect(await store.listFacts()).toEqual([]);
    expect((await store.getProfile()).userConsentAt).toBeNull();
    const declined = await store.recordConsent("2026-10-29T16:00:00.000Z", false);
    expect(declined.memoryDeclinedAt).toBeTruthy();
    await store.updateProactive("2026-10-29", "engage", new Date("2026-10-29T16:00:00.000Z"));
    expect(await store.tryClaimProactive({ localDate: "2026-10-29", mode: "first", nowIso: "2026-10-29T16:00:00.000Z" })).toBe(false);
    db.close();
  });

  it("opens a file database", async () => {
    const file = path.join(os.tmpdir(), `charla-${Date.now()}.sqlite`);
    const db = openSqliteFile(file);
    await migrate(db, "2026-10-29T14:00:00.000Z", "America/Montevideo");
    const row = await db.get("SELECT display_name FROM profile WHERE id = 'primary'");
    expect(row?.display_name).toBe("");
    db.close();
    fs.rmSync(file, { force: true });
  });
});

describe("postgres adapter", () => {
  it("translates placeholders and never opens a live pool in tests", async () => {
    expect(toPostgresSql("SELECT * FROM t WHERE a = ? AND b = ?")).toBe("SELECT * FROM t WHERE a = $1 AND b = $2");
    expect(sqlParams([true, false, undefined, 2, "x"])).toEqual([1, 0, null, 2, "x"]);
    expect(postgresLiteral("O'Brien")).toBe("'O''Brien'");
    expect(postgresLiteral(null)).toBe("NULL");
    expect(bindPostgresValues("SELECT $1, $2", ["cuesta $1", 3])).toBe("SELECT 'cuesta $1', 3");
    expect(() => bindPostgresValues("SELECT $2", ["only"])).toThrow(/parameter count/);
    const local = postgresClientConfig("postgres://localhost/charla");
    expect(local.ssl).toBeUndefined();
    expect(postgresClientConfig("postgres://db.example/charla?sslmode=disable").ssl).toBeUndefined();
    const pooled = postgresClientConfig(
      "postgresql://postgres.abc:secret@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&sslmode=require",
    );
    expect(pooled.ssl).toEqual({ rejectUnauthorized: false });
    expect(pooled.connectionString).toBe("postgresql://postgres.abc:secret@aws-0-sa-east-1.pooler.supabase.com:6543/postgres");
    expect(pooled).not.toHaveProperty("max");
    expect(postgresClientConfig("not a url").connectionString).toBe("not a url");
    expect(postgresLiteral(Number.NaN)).toBe("NULL");
    const seen: string[] = [];
    const db = createPostgresDb({
      async query(sql, params) {
        seen.push(sql);
        if (sql.includes("missing")) return { rows: [], rowCount: null };
        return { rows: [{ id: params?.[0] ?? "1" }], rowCount: 1 };
      },
    });
    await db.exec("CREATE TABLE t (id TEXT)");
    expect(await db.get("SELECT id FROM t WHERE id = ?", ["a"])).toEqual({ id: "a" });
    expect(await db.all("SELECT id FROM t WHERE id = ?", ["b"])).toEqual([{ id: "b" }]);
    expect(await db.run("UPDATE t SET id = ?", ["c"])).toEqual({ changes: 1 });
    expect(await db.run("UPDATE missing SET id = ?", ["d"])).toEqual({ changes: 0 });
    expect(seen.some((sql) => sql.includes("$1"))).toBe(true);
    let url = "";
    const opened = openPostgres("postgres://example/charla", (value) => {
      url = value;
      return { async query() { return { rows: [], rowCount: 0 }; } };
    });
    expect(url).toBe("postgres://example/charla");
    expect(await opened.get("SELECT 1")).toBeUndefined();
    const calls: string[] = [];
    let ended = 0;
    const simple = createSimplePostgresClient("postgres://db.example/charla", async () => ({
      async query(text) {
        calls.push(text);
        if (text.includes("boom")) throw new Error("boom");
        return { rows: [{ ok: 1 }], rowCount: 1 };
      },
      async end() {
        ended += 1;
      },
    }));
    expect(await simple.query("SELECT $1 AS name", ["Ana"])).toEqual({ rows: [{ ok: 1 }], rowCount: 1 });
    await expect(simple.query("SELECT $1", ["boom"])).rejects.toThrow("boom");
    expect(calls).toEqual(["SELECT 'Ana' AS name", "SELECT 'boom'"]);
    expect(ended).toBe(2);
    await expect(
      createSimplePostgresClient("postgres://db.example/charla", async () => {
        throw new Error("no connect");
      }).query("SELECT 1"),
    ).rejects.toThrow("no connect");
    const sqlFile = fs.readFileSync(path.join(process.cwd(), "supabase", "schema.sql"), "utf8");
    for (const statement of SCHEMA_STATEMENTS) {
      const table = /TABLE(?: IF NOT EXISTS)? (\w+)/.exec(statement)?.[1];
      if (table) expect(sqlFile).toContain(table);
    }
    for (const statement of POSTGRES_LOCKDOWN) expect(sqlFile).toContain(statement);
    const executed: string[] = [];
    await migrate(
      {
        async exec(sql) {
          executed.push(sql);
        },
        async all() {
          return [];
        },
        async get() {
          return { id: "primary" };
        },
        async run() {
          return { changes: 0 };
        },
      } as Db,
      "2026-10-29T14:00:00.000Z",
      "America/Montevideo",
      "postgres",
    );
    expect(executed.some((sql) => sql.includes("ENABLE ROW LEVEL SECURITY"))).toBe(true);
  });

  it("builds a store from either opener", async () => {
    const sqliteStore = await openStoreFromConfig(parseEnv({}), {
      sqlite: () => openSqliteMemory(),
      postgres: () => {
        throw new Error("postgres");
      },
    });
    expect((await sqliteStore.getProfile()).dailyTime).toBe("11:00");
    const fake: Db = {
      async exec() {},
      async all() {
        return [];
      },
      async get() {
        return undefined;
      },
      async run() {
        return { changes: 1 };
      },
    };
    const postgresStore = await openStoreFromConfig(parseEnv({ DATABASE_URL: "postgres://example/charla" }), {
      sqlite: () => {
        throw new Error("sqlite");
      },
      postgres: () => fake,
    });
    await expect(postgresStore.getProfile()).rejects.toThrow(/Profile row/);
  });

  it("reuses the process store", async () => {
    const previous = process.env.DATABASE_URL;
    const previousPath = process.env.CHARLA_DB_PATH;
    const file = path.join(os.tmpdir(), `charla-get-${Date.now()}.sqlite`);
    delete process.env.DATABASE_URL;
    process.env.CHARLA_DB_PATH = file;
    resetStoreForTests();
    const first = await getStore();
    const second = await getStore();
    expect(second).toBe(first);
    expect((await first.getProfile()).addressForm).toBe("vos");
    resetStoreForTests();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    if (previousPath === undefined) delete process.env.CHARLA_DB_PATH;
    else process.env.CHARLA_DB_PATH = previousPath;
    fs.rmSync(file, { force: true });
  });
});
