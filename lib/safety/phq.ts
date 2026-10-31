import type { MoodSignal } from "@/lib/domain";

function sessionKey(signal: MoodSignal): string {
  return signal.sessionId || signal.createdAt.slice(0, 10);
}

export function phq2SumsBySession(signals: MoodSignal[], cutoffMs: number): Map<string, number> {
  const sums = new Map<string, number>();
  for (const signal of signals) {
    if (signal.instrument !== "phq2" || signal.score == null) continue;
    const at = Date.parse(signal.createdAt);
    if (!Number.isFinite(at) || at < cutoffMs) continue;
    const key = sessionKey(signal);
    sums.set(key, (sums.get(key) ?? 0) + signal.score);
  }
  return sums;
}

export function sustainedLowMood(signals: MoodSignal[], now: Date): boolean {
  const cutoff = now.getTime() - 21 * 24 * 60 * 60 * 1000;
  const sums = phq2SumsBySession(signals, cutoff);
  const values = [...sums.values()];
  if (values.some((sum) => sum >= 6)) return true;
  return values.filter((sum) => sum >= 3).length >= 2;
}

export function threeLowMoodDays(signals: MoodSignal[]): boolean {
  const byDay = new Map<string, number>();
  for (const signal of signals) {
    if (signal.instrument !== "daily" || signal.score == null) continue;
    const day = signal.createdAt.slice(0, 10);
    byDay.set(day, signal.score);
  }
  const days = [...byDay.entries()].sort((left, right) => left[0].localeCompare(right[0]));
  if (days.length < 3) return false;
  const last = days.slice(-3);
  if (!last.every(([, score]) => score <= 2)) return false;
  const times = last.map(([day]) => Date.parse(`${day}T00:00:00.000Z`));
  return times[1] - times[0] === 86_400_000 && times[2] - times[1] === 86_400_000;
}
