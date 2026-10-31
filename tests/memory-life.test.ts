import { describe, expect, it } from "vitest";

import { openSqliteMemory } from "@/lib/db/sqlite";
import { migrate } from "@/lib/db/schema";
import { handleCreateSession, handleEndSession } from "@/lib/http/session-api";
import { handleTool } from "@/lib/http/tools-api";
import { extractFactsFromTranscript } from "@/lib/memory/extract";
import { factOverlap, mergeIncomingFacts, planFactWrite } from "@/lib/memory/reconcile";
import { selectFactsForPrompt } from "@/lib/memory/select";
import { assembleInstructions, greetingLine } from "@/lib/prompt/assemble";
import { REALTIME_TOOLS } from "@/lib/prompt/tools";
import { saveProfileFeedback, activateTabletFeedback } from "@/lib/setup/feedback";
import type { Fact, Profile } from "@/lib/domain";
import { depsFor, memoryDb, pinHeaders } from "./helpers";

function fact(id: string, category: Fact["category"], content: string): Fact {
  return { id, category, content, createdAt: "2026-10-01T00:00:00.000Z", sourceSessionId: null, source: "tool" };
}

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    displayName: "Elena",
    addressForm: "vos",
    timezone: "America/Montevideo",
    dailyTime: "11:00",
    proactiveEnabled: true,
    tastes: "pizza",
    lifeNotes: "",
    avoidTopics: "hospital",
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

describe("fact reconcile and rotation", () => {
  it("updates a richer or corrected fact and keeps a poorer copy", () => {
    const existing = [{ id: "1", category: "gusto" as const, content: "Le gusta la pizza." }];
    expect(planFactWrite(existing, { category: "gusto", content: "Le gusta la pizza." }).type).toBe("keep");
    expect(planFactWrite(existing, { category: "interes", content: "Le gusta la pizza." })).toMatchObject({
      type: "update",
      category: "interes",
    });
    expect(planFactWrite(existing, { category: "gusto", content: "Le gusta la pizza de muzza." })).toMatchObject({
      type: "update",
      content: "Le gusta la pizza de muzza.",
    });
    expect(
      planFactWrite([{ id: "1", category: "gusto", content: "Le gusta la pizza de muzza." }], {
        category: "gusto",
        content: "Le gusta la pizza.",
      }).type,
    ).toBe("keep");
    expect(planFactWrite(existing, { category: "disgusto", content: "No le gusta la pizza." })).toMatchObject({
      type: "update",
      category: "disgusto",
    });
    expect(planFactWrite(existing, { category: "gusto", content: "Le gusta el tango." }).type).toBe("insert");
    const left = "Le gusta el tango de Troilo con Gardel en el club del barrio y el baile";
    const right = "Le gusta el tango de Troilo con Gardel en el club del barrio y la milonga";
    expect(factOverlap(left, right)).toBeGreaterThanOrEqual(0.75);
    expect(planFactWrite([{ id: "9", category: "gusto", content: left }], { category: "gusto", content: right })).toMatchObject({
      type: "update",
      content: right,
    });
    expect(planFactWrite([], { category: "gusto", content: "Le gusta el mate." }).type).toBe("insert");
    expect(factOverlap("", "hola")).toBe(0);
    const troilo = "Le gusta el tango de Troilo en el baile";
    const gardel = "Le gusta el tango de Gardel en el baile";
    const partial = factOverlap(troilo, gardel);
    expect(partial).toBeGreaterThanOrEqual(0.6);
    expect(partial).toBeLessThan(0.75);
    expect(planFactWrite([{ id: "9", category: "gusto", content: troilo }], { category: "gusto", content: gardel }).type).toBe(
      "insert",
    );
  });

  it("drops clinical text and caps a batch", () => {
    const animals = ["gato", "perro", "zorro", "cebra", "koala", "puma", "lince", "tapir", "llama", "bufalo"];
    const many = animals.map((animal) => ({
      category: "gusto" as const,
      content: `Le gusta el ${animal} del zoológico.`,
    }));
    const extra = ["violin", "ajedrez", "ceramica", "jardin", "bosque", "tren"].map((word) => ({
      category: "historia" as const,
      content: `Recuerdo el ${word} de su juventud.`,
    }));
    const merged = mergeIncomingFacts([
      { category: "gusto", content: "Le gusta la pizza." },
      { category: "gusto", content: "Le gusta la pizza de muzza." },
      { category: "gusto", content: "Toma una pastilla de 10 mg" },
      { category: "gusto", content: " " },
      ...many,
      ...extra,
    ]);
    expect(merged.some((item) => item.content.includes("pastilla"))).toBe(false);
    expect(merged.some((item) => item.content.includes("muzza"))).toBe(true);
    expect(merged.some((item) => item.content === "Le gusta la pizza.")).toBe(false);
    expect(merged.length).toBe(16);
  });

  it("rotates a compact mix and skips avoided topics", () => {
    const facts = [
      ...Array.from({ length: 5 }, (_, index) => fact(String(index), "gusto", `Le gusta el tema ${index} de la radio.`)),
      fact("f", "familia", "Su hija se llama Lucía."),
      fact("l", "lugar", "Nació en Salto."),
      fact("h", "salud", "Estuvo en el hospital de clínicas."),
    ];
    expect(selectFactsForPrompt(facts, "seed", 0)).toEqual([]);
    const mixed = selectFactsForPrompt(facts, "2026-10-29", 6, "hospital");
    expect(mixed.some((item) => item.category === "salud")).toBe(false);
    expect(mixed.filter((item) => item.category === "gusto").length).toBeLessThanOrEqual(2);
    expect(mixed.some((item) => item.category === "familia")).toBe(true);
    const picks = new Set<string>();
    for (let day = 1; day <= 12; day += 1) {
      const picked = selectFactsForPrompt(facts, `2026-10-${String(day).padStart(2, "0")}`, 1);
      expect(picked).toHaveLength(1);
      picks.add(picked[0]?.id ?? "");
    }
    expect(picks.size).toBeGreaterThan(1);
    expect(selectFactsForPrompt([fact("only", "gusto", "Le gusta el mate.")], "a", 4)).toHaveLength(1);
  });
});

