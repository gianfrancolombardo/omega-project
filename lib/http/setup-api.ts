import { memoryPersistence } from "@/lib/env";
import type { AppDeps } from "@/lib/http/deps";
import type { HttpResult } from "@/lib/http/guard";
import { requirePin } from "@/lib/http/guard";
import { toMetrics } from "@/lib/metrics/csv";
import { parseFactInput, parseProfilePatch } from "@/lib/profile";
import { toPublicProfile } from "@/lib/profile-public";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export async function handleHealth(deps: AppDeps): Promise<HttpResult> {
  const persistence = memoryPersistence(deps.config);
  return {
    status: 200,
    body: {
      openai: Boolean(deps.config.openAiApiKey),
      pin: Boolean(deps.config.setupPin),
      store: persistence.store,
      persistent: persistence.persistent,
    },
  };
}

export async function handlePublicProfile(deps: AppDeps, headers: Headers): Promise<HttpResult> {
  const denied = requirePin(deps, headers);
  if (denied) return denied;
  const profile = await deps.store.getProfile();
  return { status: 200, body: toPublicProfile(profile) };
}

export async function handleSetupGet(deps: AppDeps, headers: Headers): Promise<HttpResult> {
  const denied = requirePin(deps, headers);
  if (denied) return denied;
  const [profile, facts, alerts, sessions, microgoals] = await Promise.all([
    deps.store.getProfile(),
    deps.store.listFacts(),
    deps.store.listAlerts(30),
    deps.store.listSessions(30),
    deps.store.listOpenMicrogoals(),
  ]);
  const persistence = memoryPersistence(deps.config);
  return {
    status: 200,
    body: {
      profile,
      facts,
      alerts,
      metrics: sessions.map(toMetrics),
      microgoals,
      persistence,
      persistenceWarning: persistence.persistent
        ? null
        : "Esta copia guarda la memoria en un disco que se borra en cada despliegue. Para que dure, configurá DATABASE_URL.",
    },
  };
}

export async function handleSetupPut(deps: AppDeps, headers: Headers, body: unknown): Promise<HttpResult> {
  const denied = requirePin(deps, headers);
  if (denied) return denied;
  const record = asRecord(body);
  if (typeof record?.rememberEnabled === "boolean") {
    const current = await deps.store.getProfile();
    const declined = Boolean(current.memoryDeclinedAt);
    const wantDecline = !record.rememberEnabled;
    if (declined !== wantDecline) {
      await deps.store.recordConsent(deps.now().toISOString(), !wantDecline);
    }
  }
  const parsed = parseProfilePatch(body);
  if (!parsed.ok) return { status: 400, body: { error: "invalid_profile", message: parsed.message } };
  const profile = await deps.store.updateProfile(parsed.value);
  return { status: 200, body: { profile } };
}

export async function handleSetupPost(deps: AppDeps, headers: Headers, body: unknown): Promise<HttpResult> {
  const denied = requirePin(deps, headers);
  if (denied) return denied;
  const record = asRecord(body);
  const action = typeof record?.action === "string" ? record.action : "";

  if (action === "add_fact") {
    const parsed = parseFactInput(record);
    if (!parsed.ok) return { status: 400, body: { error: "invalid_fact", message: parsed.message } };
    const saved = await deps.store.addFact({
      category: parsed.category,
      content: parsed.content,
      source: "setup",
    });
    if (!saved.ok) return { status: 400, body: { error: "invalid_fact", message: "No guardo medicación ni diagnósticos." } };
    return { status: 200, body: { fact: saved.fact, created: saved.created } };
  }

  if (action === "delete_fact") {
    const id = typeof record?.id === "string" ? record.id : "";
    if (!id) return { status: 400, body: { error: "invalid_fact", message: "Falta el recuerdo." } };
    const deleted = await deps.store.deleteFact(id);
    return { status: 200, body: { deleted } };
  }

  if (action === "clear_memory") {
    if (record?.confirm !== "BORRAR") {
      return { status: 400, body: { error: "confirm", message: "Para borrar la memoria, escribí BORRAR." } };
    }
    await deps.store.clearMemory(deps.now().toISOString());
    return { status: 200, body: { cleared: true } };
  }

  return { status: 400, body: { error: "bad_request", message: "No entiendo esa acción." } };
}
