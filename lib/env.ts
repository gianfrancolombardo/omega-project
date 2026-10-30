import path from "node:path";

import { isValidTimeZone } from "@/lib/time";

export const DEFAULT_REALTIME_MODEL = "gpt-realtime-2.1-mini";
export const DEFAULT_VOICE = "marin";
export const DEFAULT_SUMMARY_MODEL = "gpt-5.4-mini";
export const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
export const DEFAULT_TIMEZONE = "America/Montevideo";

export type AppConfig = {
  openAiApiKey: string | null;
  realtimeModel: string;
  voice: string;
  voiceSpeed: number;
  summaryModel: string;
  transcriptionModel: string;
  databaseUrl: string | null;
  setupPin: string | null;
  timezone: string;
  dbPath: string;
  notifyWebhookUrl: string | null;
  silenceCloseSeconds: number;
  noiseReduction: "near_field" | "far_field";
  ephemeral: boolean;
};

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function numberOr(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function clampVoiceSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 0.92;
  return Math.min(1.5, Math.max(0.25, speed));
}

export function clampSilenceSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return 75;
  return Math.min(90, Math.max(60, Math.round(seconds)));
}

export function parseEnv(source: Record<string, string | undefined>): AppConfig {
  const timezoneCandidate = clean(source.APP_TIMEZONE) ?? DEFAULT_TIMEZONE;
  const timezone = isValidTimeZone(timezoneCandidate) ? timezoneCandidate : DEFAULT_TIMEZONE;
  const noise = clean(source.OPENAI_NOISE_REDUCTION);
  return {
    openAiApiKey: clean(source.OPENAI_API_KEY),
    realtimeModel: clean(source.OPENAI_REALTIME_MODEL) ?? DEFAULT_REALTIME_MODEL,
    voice: clean(source.OPENAI_VOICE) ?? DEFAULT_VOICE,
    voiceSpeed: clampVoiceSpeed(numberOr(source.OPENAI_VOICE_SPEED, 0.92)),
    summaryModel: clean(source.OPENAI_SUMMARY_MODEL) ?? DEFAULT_SUMMARY_MODEL,
    transcriptionModel: clean(source.OPENAI_TRANSCRIPTION_MODEL) ?? DEFAULT_TRANSCRIPTION_MODEL,
    databaseUrl: clean(source.DATABASE_URL),
    setupPin: clean(source.SETUP_PIN),
    timezone,
    dbPath: clean(source.CHARLA_DB_PATH) ?? path.join(process.cwd(), "data", "charla.sqlite"),
    notifyWebhookUrl: clean(source.NOTIFY_WEBHOOK_URL),
    silenceCloseSeconds: clampSilenceSeconds(numberOr(source.SILENCE_CLOSE_SECONDS, 75)),
    noiseReduction: noise === "near_field" ? "near_field" : "far_field",
    ephemeral: isEphemeralRuntime(source),
  };
}

function isEphemeralRuntime(source: Record<string, string | undefined>): boolean {
  return source.VERCEL === "1" || source.NETLIFY === "true" || Boolean(source.AWS_LAMBDA_FUNCTION_NAME?.trim());
}

export function memoryPersistence(config: AppConfig): {
  store: "postgres" | "sqlite";
  persistent: boolean;
} {
  if (config.databaseUrl) return { store: "postgres", persistent: true };
  return { store: "sqlite", persistent: !config.ephemeral };
}