describe("transcript extraction", () => {
  it("saves durable life facts and ignores chatter, Clara and clinical talk", () => {
    const facts = extractFactsFromTranscript([
      { role: "assistant", text: "Me gusta hablar de pizza.", at: "t" },
      { role: "user", text: "Hola", at: "t" },
      { role: "user", text: "Me gusta eso.", at: "t" },
      {
        role: "user",
        text: "Me gusta la pizza de muzza y el fútbol. No me gusta el hígado. Me interesa la astronomía. Mi hija se llama Lucía. Nací en Salto. El cumpleaños de Lucía es el 3 de mayo. Uso andador. Me acuerdo de la escuela del barrio. Todas las mañanas escucho la radio.",
        at: "t",
      },
      { role: "user", text: "Tomo una pastilla de 10 mg y me gusta el té.", at: "t" },
      { role: "user", text: "Me quiero morir.", at: "t" },
      { role: "user", text: "Vivo en Pocitos. Soy de Melo. Adoro el dulce de leche. Me gustan las milanesas. Me cuesta oír.", at: "t" },
    ]);
    const text = facts.map((item) => `${item.category}:${item.content}`).join("\n");
    expect(text).toContain("gusto:Le gusta la pizza de muzza.");
    expect(text).toContain("gusto:Le gusta el fútbol.");
    expect(text).toContain("disgusto:No le gusta el hígado.");
    expect(text).toContain("interes:Le interesa la astronomía.");
    expect(text).toContain("familia:Su hija se llama Lucía.");
    expect(text).toContain("lugar:Nació o creció en Salto.");
    expect(text).toContain("fecha:El cumpleaños de Lucía es el 3 de mayo.");
    expect(text).toContain("salud:Usa andador.");
    expect(text).not.toContain("Recuerdo:");
    expect(text).not.toContain("Rutina:");
    expect(text).not.toContain("Vive o vivió en Pocitos.");
    expect(text).toContain("lugar:Es de Melo.");
    expect(extractFactsFromTranscript([{ role: "user", text: "Me gusta mi casa.", at: "t" }])).toEqual([]);
    expect(extractFactsFromTranscript([{ role: "user", text: "No sé si me gusta el sushi.", at: "t" }])).toEqual([]);
    expect(extractFactsFromTranscript([{ role: "user", text: "A veces me gusta el café.", at: "t" }])).toEqual([]);
    expect(text).toContain("gusto:Le encanta el dulce de leche.");
    expect(text).toContain("gusto:Le gustan las milanesas.");
    expect(text).toContain("salud:Le cuesta oír.");
    const more = extractFactsFromTranscript([
      {
        role: "user",
        text: "Uso silla de ruedas. Camino con bastón. No salgo de casa. Me canso. Me cuesta caminar. Crecí en Rocha. Odio el ruido. Me encantan los tangos. Me da curiosidad el mar. Detesto el frío. No soporto la humedad.",
        at: "t",
      },
    ])
      .map((item) => `${item.category}:${item.content}`)
      .join("\n");
    expect(more).toContain("salud:Usa silla de ruedas.");
    expect(more).toContain("salud:Camina con bastón.");
    expect(more).toContain("salud:No sale de casa.");
    expect(more).toContain("salud:Se cansa con facilidad.");
    expect(more).toContain("salud:Le cuesta caminar.");
    expect(more).toContain("lugar:Nació o creció en Rocha.");
    expect(more).toContain("disgusto:No le gusta el ruido.");
    expect(more).toContain("gusto:Le encantan los tangos.");
    expect(more).toContain("interes:Le interesa el mar.");
    expect(more).toContain("disgusto:No le gusta el frío.");
    expect(more).toContain("disgusto:No le gusta la humedad.");
    expect(text).not.toContain("pastilla");
    expect(text).not.toContain("morir");
    expect(text).not.toContain("hablar de pizza");
  });
});

