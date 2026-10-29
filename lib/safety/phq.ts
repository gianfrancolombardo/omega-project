import type { MoodSignal } from "@/lib/domain";

export function sustainedLowMood(signals: MoodSignal[], now: Date): boolean {
  const cutoff = now.getTime() - 21 * 24 * 60 * 60 * 1000;
  const days = new Set<string>();
  for (const signal of signals) {
    if (signal.instrument !== "phq2" || signal.score == null || signal.score < 2) continue;
    const at = Date.parse(signal.createdAt);
    if (!Number.isFinite(at) || at < cutoff) continue;
    days.add(signal.createdAt.slice(0, 10));
  }
  return days.size >= 2;
}
