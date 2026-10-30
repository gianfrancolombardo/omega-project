import type { SessionInitiator } from "@/lib/domain";

export const STILL_THERE_MS = 20_000;
export const ACCIDENTAL_MS = 10_000;
export const PROACTIVE_WAIT_MS = 60_000;
export const TAP_DEBOUNCE_MS = 1_500;

export type SilencePhase = "connecting" | "listening" | "thinking" | "speaking";

export type SilenceAction = "none" | "still_there" | "accidental_close" | "no_response" | "cost_close" | "give_up";

export function acceptTap(now: number, lastAcceptedAt: number | null, debounceMs = TAP_DEBOUNCE_MS): boolean {
  if (lastAcceptedAt == null) return true;
  return now - lastAcceptedAt >= debounceMs;
}

export function evaluateSilence(input: {
  phase: SilencePhase;
  now: number;
  startedAt: number;
  lastActivityAt: number;
  userSpoke: boolean;
  agentSpoke: boolean;
  promptedStillThere: boolean;
  closing: boolean;
  initiator: SessionInitiator;
  closeAfterMs: number;
}): SilenceAction {
  if (input.closing) return "none";
  const idle = input.now - input.lastActivityAt;
  if (input.phase === "connecting") {
    return input.now - input.startedAt > 25_000 ? "give_up" : "none";
  }
  if (input.phase === "thinking") {
    return input.now - input.lastActivityAt > 25_000 ? "give_up" : "none";
  }
  if (input.phase !== "listening") return "none";
  if (!input.userSpoke && input.agentSpoke && input.initiator === "proactive" && idle >= PROACTIVE_WAIT_MS) {
    return "no_response";
  }
  if (!input.userSpoke && input.agentSpoke && input.initiator === "user" && idle >= ACCIDENTAL_MS) {
    return "accidental_close";
  }
  if (input.userSpoke && idle >= input.closeAfterMs) return "cost_close";
  if (input.userSpoke && !input.promptedStillThere && idle >= STILL_THERE_MS) return "still_there";
  return "none";
}

export function doseNudge(elapsedMs: number, sent: { at15: boolean; at20: boolean }): "none" | "soft" | "firm" {
  if (!sent.at20 && elapsedMs >= 20 * 60_000) return "firm";
  if (!sent.at15 && elapsedMs >= 15 * 60_000) return "soft";
  return "none";
}
