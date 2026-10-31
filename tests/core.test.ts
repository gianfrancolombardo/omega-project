import { describe, expect, it } from "vitest";

import { allowSessionMint, assessPinAttempt, pinsMatch } from "@/lib/auth/pin";
import {
  accidentalLine,
  exactSpeech,
  idleLabel,
  inviteLabel,
  listeningLabel,
  proactiveSilenceLine,
  silenceCloseLine,
  stillThereLine,
} from "@/lib/copy";
import { readJson } from "@/lib/http/body";
import { withErrors, pinHeader, requirePin } from "@/lib/http/guard";
import { clampSilenceSeconds, clampVoiceSpeed, memoryPersistence, parseEnv } from "@/lib/env";
import { isClinicalContent, parseFactInput, parseProfilePatch } from "@/lib/profile";
import { isConsentNo, isConsentYes, isDecline, isGoodbye } from "@/lib/session/phrases";
import { acceptTap, doseNudge, evaluateSilence } from "@/lib/session/policy";
import { applyProactiveEvent, proactiveDecision } from "@/lib/session/proactive";
import { chooseModule, planDay } from "@/lib/session/planner";
import { isMainModule } from "@/lib/session/modules";
import { CHECKIN_ITEMS, selectCheckinItem, spokenCheckin } from "@/lib/session/instruments";
import { sustainedLowMood } from "@/lib/safety/phq";
import { isRecentAlert } from "@/lib/safety/dedupe";
import { findElderspeak } from "@/lib/safety/elderspeak";
import { assessUtterance, safetyScript } from "@/lib/safety/assess";
import { priceUsage, ratesFor, sumUsage } from "@/lib/metrics/cost";
import { metricsToCsv, talkRatio, toMetrics } from "@/lib/metrics/csv";
import { tallyTranscript } from "@/lib/metrics/tally";
import { assembleInstructions, describeMemory } from "@/lib/prompt/assemble";
import { dispatchAlert } from "@/lib/notify";
import { clip, countWords, normalize, uniqueStrings } from "@/lib/text";
import { dailyInstant, formatClock, formatLongDate, isValidTimeZone, isWithinWindow, localDateInZone, zonedTimeToUtc } from "@/lib/time";
import { cn } from "@/lib/utils";
import { EMPTY_USAGE, type AlertRecord, type MoodSignal, type Profile, type SessionRecord } from "@/lib/domain";
import { depsFor, memoryDb, pinHeaders } from "./helpers";

const suicide = [
  "Quiero suicidarme",
  "Me quiero morir",
  "No quiero vivir más",
  "No quiero seguir viviendo",
  "Quiero dejar de vivir",
  "Me voy a matar",
  "Quiero matarme",
  "Tengo un plan para matarme",
  "Quiero terminar con todo",
  "Quiero terminar con mi vida",
  "No vale la pena vivir",
  "No vale la pena seguir viviendo",
  "Mejor estar muerto",
  "Mejor no estar vivo",
  "Voy a hacerme daño",
  "Me voy a hacer daño",
  "No quiero amanecer",
  "Estoy pensando en quitarme la vida",
  "Pensé en el suicidio",
  "Me quiero suicidar",
];

const neutral = [
  "Me muero de risa",
  "Me quiero morir de risa",
  "Matar el tiempo mirando el río",
  "Me caí en la cuenta de que era martes",
  "Me duele la cadera cuando camino",
  "No me puedo levantar temprano",
  "No me puedo levantar a la mañana",
  "No puedo respirar de la risa",
  "Hoy el cielo está lindo",
  "Me gusta el tango de Troilo",
  "Ayer hablé con mi hija",
  "El mate está lavado",
  "Quiero contar lo del Carnaval",
  "No me acuerdo del nombre de la calle",
  "Si me gusta el fútbol",
  "Ahora no me acuerdo",
  "Me caí de la silla de chico y no pasó nada",
  "El pecho de pollo quedó seco",
  "Fui al médico el año pasado y ya está",
  "Estoy contenta con la visita",
  "Mañana llamo a mi hermano",
  "La rambla de Ramírez era otra cosa",
  "Me canso si camino mucho, nada grave",
  "Dormí bien anoche",
  "Comí torta fritas el domingo",
  "No quiero el té, quiero café",
  "El partido estuvo parejo",
  "Me parece que las escuelas deberían guardar los celulares",
  "Contame algo nuevo",
  "Clara, ¿qué sabés de mí?",
  "Olvidá esto último",
  "Hasta mañana, fue una linda charla",
  "Me duele un poco la rodilla, de siempre",
  "Es un chiste malo y nada más",
  "Estoy en el piso de arriba, no en el suelo",
  "Me dieron un susto de risa",
  "Hace un rato que no como porque almorcé tarde",
  "Ayer no dormí la siesta",
  "Quiero vivir en la costa",
  "Me levanté a las ocho",
  "El ómnibus pasa a las once",
  "El calor no me molesta, me gusta",
  "Mi hija me llama los domingos",
  "Terminar con la torta antes de que se enfríe",
  "Mejor estar en casa que en la fila",
  "La radio de la mañana está baja",
  "Dejame pensar un segundo",
  "La novela de radio era de Gardel",
  "Mi vecina cocina rico",
  "Hoy no salí porque llueve",
];

