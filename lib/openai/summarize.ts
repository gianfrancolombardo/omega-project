import type { AlertKind, FactCategory, TranscriptTurn } from "@/lib/domain";
import { FACT_CATEGORIES } from "@/lib/domain";
import { assessUtterance } from "@/lib/safety/assess";
import { clip } from "@/lib/text";
import { transcriptToText } from "@/lib/prompt/assemble";

export type SummaryFact = { category: FactCategory; content: string };

export type SummaryConcern = {
  level: 2 | 3;
  reason: string;
  excerpt: string;
};

export type SummaryResult = {
  summary: string;
  openThreads: string[];
  facts: SummaryFact[];
  concern: SummaryConcern | null;
  source: "model" | "fallback";
};

const SUMMARY_SYSTEM = `Resumís una charla de voz en español rioplatense para la memoria de un acompañante.
Devolvé solo JSON:
{"summary":"string","open_threads":["string"],"facts":[{"category":"gusto","content":"string"}],"concern":null}
summary: dos a cuatro frases, sin inventar nada que no se haya dicho.
open_threads: hasta tres temas para retomar otro día. No los uses para repetir un gusto.
facts: hasta seis datos durables que la persona afirmó de su vida. Una frase en tercera persona cada uno.
Incluí gustos nuevos, disgustos, temas que la entusiasmaron, familia, personas, lugares, fechas, recuerdos, opiniones estables, rutinas, preferencias y salud cotidiana (movilidad, audición, cansancio). Nada de medicación, dosis, pastillas ni diagnósticos. Nada de charla pasajera ni del clima de hoy. Si corrige un dato, devolvé la versión nueva y completa. Si no hay, [].
category es gusto, disgusto, interes, familia, lugar, epoca, fecha, historia, opinion, rutina, salud, meta u otro.
concern es null, o {"level":2,"reason":"...","excerpt":"..."} solo si habló de emergencia, de hacerse daño o de un malestar que lleva días. excerpt es una cita breve.`;

export function extractResponseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === "string") return record.output_text;
  if (!Array.isArray(record.output)) return "";
  const chunks: string[] = [];
  for (const item of record.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        chunks.push((part as { text: string }).text);
      }
    }
  }
  return chunks.join("\n");
}

function asCategory(value: unknown): FactCategory | null {
  return typeof value === "string" && (FACT_CATEGORIES as string[]).includes(value) ? (value as FactCategory) : null;
}

export function parseSummaryJson(text: string): Omit<SummaryResult, "source"> | null {
  const stripped = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.summary !== "string" || !record.summary.trim()) return null;
  const openThreads = Array.isArray(record.open_threads)
    ? record.open_threads.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 3)
    : [];
  const facts: SummaryFact[] = [];
  if (Array.isArray(record.facts)) {
    for (const item of record.facts) {
      if (!item || typeof item !== "object") continue;
      const category = asCategory((item as { category?: unknown }).category);
      const content = (item as { content?: unknown }).content;
      if (!category || typeof content !== "string") continue;
      const trimmed = content.trim();
      if (trimmed.length < 2) continue;
      facts.push({ category, content: trimmed.slice(0, 500) });
    }
  }
  const concern = parseConcern(record.concern);
  return { summary: record.summary.trim().slice(0, 1200), openThreads, facts, concern };
}

function parseConcern(value: unknown): SummaryConcern | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const level = record.level === 3 ? 3 : record.level === 2 ? 2 : null;
  if (!level || typeof record.reason !== "string" || typeof record.excerpt !== "string") return null;
  return { level, reason: record.reason.slice(0, 300), excerpt: record.excerpt.slice(0, 500) };
}

export function shouldAlertFromSummary(
  concern: SummaryConcern | null,
): { level: 2 | 3; kind: AlertKind; reason: string; excerpt: string } | null {
  if (!concern) return null;
  const scan = assessUtterance(`${concern.excerpt} ${concern.reason}`);
  if (scan.level === 0 || scan.kind === "none") return null;
  return {
    level: scan.level === 3 ? 3 : 2,
    kind: scan.kind,
    reason: concern.reason,
    excerpt: concern.excerpt,
  };
}

export function fallbackSummary(turns: TranscriptTurn[]): SummaryResult {
  const userLines = turns.map((turn) => (turn.role === "user" ? turn.text.trim() : "")).filter(Boolean);
  const summary = userLines.length
    ? clip(userLines.slice(0, 3).join(" "), 500)
    : "La charla no dejó frases de la persona para resumir.";
  return { summary, openThreads: [], facts: [], concern: null, source: "fallback" };
}

export async function summarizeSession(input: {
  apiKey: string | null;
  model: string;
  turns: TranscriptTurn[];
  fetchImpl: typeof fetch;
}): Promise<SummaryResult> {
  const fallback = fallbackSummary(input.turns);
  if (!input.apiKey) return fallback;
  try {
    const response = await input.fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        input: [
          { role: "system", content: SUMMARY_SYSTEM },
          { role: "user", content: transcriptToText(input.turns).slice(0, 24_000) },
        ],
      }),
    });
    if (!response.ok) return fallback;
    const payload: unknown = await response.json();
    const parsed = parseSummaryJson(extractResponseText(payload));
    if (!parsed) return fallback;
    return { ...parsed, source: "model" };
  } catch {
    return fallback;
  }
}