describe("prompt variety", () => {
  it("treats tastes as context and keeps the emergency script", () => {
    const assembled = assembleInstructions({
      profile: profile(),
      facts: [fact("1", "gusto", "Le gusta la pizza.")],
      summaries: [
        {
          startedAt: "2026-10-28T14:00:00.000Z",
          module: "charla",
          summary: "Hablaron de pizza toda la charla.",
          openThreads: ["pizza"],
        },
      ],
      microgoals: [],
      plan: {
        module: "charla",
        reason: "Hoy toca charla.",
        theme: "cómo viene el día y qué le quedó dando vueltas",
        checkin: null,
        checkinLine: null,
      },
      dateLabel: "jueves 29 de octubre",
    });
    expect(assembled.instructions).toContain("no el tema de siempre");
    expect(assembled.instructions).toContain("Charlas recientes");
    expect(assembled.instructions).toContain("Hablaron de pizza");
    expect(assembled.instructions).not.toContain("Retomar un gusto");
    expect(assembled.instructions).toContain("Ante caída con no poder levantarse");
    expect(assembled.instructions).toContain("0800 0767");
    expect(assembled.instructions).toContain("Memoria implícita");
    expect(assembled.instructions).not.toContain("remember_fact");
    expect(assembled.instructions).not.toContain("pedí un sí");
    expect(assembled.instructions).not.toContain("guardá este recuerdo");
    expect(assembled.instructions).toContain("reminiscencia");
    expect(assembled.instructions).toContain("Llevá vos la charla");
    expect(assembled.greetingCue).toContain("No abras con un gusto");
    expect(assembled.greetingCue).toContain("No te presentes");
    expect(assembled.greetingCue).toContain(greetingLine("vos", "jueves 29 de octubre"));
    const threaded = assembleInstructions({
      profile: profile(),
      facts: [fact("1", "gusto", "Le gusta la pizza.")],
      summaries: [
        {
          startedAt: "2026-10-28T14:00:00.000Z",
          module: "charla",
          summary: "Hablaron de pizza toda la charla.",
          openThreads: ["pizza"],
        },
      ],
      microgoals: [],
      plan: {
        module: "charla",
        reason: "Hoy toca charla.",
        theme: "cómo viene el día y qué le quedó dando vueltas",
        checkin: null,
        checkinLine: null,
      },
      dateLabel: "jueves 29 de octubre",
      openerKind: "thread",
    });
    expect(threaded.greetingCue).toContain("pizza");
    const names = REALTIME_TOOLS.map((tool) => tool.name);
    expect(names).not.toContain("remember_fact");
    expect(names).toContain("forget_fact");
    expect(names).toContain("record_consent");
    const forget = REALTIME_TOOLS.find((tool) => tool.name === "forget_fact");
    expect(forget?.description).toContain("olvidá eso");
  });

  it("varies the opener and keeps the first hello minimal", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 40; index += 1) seen.add(greetingLine("vos", `dia-${index}`));
    expect(seen.size).toBeGreaterThanOrEqual(3);
    expect([...seen].some((line) => /hiciste|tal hoy|cómo estás/.test(line))).toBe(true);
    const formal = greetingLine("usted", "jueves 29 de octubre");
    expect(formal.startsWith("Hola")).toBe(true);
    expect(formal).not.toMatch(/hiciste|comiste|hablaste/);
    const first = assembleInstructions({
      profile: profile({ userConsentAt: null }),
      facts: [],
      summaries: [],
      microgoals: [],
      plan: {
        module: "charla",
        reason: "Hoy toca charla.",
        theme: "qué hizo hoy",
        checkin: null,
        checkinLine: null,
      },
      dateLabel: "viernes 30 de octubre",
      firstSession: true,
    });
    expect(first.greetingCue).toContain("Soy Clara");
    expect(first.greetingCue).toContain("inteligencia artificial");
    expect(first.greetingCue).toContain("olvidá eso");
    expect(first.greetingCue).toContain("No pidas permiso");
    expect(first.greetingCue).not.toContain("Presentate");
    expect(first.instructions).toContain("Si pregunta qué sos");
    expect(first.instructions).toContain("0800 0767");
  });
});

