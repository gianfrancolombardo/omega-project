import type { AlertKind, AlertRecord } from "@/lib/domain";
import type { AppDeps } from "@/lib/http/deps";
import { dispatchAlert } from "@/lib/notify";
import { isRecentAlert } from "@/lib/safety/dedupe";

export async function recordSafetyAlert(
  deps: AppDeps,
  input: {
    sessionId: string | null;
    level: 2 | 3;
    kind: AlertKind;
    reason: string;
    excerpt: string;
    windowMs?: number;
  },
): Promise<AlertRecord | null> {
  const alerts = await deps.store.listAlerts(30);
  if (isRecentAlert(alerts, input.kind, deps.now(), input.windowMs ?? 10 * 60 * 1000)) return null;
  const profile = await deps.store.getProfile();
  const contact = [profile.emergencyName, profile.emergencyRelation, profile.emergencyPhone].filter(Boolean).join(" · ");
  const notify = await dispatchAlert({
    webhookUrl: deps.config.notifyWebhookUrl,
    level: input.level,
    reason: input.reason,
    excerpt: input.excerpt,
    elderName: profile.displayName,
    emergencyContact: contact,
    at: deps.now().toISOString(),
    fetchImpl: deps.fetchImpl,
  });
  return deps.store.addAlert({
    sessionId: input.sessionId,
    level: input.level,
    kind: input.kind,
    reason: input.reason.slice(0, 300),
    excerpt: input.excerpt.slice(0, 500),
    notifyStatus: notify.status,
    notifyDetail: notify.detail,
  });
}
