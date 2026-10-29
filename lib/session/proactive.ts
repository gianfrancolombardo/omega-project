import type { ProactiveDay, ProactiveEvent } from "@/lib/domain";
import { dailyInstant, isWithinWindow } from "@/lib/time";

export const DAILY_WINDOW_MS = 10 * 60 * 1000;
export const PROACTIVE_RETRY_MS = 30 * 60 * 1000;

export function applyProactiveEvent(day: ProactiveDay, event: ProactiveEvent, now: Date): ProactiveDay {
  if (event === "attempt") {
    return { ...day, attempts: day.attempts + 1, nextRetryAt: null };
  }
  if (event === "decline") {
    return { ...day, declined: true, nextRetryAt: null };
  }
  if (event === "engage") {
    return { ...day, engaged: true, nextRetryAt: null };
  }
  if (day.attempts >= 2 || day.declined || day.engaged) return day;
  return {
    ...day,
    nextRetryAt: new Date(now.getTime() + PROACTIVE_RETRY_MS).toISOString(),
  };
}

export type ProactiveDecision = {
  start: boolean;
  mode: "first" | "retry" | null;
  reason: string;
};

export function proactiveDecision(input: {
  now: Date;
  timezone: string;
  dailyTime: string;
  enabled: boolean;
  day: ProactiveDay;
  sessionActive: boolean;
}): ProactiveDecision {
  if (!input.enabled) return { start: false, mode: null, reason: "La charla del día está apagada." };
  if (input.sessionActive) return { start: false, mode: null, reason: "Ya hay una charla abierta." };
  if (input.day.declined) return { start: false, mode: null, reason: "Hoy dijeron que ahora no." };
  if (input.day.engaged) return { start: false, mode: null, reason: "Hoy ya hubo una charla de la hora pactada." };
  if (input.day.attempts === 0 && isWithinWindow(input.now, dailyInstant(input.now, input.timezone, input.dailyTime), DAILY_WINDOW_MS)) {
    return { start: true, mode: "first", reason: "Es la hora pactada." };
  }
  if (input.day.attempts === 1 && input.day.nextRetryAt) {
    const retryAt = new Date(input.day.nextRetryAt);
    if (isWithinWindow(input.now, retryAt, DAILY_WINDOW_MS)) {
      return { start: true, mode: "retry", reason: "Reintento después de un silencio." };
    }
  }
  return { start: false, mode: null, reason: "Todavía no es el horario." };
}