describe("setup feedback copy", () => {
  it("names success, a wrong PIN, a server error and a network error", () => {
    expect(saveProfileFeedback({ networkError: false, status: 200, serverMessage: null }).message).toContain("quedó guardada");
    expect(saveProfileFeedback({ networkError: false, status: 401, serverMessage: "El PIN no coincide." }).message).toContain("PIN");
    expect(saveProfileFeedback({ networkError: false, status: 500, serverMessage: null }).message).toContain("No pude guardar");
    expect(saveProfileFeedback({ networkError: true, status: null, serverMessage: null }).message).toContain("conexión");
    expect(saveProfileFeedback({ networkError: false, status: 401, serverMessage: "  " }).message).toContain("PIN");
    const tablet = activateTabletFeedback({ networkError: false, status: 200, serverMessage: null, storageError: false });
    expect(tablet.tone).toBe("success");
    expect(tablet.message).toContain("ya puede charlar");
    expect(activateTabletFeedback({ networkError: false, status: 401, serverMessage: null, storageError: false }).message).toContain("PIN");
    expect(activateTabletFeedback({ networkError: false, status: 503, serverMessage: "Falta SETUP_PIN", storageError: false }).message).toContain("SETUP_PIN");
    expect(activateTabletFeedback({ networkError: true, status: null, serverMessage: null, storageError: false }).message).toContain("no quedó activada");
    expect(activateTabletFeedback({ networkError: false, status: 200, serverMessage: null, storageError: true }).message).toContain("no dejó guardar");
  });
});

