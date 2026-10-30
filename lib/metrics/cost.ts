import type { NormalizedUsage } from "@/lib/domain";
import { EMPTY_USAGE } from "@/lib/domain";

type Rates = {
  audioIn: number;
  audioCached: number;
  audioOut: number;
  textIn: number;
  textCached: number;
  textOut: number;
};

const MINI: Rates = {
  audioIn: 10,
  audioCached: 0.3,
  audioOut: 20,
  textIn: 0.6,
  textCached: 0.06,
  textOut: 2.4,
};

const FLAGSHIP: Rates = {
  audioIn: 32,
  audioCached: 0.4,
  audioOut: 64,
  textIn: 4,
  textCached: 0.4,
  textOut: 24,
};

export function ratesFor(model: string): { rates: Rates; known: boolean } {
  if (model.includes("mini")) return { rates: MINI, known: true };
  if (model.startsWith("gpt-realtime-2.1") || model.startsWith("gpt-realtime-2")) {
    return { rates: FLAGSHIP, known: true };
  }
  if (model.startsWith("gpt-realtime")) return { rates: FLAGSHIP, known: true };
  return { rates: MINI, known: false };
}

function readNumber(source: unknown, keys: string[]): number {
  if (!source || typeof source !== "object") return 0;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

export function normalizeUsage(raw: unknown): { usage: NormalizedUsage; detailsMissing: boolean } | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const inputDetails = record.input_token_details ?? record.inputTokenDetails;
  const outputDetails = record.output_token_details ?? record.outputTokenDetails;
  const cachedDetails =
    inputDetails && typeof inputDetails === "object"
      ? ((inputDetails as Record<string, unknown>).cached_tokens_details ??
        (inputDetails as Record<string, unknown>).cachedTokensDetails)
      : undefined;
  const inputText = readNumber(inputDetails, ["text_tokens", "textTokens"]);
  const inputAudio = readNumber(inputDetails, ["audio_tokens", "audioTokens"]);
  const cachedText = readNumber(cachedDetails, ["text_tokens", "textTokens"]);
  const cachedAudio = readNumber(cachedDetails, ["audio_tokens", "audioTokens"]);
  const outputText = readNumber(outputDetails, ["text_tokens", "textTokens"]);
  const outputAudio = readNumber(outputDetails, ["audio_tokens", "audioTokens"]);
  const inputTokens = readNumber(record, ["input_tokens", "inputTokens"]);
  const outputTokens = readNumber(record, ["output_tokens", "outputTokens"]);
  const totalTokens = readNumber(record, ["total_tokens", "totalTokens"]) || inputTokens + outputTokens;
  const detailsMissing = !inputDetails && !outputDetails;
  return {
    detailsMissing,
    usage: {
      inputText,
      inputAudio: detailsMissing ? inputTokens : inputAudio,
      cachedText,
      cachedAudio: detailsMissing ? readNumber(inputDetails, ["cached_tokens", "cachedTokens"]) : cachedAudio,
      outputText,
      outputAudio: detailsMissing ? outputTokens : outputAudio,
      inputTokens,
      outputTokens,
      totalTokens,
    },
  };
}

export function addUsage(left: NormalizedUsage, right: NormalizedUsage): NormalizedUsage {
  return {
    inputText: left.inputText + right.inputText,
    inputAudio: left.inputAudio + right.inputAudio,
    cachedText: left.cachedText + right.cachedText,
    cachedAudio: left.cachedAudio + right.cachedAudio,
    outputText: left.outputText + right.outputText,
    outputAudio: left.outputAudio + right.outputAudio,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

export function priceUsage(model: string, usage: NormalizedUsage, detailsMissing: boolean): { usd: number; approximate: boolean } {
  const { rates, known } = ratesFor(model);
  const uncachedAudio = Math.max(0, usage.inputAudio - usage.cachedAudio);
  const uncachedText = Math.max(0, usage.inputText - usage.cachedText);
  const usd =
    (uncachedAudio * rates.audioIn +
      usage.cachedAudio * rates.audioCached +
      usage.outputAudio * rates.audioOut +
      uncachedText * rates.textIn +
      usage.cachedText * rates.textCached +
      usage.outputText * rates.textOut) /
    1_000_000;
  return { usd: Math.round(usd * 1_000_000) / 1_000_000, approximate: detailsMissing || !known };
}

export function sumUsage(model: string, events: unknown[]): { usage: NormalizedUsage; usd: number; approximate: boolean } {
  let usage = { ...EMPTY_USAGE };
  let approximate = false;
  for (const event of events) {
    const normalized = normalizeUsage(event);
    if (!normalized) continue;
    usage = addUsage(usage, normalized.usage);
    approximate = approximate || normalized.detailsMissing;
  }
  const priced = priceUsage(model, usage, approximate);
  return { usage, usd: priced.usd, approximate: priced.approximate };
}
