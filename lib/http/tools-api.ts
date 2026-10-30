import type { AlertKind, MoodInstrument, SessionStatus } from "@/lib/domain";
import type { AppDeps } from "@/lib/http/deps";
import { recordSafetyAlert } from "@/lib/http/alerts";
import type { HttpResult } from "@/lib/http/guard";
import { requirePin } from "@/lib/http/guard";
import { parseFactInput } from "@/lib/profile";
import { describeMemory } from "@/lib/prompt/assemble";
import { assessUtterance, safetyScript } from "@/lib/safety/assess";
import { sustainedLowMood } from "@/lib/safety/phq";
import { localDateInZone } from "@/lib/time";

const MOODS: MoodInstrument[] = ["ucla3", "who5", "phq2", "daily"];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toolArgs(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return toolArgs(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return asRecord(value) ?? {};
}

function text(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function toolResult(output: string, hangup: SessionStatus | null = null): HttpResult {
  return { status: 200, body: { output, hangup } };
}

export async function handleTool(deps: AppDeps, headers: Headers, body: unknown): Promise<HttpResult> {
  const denied = requirePin(deps, headers);
  if (denied) return denied;
  const record = asRecord(body);
  const token = text(record?.sessionToken, 200);
  const name = text(record?.name, 80);
  if (!token || !name) return { status: 400, body: { error: "bad_request", message: "Falta la herramienta." } };
  const session = await deps.store.getSessionByToken(token);
  if (!session || session.status !== "active") {
    return { status: 401, body: { error: "unknown_session", message: "No encuentro esa charla." } };
  }
  const args = toolArgs(record?.arguments);
  const profile = await deps.store.getProfile();
  const now = deps.now();

  if (name === "remember_fact") {
    if (!profile.userConsentAt || profile.memoryDeclinedAt) {
      return toolResult("No hay permiso para guardar. No digas que lo guardaste.");
    }
    const parsed = parseFactInput({ category: args.category, content: args.content });
    if (!parsed.ok) return toolResult(parsed.message);
    const saved = await deps.store.addFact({
      category: parsed.category,
      content: parsed.content,
      source: "tool",
      sourceSessionId: session.id,
    });
    if (!saved.ok) return toolResult("No guardo medicación ni diagnósticos.");
    return toolResult(saved.created ? `Guardado: ${saved.fact.content}` : `Eso ya estaba: ${saved.fact.content}`);
  }

  if (name === "recall_facts") {
    const facts = await deps.store.searchFacts(text(args.query, 200), 5);
    if (!facts.length) return toolResult("No hay un recuerdo que coincida. No lo inventes.");
    return toolResult(facts.map((fact) => `(${fact.category}) ${fact.content}`).join(" | "));
  }

  if (name === "forget_fact") {
    const forgotten = await deps.store.forgetFact(text(args.query, 200) || "ultimo");
    if (!forgotten) {
      return toolResult(
        "No encontré ese recuerdo suelto. Si está en la ficha que cargó la familia, se borra desde la configuración. Decilo así.",
      );
    }
    return toolResult(`Borré este recuerdo: ${forgotten.content}`);
  }

  if (name === "what_do_you_know") {
    const facts = await deps.store.listFacts();
    return toolResult(describeMemory(profile, facts));
  }

  if (name === "log_mood") {
    const instrument = MOODS.find((item) => item === args.instrument);
    if (!instrument) return toolResult("No registré la señal: falta el instrumento.");
    const rawAnswer = text(args.raw_answer, 300);
    if (!rawAnswer) return toolResult("No registré la señal: falta la respuesta.");
    const score = typeof args.score === "number" && Number.isFinite(args.score) ? Math.min(5, Math.max(0, args.score)) : null;
    await deps.store.addMood({
      sessionId: session.id,
      instrument,
      itemId: text(args.item_id, 80) || instrument,
      rawAnswer,
      score,
      note: text(args.note, 300),
    });
    const moods = await deps.store.listMood(40);
    if (sustainedLowMood(moods, now)) {
      await recordSafetyAlert(deps, {
        sessionId: session.id,
        level: 2,
        kind: "distress",
        reason: "Dos señales PHQ-2 altas en días distintos. No es un diagnóstico.",
        excerpt: rawAnswer,
        windowMs: 7 * 24 * 60 * 60 * 1000,
      });
    }
    return toolResult("Señal guardada. No es un diagnóstico. Seguí la charla con naturalidad, una sola pregunta.");
  }

  if (name === "save_microgoal") {
    const content = text(args.content, 240);
    if (content.length < 2) return toolResult("La micro-meta es demasiado corta.");
    const goal = await deps.store.addMicrogoal(content, session.id);
    return toolResult(`Micro-meta guardada: ${goal.content}`);
  }

  if (name === "complete_microgoal") {
    const goal = await deps.store.completeMicrogoal(text(args.query, 200) || "ultimo");
    if (!goal) return toolResult("No encontré esa micro-meta abierta.");
    return toolResult(`Marqué hecha: ${goal.content}`);
  }

  if (name === "flag_concern") {
    const reason = text(args.reason, 300) || "Preocupación marcada en la charla";
    const excerpt = text(args.excerpt, 500);
    const scan = assessUtterance(`${excerpt} ${reason}`);
    const level: 2 | 3 = args.level === 3 || scan.level === 3 ? 3 : 2;
    const kind: AlertKind = scan.kind === "none" ? "concern" : scan.kind;
    const saved = await recordSafetyAlert(deps, { sessionId: session.id, level, kind, reason, excerpt });
    const script =
      level === 3
        ? safetyScript(kind === "suicide" ? "suicide" : "emergency", profile.addressForm)
        : safetyScript("distress", profile.addressForm);
    const note = saved ? "Dejé un aviso." : "El aviso ya estaba anotado.";
    return toolResult(`${note} Decí ahora, sin otra pregunta: ${script}`);
  }

  if (name === "record_consent") {
    const accepted = args.accepted === true;
    await deps.store.recordConsent(now.toISOString(), accepted);
    return toolResult(accepted ? "Permiso anotado. Ya podés guardar hechos." : "Quedó anotado que no guardamos memoria.");
  }

  if (name === "decline_session") {
    const retry = args.retry_ok === true;
    const date = localDateInZone(now, profile.timezone || deps.config.timezone);
    await deps.store.updateProactive(date, retry ? "no_response" : "decline", now);
    return toolResult("La persona no quiere seguir ahora. Despedite en una frase y no insistas.", "declined");
  }

  if (name === "end_session") {
    return toolResult("Despedite en una frase, cálida y breve.", "completed");
  }

  return { status: 400, body: { error: "unknown_tool", message: "No conozco esa herramienta." } };
}

export async function handleSafety(deps: AppDeps, headers: Headers, body: unknown): Promise<HttpResult> {
  const denied = requirePin(deps, headers);
  if (denied) return denied;
  const record = asRecord(body);
  const token = text(record?.sessionToken, 200);
  const spoken = text(record?.text, 2000);
  if (!token || !spoken) return { status: 400, body: { error: "bad_request", message: "Falta el texto." } };
  const session = await deps.store.getSessionByToken(token);
  if (!session || session.status !== "active") {
    return { status: 401, body: { error: "unknown_session", message: "No encuentro esa charla." } };
  }
  const assessment = assessUtterance(spoken);
  if (assessment.level === 0 || assessment.kind === "none") {
    return { status: 200, body: { level: 0, kind: "none", sayNow: null, interrupt: false } };
  }
  const level = assessment.level === 3 ? 3 : 2;
  await recordSafetyAlert(deps, {
    sessionId: session.id,
    level,
    kind: assessment.kind,
    reason: assessment.reason,
    excerpt: spoken,
  });
  const profile = await deps.store.getProfile();
  return {
    status: 200,
    body: {
      level,
      kind: assessment.kind,
      sayNow: safetyScript(assessment.kind, profile.addressForm),
      interrupt: level === 3,
    },
  };
}