describe("memory end to end", () => {
  it("stores, updates and shows facts from the talk and from the closing summary", async () => {
    const db = openSqliteMemory();
    await db.exec(
      `CREATE TABLE facts (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source_session_id TEXT,
        source TEXT NOT NULL
      )`,
    );
    await migrate(db, "2026-10-29T14:00:00.000Z", "America/Montevideo");
    const columns = await db.all("PRAGMA table_info(facts)");
    expect(columns.some((column) => column.name === "updated_at")).toBe(true);
    db.close();

    const { store, close } = await memoryDb();
    await store.recordConsent("2026-10-01T00:00:00.000Z", true);
    const saved = await store.addFact({ category: "gusto", content: "Le gusta la pizza." });
    const updated = await store.addFact({ category: "gusto", content: "Le gusta la pizza de muzza." });
    expect(saved.ok && saved.created).toBe(true);
    expect(updated.ok && updated.updated).toBe(true);
    expect(await store.listFacts()).toHaveLength(1);
    expect((await store.listFacts())[0]?.content).toContain("muzza");

    const deps = depsFor(store, {}, async (input) => {
      const url = String(input);
      if (url.includes("client_secrets")) {
        return new Response(JSON.stringify({ value: "ek_test" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            summary: "Contó de la familia.",
            open_threads: ["la hija"],
            facts: [
              { category: "familia", content: "Su hija se llama Lucía y vive en Salto." },
              { category: "gusto", content: "Toma una pastilla de 10 mg" },
            ],
            concern: null,
          }),
        }),
        { status: 200 },
      );
    });
    const created = await handleCreateSession(deps, pinHeaders(), {});
    const token = (created.body as { sessionToken: string }).sessionToken;
    const captured = await handleTool(deps, pinHeaders(), {
      sessionToken: token,
      name: "capture_memory",
      arguments: { text: "Me gusta el helado de limón." },
    });
    expect(JSON.stringify(captured.body)).toContain("helado");
    const empty = await handleTool(deps, pinHeaders(), {
      sessionToken: token,
      name: "capture_memory",
      arguments: { text: "Hoy está lindo." },
    });
    expect(JSON.stringify(empty.body)).toContain("Nada nuevo");
    const ended = await handleEndSession(deps, pinHeaders(), {
      sessionToken: token,
      outcome: "completed",
      transcript: [
        { role: "user", text: "Mi hija se llama Lucía. Me gusta el helado de limón.", at: "2026-10-29T14:01:00.000Z" },
        { role: "assistant", text: "Qué lindo.", at: "2026-10-29T14:02:00.000Z" },
      ],
    });
    expect(ended.status).toBe(200);
    const facts = await store.listFacts();
    expect(facts.some((item) => item.content.includes("Lucía") && item.content.includes("Salto"))).toBe(true);
    expect(facts.some((item) => item.content.includes("pastilla"))).toBe(false);
    expect(facts.filter((item) => item.content.toLowerCase().includes("helado"))).toHaveLength(1);

    const fresh = await memoryDb();
    const freshDeps = depsFor(fresh.store, {}, async (input) => {
      if (String(input).includes("client_secrets")) {
        return new Response(JSON.stringify({ value: "ek_test" }), { status: 200 });
      }
      return new Response("no", { status: 500 });
    });
    const opened = await handleCreateSession(freshDeps, pinHeaders(), {});
    const openedBody = opened.body as { sessionToken: string; greetingCue: string };
    expect(openedBody.greetingCue).toContain("Soy Clara");
    expect(openedBody.greetingCue).not.toContain("Presentate");
    await handleTool(freshDeps, pinHeaders(), {
      sessionToken: openedBody.sessionToken,
      name: "capture_memory",
      arguments: { text: "Me gusta el queso." },
    });
    expect((await fresh.store.listFacts()).some((item) => item.content.includes("queso"))).toBe(true);
    await handleEndSession(freshDeps, pinHeaders(), {
      sessionToken: openedBody.sessionToken,
      outcome: "completed",
      transcript: [{ role: "user", text: "Me gusta el queso.", at: "t" }],
    });
    const again = await handleCreateSession(freshDeps, pinHeaders(), {});
    expect((again.body as { greetingCue: string }).greetingCue).toContain("No te presentes");
    expect((again.body as { greetingCue: string }).greetingCue).not.toContain("Es la primera charla");
    fresh.close();

    await store.recordConsent("2026-10-29T16:00:00.000Z", false);
    const declined = await handleCreateSession(deps, pinHeaders(), {});
    const blocked = await handleTool(deps, pinHeaders(), {
      sessionToken: (declined.body as { sessionToken: string }).sessionToken,
      name: "capture_memory",
      arguments: { text: "Me gusta el queso." },
    });
    expect(JSON.stringify(blocked.body)).toContain("permiso");
    close();
  });
});
