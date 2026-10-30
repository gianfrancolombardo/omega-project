import type { AlertKind, AlertRecord } from "@/lib/domain";

export function isRecentAlert(alerts: AlertRecord[], kind: AlertKind, now: Date, windowMs: number): boolean {
  const cutoff = now.getTime() - windowMs;
  return alerts.some((alert) => alert.kind === kind && Date.parse(alert.createdAt) >= cutoff);
}
