import { describe, expect, it } from "vitest";

import { buildClientSecretRequest, mintClientSecret } from "@/lib/openai/mint";
import { extractResponseText, fallbackSummary, parseSummaryJson, shouldAlertFromSummary, summarizeSession } from "@/lib/openai/summarize";
import { MISSING_KEY_MESSAGE } from "@/lib/copy";

describe("mint", () => {
  it("does not call the network without a key", async () => {
    let called = false;
    const result = await mintClientSecret(
      {
        apiKey: null,
        model: "gpt-realtime-2.1-mini",
        voice: "marin",
        speed: 0.92,
        transcriptionModel: "gpt-4o-mini-transcribe",
        noiseReduction: "far_field",
        instructions: "Elena",
      },
      async () => {
        called = true;
        return new Response("no");
      },
    );
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe(MISSING_KEY_MESSAGE);
  });

  it("sends semantic vad and hides a rejected key", async () => {
    const request = buildClientSecretRequest({
      apiKey: "sk-test-secret",
      model: "gpt-realtime-2.1-mini",
      voice: "marin",
      speed: 0.92,
      transcriptionModel: "gpt-4o-mini-transcribe",
      noiseReduction: "far_field",
      instructions: "Le gusta el tango",
    });
    const session = request.body.session as {
      model: string;
      audio: { input: { turn_detection: { type: string; eagerness: string } }; output: { voice: string } };
    };
    expect(session.model).toBe("gpt-realtime-2.1-mini");
    expect(session.audio.input.turn_detection).toMatchObject({ type: "semantic_vad", eagerness: "low" });
    expect(session.audio.output.voice).toBe("marin");
    const withHint = buildClientSecretRequest({
      apiKey: "sk-test-secret",
      model: "gpt-realtime-2.1-mini",
      voice: "marin",
      speed: 0.92,
      transcriptionModel: "gpt-4o-mini-transcribe",
      noiseReduction: "far_field",
      instructions: "Le gusta el tango",
      transcriptionPrompt: "Elena, Lucía, Troilo, Pocitos",
    });
    expect(JSON.stringify(withHint.body)).toContain("Elena, Lucía, Troilo, Pocitos");
    expect(JSON.stringify(request.body)).toContain("Le gusta el tango");
    expect(request.headers.Authorization).toBe("Bearer sk-test-secret");
    const rejected = await mintClientSecret(
      {
        apiKey: "sk-test-secret",
        model: "gpt-realtime-2.1-mini",
        voice: "marin",
        speed: 0.92,
        transcriptionModel: "gpt-4o-mini-transcribe",
        noiseReduction: "far_field",
        instructions: "hola",
      },
      async () => new Response("sk-test-secret invalid", { status: 401 }),
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.message).not.toContain("sk-test-secret");
      expect(rejected.code).toBe("openai_rejected");
    }
    const nested = await mintClientSecret(
      {
        apiKey: "sk-test-secret",
        model: "m",
        voice: "marin",
        speed: 1,
        transcriptionModel: "t",
        noiseReduction: "near_field",
        instructions: "hola",
      },
      async () => new Response(JSON.stringify({ client_secret: { value: "ek_nested" }, expires_at: "soon" }), { status: 200 }),
    );
    expect(nested.ok && nested.value).toBe("ek_nested");
    const bad = await mintClientSecret(
      {
        apiKey: "sk-test-secret",
        model: "m",
        voice: "marin",
        speed: 1,
        transcriptionModel: "t",
        noiseReduction: "far_field",
        instructions: "hola",
      },
      async () => new Response("not-json", { status: 200 }),
    );
    expect(bad.ok).toBe(false);
    const down = await mintClientSecret(
      {
        apiKey: "sk-test-secret",
        model: "m",
        voice: "marin",
        speed: 1,
        transcriptionModel: "t",
        noiseReduction: "far_field",
        instructions: "hola",
      },
      async () => {
        throw new Error("sk-test-secret down");
      },
    );
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.message).not.toContain("sk-test-secret");
  });
});

describe("summary", () => {
  it("parses model json and falls back without inventing facts", async () => {
    const fenced = "```json\n{\"summary\":\"Habló del tango\",\"open_threads\":[\"tango\"],\"facts\":[{\"category\":\"gusto\",\"content\":\"Le gusta Troilo\"}],\"concern\":null}\n```";
    expect(parseSummaryJson(fenced)?.facts[0].content).toContain("Troilo");
    expect(parseSummaryJson("no")).toBeNull();
    expect(extractResponseText({ output_text: "hola" })).toBe("hola");
    expect(extractResponseText({ output: [{ content: [{ text: "uno" }, { text: "dos" }] }] })).toBe("uno\ndos");
    expect(extractResponseText(null)).toBe("");
    const fallback = fallbackSummary([{ role: "user", text: "Me gusta el río", at: "t" }]);
    expect(fallback.facts).toEqual([]);
    expect(fallback.summary).toContain("río");
    expect(shouldAlertFromSummary({ level: 3, reason: "idea", excerpt: "me quiero morir" })?.kind).toBe("suicide");
    expect(
      shouldAlertFromSummary({
        level: 2,
        kind: "concern",
        reason: "ya no le encuentra sentido",
        excerpt: "dice que ya no le encuentra sentido a nada",
      }),
    ).toMatchObject({ level: 2, kind: "concern" });
    expect(shouldAlertFromSummary({ level: 3, reason: "ruido", excerpt: "me gusta el té" })?.level).toBe(3);
    expect(shouldAlertFromSummary(null)).toBeNull();
    const produced = await summarizeSession({
      apiKey: "sk-test",
      model: "gpt-5.4-mini",
      turns: [{ role: "user", text: "Me gusta el tango", at: "t" }],
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              summary: "Contó que le gusta el tango.",
              open_threads: ["tango"],
              facts: [{ category: "gusto", content: "Le gusta el tango" }, { category: "nope", content: "x" }],
              concern: { level: 2, reason: "hace días que no duerme", excerpt: "hace días que no duermo" },
            }),
          }),
          { status: 200 },
        ),
    });
    expect(produced.source).toBe("model");
    expect(produced.facts).toHaveLength(1);
    expect(shouldAlertFromSummary(produced.concern)?.level).toBe(2);
    const failed = await summarizeSession({
      apiKey: "sk-test",
      model: "gpt-5.4-mini",
      turns: [],
      fetchImpl: async () => {
        throw new Error("down");
      },
    });
    expect(failed.source).toBe("fallback");
    expect(failed.facts).toEqual([]);
    const noKey = await summarizeSession({ apiKey: null, model: "m", turns: [], fetchImpl: fetch });
    expect(noKey.source).toBe("fallback");
  });
});
