import { createHash } from "node:crypto";

import { MISSING_KEY_MESSAGE } from "@/lib/copy";
import { REALTIME_TOOLS } from "@/lib/prompt/tools";

export const CLIENT_SECRET_URL = "https://api.openai.com/v1/realtime/client_secrets";

export type MintInput = {
  apiKey: string | null;
  model: string;
  voice: string;
  speed: number;
  transcriptionModel: string;
  noiseReduction: "near_field" | "far_field";
  instructions: string;
  transcriptionPrompt?: string;
};

export type ClientSecretRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

export function safetyIdentifier(apiKey: string): string {
  return createHash("sha256").update(`charla:${apiKey}`).digest("hex").slice(0, 32);
}

export function buildClientSecretRequest(input: MintInput & { apiKey: string }): ClientSecretRequest {
  return {
    url: CLIENT_SECRET_URL,
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": safetyIdentifier(input.apiKey),
    },
    body: {
      expires_after: { anchor: "created_at", seconds: 600 },
      session: {
        type: "realtime",
        model: input.model,
        instructions: input.instructions,
        tools: REALTIME_TOOLS,
        tool_choice: "auto",
        output_modalities: ["audio"],
        audio: {
          input: {
            noise_reduction: { type: input.noiseReduction },
            transcription: {
              model: input.transcriptionModel,
              language: "es",
              ...(input.transcriptionPrompt ? { prompt: input.transcriptionPrompt } : {}),
            },
            turn_detection: {
              type: "semantic_vad",
              eagerness: "low",
              create_response: true,
              interrupt_response: true,
            },
          },
          output: { voice: input.voice, speed: input.speed },
        },
      },
    },
  };
}

export type MintResult =
  | { ok: true; value: string; expiresAt: string | null }
  | { ok: false; status: number; code: string; message: string };

function redact(text: string, secret: string): string {
  return text.split(secret).join("[redacted]");
}

function readSecret(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.value === "string") return record.value;
  const nested = record.client_secret;
  if (nested && typeof nested === "object") {
    const value = (nested as Record<string, unknown>).value;
    if (typeof value === "string") return value;
  }
  return null;
}

function readExpiry(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const expires = (payload as Record<string, unknown>).expires_at;
  return typeof expires === "string" ? expires : null;
}

const VOICE_DOWN = "No pude abrir la voz. Probá de nuevo en un momento.";

export async function mintClientSecret(input: MintInput, fetchImpl: typeof fetch): Promise<MintResult> {
  if (!input.apiKey) {
    return { ok: false, status: 503, code: "missing_api_key", message: MISSING_KEY_MESSAGE };
  }
  const request = buildClientSecretRequest({ ...input, apiKey: input.apiKey });
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "network";
    return {
      ok: false,
      status: 502,
      code: "openai_unreachable",
      message: redact(message, input.apiKey).slice(0, 180) || VOICE_DOWN,
    };
  }

  const raw = await response.text();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: 502,
        code: "openai_rejected",
        message: "OpenAI rechazó la clave. Revisá OPENAI_API_KEY en el servidor.",
      };
    }
    return { ok: false, status: 502, code: "openai_error", message: VOICE_DOWN };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, status: 502, code: "openai_error", message: VOICE_DOWN };
  }
  const value = readSecret(payload);
  if (!value || !value.startsWith("ek_") || value.includes(input.apiKey)) {
    return { ok: false, status: 502, code: "openai_error", message: VOICE_DOWN };
  }
  return { ok: true, value, expiresAt: readExpiry(payload) };
}