describe("env and time", () => {
  it("parses defaults and clamps", () => {
    const config = parseEnv({});
    expect(config.realtimeModel).toBe("gpt-realtime-2.1-mini");
    expect(config.voice).toBe("marin");
    expect(config.timezone).toBe("America/Montevideo");
    expect(config.voiceSpeed).toBe(0.92);
    expect(parseEnv({ APP_TIMEZONE: "No/Existe", OPENAI_VOICE_SPEED: "9", SILENCE_CLOSE_SECONDS: "10", OPENAI_NOISE_REDUCTION: "near_field" }).timezone).toBe(
      "America/Montevideo",
    );
    expect(clampVoiceSpeed(9)).toBe(1.5);
    expect(clampVoiceSpeed(Number.NaN)).toBe(0.92);
    expect(clampSilenceSeconds(10)).toBe(60);
    expect(clampSilenceSeconds(120)).toBe(90);
    expect(clampSilenceSeconds(Number.NaN)).toBe(75);
    expect(parseEnv({ OPENAI_VOICE_SPEED: "0.4", SILENCE_CLOSE_SECONDS: "80", OPENAI_NOISE_REDUCTION: "near_field" }).noiseReduction).toBe("near_field");
    expect(memoryPersistence(parseEnv({ DATABASE_URL: "postgres://db/charla" }))).toEqual({ store: "postgres", persistent: true });
    expect(memoryPersistence(parseEnv({ VERCEL: "1" }))).toEqual({ store: "sqlite", persistent: false });
    expect(memoryPersistence(parseEnv({ NETLIFY: "true" }))).toEqual({ store: "sqlite", persistent: false });
    expect(memoryPersistence(parseEnv({ AWS_LAMBDA_FUNCTION_NAME: "charla" }))).toEqual({ store: "sqlite", persistent: false });
    expect(memoryPersistence(parseEnv({ DATABASE_URL: "postgres://db/charla", NETLIFY: "true" }))).toEqual({ store: "postgres", persistent: true });
    expect(memoryPersistence(parseEnv({}))).toEqual({ store: "sqlite", persistent: true });
  });

  it("converts 11:00 in Montevideo to 14:00 UTC", () => {
    expect(isValidTimeZone("America/Montevideo")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
    const instant = zonedTimeToUtc(2026, 10, 29, 11, 0, "America/Montevideo");
    expect(instant.toISOString()).toBe("2026-10-29T14:00:00.000Z");
    const now = new Date("2026-10-29T14:00:00.000Z");
    expect(localDateInZone(now, "America/Montevideo")).toBe("2026-10-29");
    expect(dailyInstant(now, "America/Montevideo", "11:00").toISOString()).toBe("2026-10-29T14:00:00.000Z");
    expect(isWithinWindow(now, instant, 60_000)).toBe(true);
    expect(isWithinWindow(new Date(instant.getTime() - 1), instant, 60_000)).toBe(false);
    expect(formatClock(now, "America/Montevideo")).toMatch(/11:00/);
    expect(formatLongDate(now, "America/Montevideo").toLowerCase()).toContain("octubre");
  });
});

describe("profile, copy and phrases", () => {
  it("validates a profile and rejects clinical facts", () => {
    expect(parseProfilePatch(null).ok).toBe(false);
    expect(parseProfilePatch({ displayName: 1 }).ok).toBe(false);
    expect(parseProfilePatch({ addressForm: "señor" }).ok).toBe(false);
    expect(parseProfilePatch({ dailyTime: "25:00" }).ok).toBe(false);
    expect(parseProfilePatch({ timezone: "No/Existe" }).ok).toBe(false);
    expect(parseProfilePatch({ proactiveEnabled: "sí" }).ok).toBe(false);
    const parsed = parseProfilePatch({
      displayName: " Elena ",
      addressForm: "usted",
      dailyTime: "11:30",
      timezone: "America/Montevideo",
      proactiveEnabled: false,
      reducedHearing: true,
      subtitles: false,
    });
    expect(parsed.ok && parsed.value.displayName).toBe("Elena");
    expect(parseFactInput({ category: "gusto", content: "Le gusta el tango" }).ok).toBe(true);
    expect(parseFactInput({ category: "nope", content: "x" }).ok).toBe(false);
    expect(parseFactInput({ category: "gusto", content: "a" }).ok).toBe(false);
    expect(parseFactInput({ category: "gusto", content: "Toma una pastilla de 10 mg" }).ok).toBe(false);
    expect(parseFactInput(null).ok).toBe(false);
    expect(parseFactInput({ category: "gusto", content: 3 }).ok).toBe(false);
    expect(isClinicalContent("Tiene un diagnóstico")).toBe(true);
    expect(normalize("¿Cómo estás?")).toBe("como estas");
    expect(countWords("Hola, Elena")).toBe(2);
    expect(clip("hola   mundo", 4)).toBe("hol…");
    expect(uniqueStrings([" Tango ", "tango", ""], 2)).toEqual(["Tango"]);
    expect(cn("a", false, "b")).toContain("a");
  });

  it("keeps the adult wording and the short replies", () => {
    expect(idleLabel("vos")).toBe("Tocá para charlar");
    expect(idleLabel("usted")).toBe("Toque para charlar");
    expect(listeningLabel("usted")).toContain("escucho");
    expect(inviteLabel("vos", "Elena")).toContain("Elena");
    expect(inviteLabel("usted", "")).toContain("Buen día");
    expect(exactSpeech(accidentalLine("vos"))).toContain("Si me necesitás");
    expect(stillThereLine("usted")).toContain("Sigue");
    expect(silenceCloseLine("vos")).toContain("mañana");
    expect(proactiveSilenceLine("usted")).toContain("toque");
    expect(isDecline("ahora no")).toBe(true);
    expect(isDecline("ahora no me acuerdo del nombre")).toBe(false);
    expect(isDecline("")).toBe(false);
    expect(isGoodbye("chau, hasta mañana")).toBe(true);
    expect(isGoodbye("me voy al almacén a comprar pan y después charlamos de otra cosa larga")).toBe(false);
    expect(isConsentYes("sí")).toBe(true);
    expect(isConsentYes("si me gusta el tango")).toBe(false);
    expect(isConsentNo("no")).toBe(true);
    expect(isConsentNo("no me acuerdo")).toBe(false);
  });
});

describe("planner, policy and mood", () => {
  it("does not repeat yesterday's module", () => {
    expect(isMainModule("charla")).toBe(true);
    expect(isMainModule("juego")).toBe(false);
    expect(chooseModule("2026-10-29", [{ module: "charla", localDate: "2026-10-28" }]).module).not.toBe("charla");
    const first = planDay({
      today: "2026-10-29",
      recent: [],
      sessionCount: 0,
      history: [],
      now: new Date("2026-10-29T14:00:00.000Z"),
      addressForm: "vos",
    });
    expect(first.module).toBe("charla");
    expect(first.checkin).toBeNull();
    const later = planDay({
      today: "2026-10-29",
      recent: [{ module: "charla", localDate: "2026-10-28" }],
      sessionCount: 2,
      history: [],
      now: new Date("2026-10-29T14:00:00.000Z"),
      addressForm: "vos",
    });
    expect(later.module).not.toBe("charla");
    expect(later.checkinLine).toContain("log_mood");
    expect(
      chooseModule("2026-10-29", [
        { module: "opinion", localDate: "2026-10-29" },
        { module: "curiosidad", localDate: "2026-10-29" },
        { module: "mi_historia", localDate: "2026-10-29" },
        { module: "charla", localDate: "2026-10-29" },
      ]).module,
    ).toBe("charla");
    const curious = planDay({
      today: "2026-10-29",
      recent: [
        { module: "charla", localDate: "2026-10-29" },
        { module: "mi_historia", localDate: "2026-10-28" },
      ],
      sessionCount: 2,
      history: CHECKIN_ITEMS.map((item) => ({ instrument: item.instrument, itemId: item.itemId, createdAt: "2026-10-28T12:00:00.000Z" })),
      now: new Date("2026-10-29T14:00:00.000Z"),
      addressForm: "vos",
    });
    expect(curious.module).toBe("curiosidad");
    expect(curious.theme).toContain("atardecer");
    expect(curious.theme).not.toContain("tango");
    expect(curious.checkin).toBeNull();
    expect(selectCheckinItem({ sessionCount: 0, history: [], now: new Date() })).toBeNull();
    const recent = selectCheckinItem({
      sessionCount: 3,
      history: CHECKIN_ITEMS.filter((item) => item.instrument !== "phq2").map((item) => ({
        instrument: item.instrument,
        itemId: item.itemId,
        createdAt: "2026-10-28T12:00:00.000Z",
      })),
      now: new Date("2026-10-29T14:00:00.000Z"),
    });
    expect(recent?.instrument).toBe("phq2");
    expect(spokenCheckin(CHECKIN_ITEMS[0], "usted")).toContain("siente");
  });

  it("debounces taps and closes on silence", () => {
    expect(acceptTap(2_000, 0)).toBe(true);
    expect(acceptTap(1_000, 0)).toBe(false);
    expect(acceptTap(0, null)).toBe(true);
    const base = {
      phase: "listening" as const,
      now: 80_000,
      startedAt: 0,
      lastActivityAt: 0,
      userSpoke: false,
      agentSpoke: true,
      promptedStillThere: false,
      closing: false,
      initiator: "user" as const,
      closeAfterMs: 75_000,
    };
    expect(evaluateSilence({ ...base, now: 10_000 })).toBe("accidental_close");
    expect(evaluateSilence({ ...base, initiator: "proactive", now: 60_000 })).toBe("no_response");
    expect(evaluateSilence({ ...base, userSpoke: true, now: 20_000 })).toBe("still_there");
    expect(evaluateSilence({ ...base, userSpoke: true, promptedStillThere: true, now: 75_000 })).toBe("cost_close");
    expect(evaluateSilence({ ...base, phase: "speaking", userSpoke: true, now: 90_000 })).toBe("none");
    expect(evaluateSilence({ ...base, closing: true })).toBe("none");
    expect(evaluateSilence({ ...base, phase: "connecting", now: 30_000, startedAt: 0 })).toBe("give_up");
    expect(evaluateSilence({ ...base, phase: "thinking", now: 30_000, lastActivityAt: 20_000 })).toBe("none");
    expect(evaluateSilence({ ...base, phase: "thinking", now: 50_000, lastActivityAt: 0 })).toBe("give_up");
    expect(doseNudge(15 * 60_000, { at15: false, at20: false })).toBe("soft");
    expect(doseNudge(20 * 60_000, { at15: true, at20: false })).toBe("firm");
    expect(doseNudge(1_000, { at15: false, at20: false })).toBe("none");
  });

  it("respects a declined day and a retry window", () => {
    const now = new Date("2026-10-29T14:00:00.000Z");
    const empty = { localDate: "2026-10-29", attempts: 0, declined: false, engaged: false, nextRetryAt: null };
    expect(proactiveDecision({ now, timezone: "America/Montevideo", dailyTime: "11:00", enabled: false, day: empty, sessionActive: false }).start).toBe(false);
    expect(proactiveDecision({ now, timezone: "America/Montevideo", dailyTime: "11:00", enabled: true, day: empty, sessionActive: true }).reason).toContain("abierta");
    expect(proactiveDecision({ now, timezone: "America/Montevideo", dailyTime: "11:00", enabled: true, day: { ...empty, declined: true }, sessionActive: false }).start).toBe(false);
    expect(proactiveDecision({ now, timezone: "America/Montevideo", dailyTime: "11:00", enabled: true, day: { ...empty, engaged: true }, sessionActive: false }).start).toBe(false);
    expect(proactiveDecision({ now, timezone: "America/Montevideo", dailyTime: "11:00", enabled: true, day: empty, sessionActive: false })).toMatchObject({ start: true, mode: "first" });
    const retryAt = new Date(now.getTime() + 30 * 60_000).toISOString();
    const after = applyProactiveEvent(empty, "no_response", now);
    expect(after.nextRetryAt).toBe(retryAt);
    expect(applyProactiveEvent({ ...empty, attempts: 2 }, "no_response", now).nextRetryAt).toBeNull();
    expect(applyProactiveEvent(empty, "decline", now).declined).toBe(true);
    expect(applyProactiveEvent(empty, "engage", now).engaged).toBe(true);
    expect(applyProactiveEvent(empty, "attempt", now).attempts).toBe(1);
    const later = new Date(now.getTime() + 30 * 60_000);
    expect(
      proactiveDecision({
        now: later,
        timezone: "America/Montevideo",
        dailyTime: "11:00",
        enabled: true,
        day: { ...empty, attempts: 1, nextRetryAt: later.toISOString() },
        sessionActive: false,
      }).mode,
    ).toBe("retry");
  });

  it("flags two low days and ignores one", () => {
    const now = new Date("2026-10-29T14:00:00.000Z");
    const signal = (day: string, score: number): MoodSignal => ({
      id: day,
      sessionId: null,
      instrument: "phq2",
      itemId: "phq_down",
      rawAnswer: "bajo",
      score,
      note: "",
      createdAt: `${day}T12:00:00.000Z`,
    });
    expect(sustainedLowMood([signal("2026-10-20", 2), signal("2026-10-28", 3)], now)).toBe(true);
    expect(sustainedLowMood([signal("2026-10-28", 2)], now)).toBe(false);
    expect(sustainedLowMood([signal("2026-09-01", 3), signal("2026-10-28", 3)], now)).toBe(false);
    const alert: AlertRecord = {
      id: "a",
      sessionId: null,
      level: 3,
      kind: "suicide",
      reason: "x",
      excerpt: "x",
      createdAt: now.toISOString(),
      notifyStatus: "stub",
      notifyDetail: "",
    };
    expect(isRecentAlert([alert], "suicide", now, 60_000)).toBe(true);
    expect(isRecentAlert([alert], "emergency", now, 60_000)).toBe(false);
  });
});

describe("safety copy", () => {
  it("catches the risk phrases and leaves ordinary talk alone", () => {
    for (const line of suicide) {
      expect(assessUtterance(line).level, line).toBe(3);
      expect(assessUtterance(line).kind).toBe("suicide");
    }
    expect(assessUtterance("Me duele el pecho").kind).toBe("emergency");
    expect(assessUtterance("Hace días que no como").level).toBe(2);
    for (const line of neutral) expect(assessUtterance(line).level, line).toBe(0);
    expect(assessUtterance("   ").level).toBe(0);
    const script = safetyScript("suicide", "vos");
    expect(script).toContain("911");
    expect(script).toContain("0800 0767");
    expect(safetyScript("suicide", "usted")).toContain("911");
    expect(safetyScript("emergency", "vos")).toContain("911");
    expect(safetyScript("distress", "usted")).toContain("médico");
  });

  it("keeps adult replies free of elderspeak", () => {
    const clean = Array.from({ length: 50 }, (_, index) => `El punto ${index} del relato me parece claro y concreto.`);
    for (const line of clean) expect(findElderspeak(line)).toEqual([]);
    expect(findElderspeak("Hola querido, ¿cómo estamos, mi amor?")).toEqual(expect.arrayContaining(["querido", "como-estamos", "mi-amor"]));
    expect(findElderspeak("Vení, abuelita, corazón, tesoro, cielo, nena, chiquito, viejito, gordito")).toEqual(
      expect.arrayContaining(["abuelito", "corazon", "tesoro", "cielo", "nene", "chiquito", "viejito", "diminutivo"]),
    );
  });
});

describe("cost, prompt and notify", () => {
  it("prices cached audio as a subset", () => {
    const usage = {
      ...EMPTY_USAGE,
      inputAudio: 2_000_000,
      cachedAudio: 1_000_000,
      inputTokens: 2_000_000,
      totalTokens: 2_000_000,
    };
    expect(priceUsage("gpt-realtime-2.1-mini", usage, false).usd).toBe(10.3);
    expect(ratesFor("gpt-realtime-2.1").known).toBe(true);
    expect(ratesFor("gpt-realtime").known).toBe(true);
    expect(priceUsage("otro-modelo", usage, false).approximate).toBe(true);
    const summed = sumUsage("gpt-realtime-2.1-mini", [
      {
        input_tokens: 2_000_000,
        output_tokens: 0,
        total_tokens: 2_000_000,
        input_token_details: { audio_tokens: 2_000_000, text_tokens: 0, cached_tokens_details: { audio_tokens: 1_000_000, text_tokens: 0 } },
        output_token_details: { audio_tokens: 0, text_tokens: 0 },
      },
      null,
      { input_tokens: 10, output_tokens: 4 },
    ]);
    expect(summed.usage.cachedAudio).toBe(1_000_000);
    expect(summed.approximate).toBe(true);
    expect(talkRatio(0, 0)).toBeNull();
    expect(talkRatio(10, 20)).toBe(0.5);
    const csv = metricsToCsv([
      toMetrics({
        id: "=1",
        startedAt: "2026-10-29T14:00:00.000Z",
        endedAt: null,
        initiator: "user",
        module: "charla",
        status: "completed",
        transcript: [],
        summary: "hola",
        openThreads: [],
        durationSeconds: 60,
        userWords: 10,
        agentWords: 20,
        misunderstoodCount: 0,
        elderspeakHits: 0,
        usage: EMPTY_USAGE,
        costUsd: 0.1,
        costApproximate: false,
        model: "gpt-realtime-2.1-mini",
        voice: "marin",
        summarySource: null,
      } satisfies SessionRecord),
    ]);
    expect(csv.startsWith("id,")).toBe(true);
    expect(csv).toContain("'=1");
    const tally = tallyTranscript([
      { role: "user", text: "Me gusta el tango", at: "t" },
      { role: "assistant", text: "Se me cortó un poco, ¿me lo repetís, querido?", at: "t" },
    ]);
    expect(tally.misunderstood).toBe(1);
    expect(tally.elderspeakHits).toBeGreaterThan(0);
    expect(tally.userWords).toBe(4);
  });

  it("builds a bounded prompt", async () => {
    const profile: Profile = {
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
    };
    const facts = Array.from({ length: 5 }, (_, index) => ({
      id: String(index),
      category: "gusto" as const,
      content: `Hecho número ${index} sobre el tango`,
      createdAt: "t",
      sourceSessionId: null,
      source: "tool" as const,
    }));
    const memory = describeMemory(profile, facts);
    expect(memory.split(". ").length).toBeLessThanOrEqual(4);
    expect(memory).toContain("Elena");
    expect((memory.match(/Hecho número/g) ?? []).length).toBeLessThanOrEqual(1);
    expect(describeMemory({ ...profile, displayName: "", importantPeople: "", tastes: "" }, []).length).toBeGreaterThan(10);
    const assembled = assembleInstructions({
      profile,
      facts,
      summaries: [
        { startedAt: "2026-10-28T14:00:00.000Z", module: "charla", summary: "Hablaron de la rambla", openThreads: ["la rambla", "la rambla"] },
      ],
      microgoals: [{ id: "g", content: "Llamar a Lucía", status: "open", createdAt: "t", sessionId: null }],
      plan: {
        module: "mi_historia",
        reason: "Hoy toca mi_historia",
        theme: "un domingo",
        checkin: null,
        checkinLine: null,
      },
      dateLabel: "jueves 29 de octubre",
      maxFacts: 1,
    });
    expect(assembled.instructions).toContain("Elena");
    const shownFacts = ["0", "1", "2", "3", "4"].filter((index) => assembled.instructions.includes(`Hecho número ${index}`));
    expect(shownFacts).toHaveLength(1);
    expect(assembled.instructions).toContain("911");
    expect(assembled.instructions).toContain("Una sola pregunta por turno");
    expect(assembled.instructions.length).toBeLessThanOrEqual(12_000);
    expect(assembled.greetingCue).toContain("rambla");
    const intro = assembleInstructions({
      profile: { ...profile, userConsentAt: null, reducedHearing: true, memoryDeclinedAt: "t" },
      facts: [],
      summaries: [],
      microgoals: [],
      plan: { module: "charla", reason: "presentación", theme: "presentarse", checkin: null, checkinLine: null },
      dateLabel: "hoy",
      firstSession: true,
    });
    expect(intro.greetingCue).toContain("Soy Clara");
    expect(intro.greetingCue).toContain("sin agregar que sos una inteligencia artificial");
    expect(intro.greetingCue.toLowerCase()).not.toContain("guardar memoria");
    expect(intro.greetingCue).not.toContain("Presentate");
    expect(intro.instructions).toContain("te pregunten qué sos");
    expect(intro.instructions).not.toContain("pedí un sí");
    expect(intro.instructions).toContain("911");
    expect(await awaitNotify()).toContain("Aviso");
  });
});

async function awaitNotify(): Promise<string> {
  const stub = await dispatchAlert({
    webhookUrl: null,
    level: 3,
    reason: "idea",
    excerpt: "me quiero morir",
    elderName: "Elena",
    emergencyContact: "Lucía",
    at: "2026-10-29T14:00:00.000Z",
  });
  expect(stub.status).toBe("stub");
  const sent = await dispatchAlert({
    webhookUrl: "https://example.test/hook",
    level: 2,
    reason: "ánimo",
    excerpt: "bajo",
    elderName: "Elena",
    emergencyContact: "",
    at: "2026-10-29T14:00:00.000Z",
    fetchImpl: async () => new Response("ok", { status: 200 }),
  });
  expect(sent.status).toBe("sent");
  const failed = await dispatchAlert({
    webhookUrl: "https://example.test/hook",
    level: 3,
    reason: "idea",
    excerpt: "x",
    elderName: "Elena",
    emergencyContact: "",
    at: "t",
    fetchImpl: async () => new Response("no", { status: 500 }),
  });
  expect(failed.status).toBe("failed");
  const thrown = await dispatchAlert({
    webhookUrl: "https://example.test/hook",
    level: 3,
    reason: "idea",
    excerpt: "x",
    elderName: "Elena",
    emergencyContact: "",
    at: "t",
    fetchImpl: async () => {
      throw new Error("down");
    },
  });
  expect(thrown.status).toBe("failed");
  return sent.detail;
}

describe("pin and json", () => {
  it("locks the PIN and reads a body", async () => {
    expect(pinsMatch("2468", "2468")).toBe(true);
    expect(pinsMatch("2468", "0000")).toBe(false);
    let lock = { failures: 0, lockedUntil: 0 };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const result = assessPinAttempt({ expected: "2468", provided: "0000", now: 1_000, lock });
      expect(result.ok).toBe(false);
      if (!result.ok) lock = result.lock;
    }
    const locked = assessPinAttempt({ expected: "2468", provided: "2468", now: 1_000, lock });
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.status).toBe(429);
    const missingPin = assessPinAttempt({ expected: null, provided: "1", now: 0, lock: { failures: 0, lockedUntil: 0 } });
    expect(missingPin.ok).toBe(false);
    if (!missingPin.ok) expect(missingPin.status).toBe(503);
    const ok = assessPinAttempt({ expected: "2468", provided: "2468", now: 5_000, lock: { failures: 3, lockedUntil: 0 } });
    expect(ok.ok).toBe(true);
    const stamps = allowSessionMint([], 0, 1, 1_000);
    expect(allowSessionMint(stamps.stamps, 10, 1, 1_000).ok).toBe(false);
    expect(allowSessionMint(stamps.stamps, 5_000, 1, 1_000).ok).toBe(true);
    const request = new Request("http://local/x", { method: "POST", body: "{\"a\":1}" });
    expect(await readJson(request)).toEqual({ a: 1 });
    expect(await readJson(new Request("http://local/x", { method: "POST", body: " " }))).toEqual({});
    expect(await readJson(new Request("http://local/x", { method: "POST", body: "{" }))).toBeNull();
    expect(await readJson(new Request("http://local/x", { method: "POST", body: "x".repeat(400_001) }))).toBeNull();
    const guard = await withErrors(async () => {
      throw new Error("boom");
    });
    expect(guard.status).toBe(500);
    const { store, close } = await memoryDb();
    const deps = depsFor(store);
    expect(requirePin(deps, pinHeaders())).toBeNull();
    expect(requirePin(deps, new Headers())?.status).toBe(401);
    expect(pinHeader(new Headers({ "x-setup-pin": "  " }))).toBeNull();
    close();
  });
});
