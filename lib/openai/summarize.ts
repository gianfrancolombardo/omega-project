import type { AlertKind, FactCategory, SummaryMeta, TranscriptTurn } from "@/lib/domain";
import { FACT_CATEGORIES } from "@/lib/domain";
import { assessUtterance } from "@/lib/safety/assess";
import { clip } from "@/lib/text";
import { transcriptToText } from "@/lib/prompt/assemble";

export type SummaryFact = { category: FactCategory; content: string };

export type SummaryConcern = {
  level: 2 | 3;
  kind?: AlertKind;
  reason: string;
  excerpt: string;
};

export type SummaryResult = {
  summary: string;
  openThreads: string[];
  facts: SummaryFact[];
  concern: SummaryConcern | null;
  meta: SummaryMeta;
  source: "model" | "fallback";
};

const EMPTY_META: SummaryMeta = {
  mood: null,
  engagedTopics: [],
  declinedTopics: [],
  humanContact: { mentioned: false, who: [] },
  closedThreads: [],
  checkinItemsAsked: [],
};

export const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "open_threads",
    "facts",
    "concern",
    "mood",
    "engaged_topics",
    "declined_topics",
    "human_contact",
    "closed_threads",
    "checkin_items_asked",
  ],
  properties: {
    summary: { type: "string" },
    open_threads: { type: "array", items: { type: "string" } },
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "content"],
        properties: {
          category: { type: "string", enum: [...FACT_CATEGORIES] },
          content: { type: "string" },
        },
      },
    },
    concern: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["level", "kind", "reason", "excerpt"],
          properties: {
            level: { type: "integer", enum: [2, 3] },
            kind: { type: "string", enum: ["suicide", "emergency", "distress", "concern"] },
            reason: { type: "string" },
            excerpt: { type: "string" },
          },
        },
      ],
    },
    mood: { anyOf: [{ type: "integer" }, { type: "null" }] },
    engaged_topics: { type: "array", items: { type: "string" } },
    declined_topics: { type: "array", items: { type: "string" } },
    human_contact: {
      type: "object",
      additionalProperties: false,
      required: ["mentioned", "who"],
      properties: {
        mentioned: { type: "boolean" },
        who: { type: "array", items: { type: "string" } },
      },
    },
    closed_threads: { type: "array", items: { type: "string" } },
    checkin_items_asked: { type: "array", items: { type: "string" } },
  },
} as const;

const SUMMARY_SYSTEM = `Resumís una charla de voz en español rioplatense para la memoria de un acompañante.
Devolvé solo JSON válido con esta forma:
{"summary":"string","open_threads":["string"],"facts":[{"category":"gusto","content":"string"}],"concern":null,"mood":3,"engaged_topics":[],"declined_topics":[],"human_contact":{"mentioned":false,"who":[]},"closed_threads":[],"checkin_items_asked":[]}
summary: dos a cuatro frases, sin inventar nada que no se haya dicho.
open_threads: hasta tres temas para retomar otro día. No los uses para repetir un gusto. No incluyas los de closed_threads.
facts: hasta seis datos durables que la persona afirmó de su vida. Una frase en tercera persona cada uno.
Incluí gustos nuevos, disgustos, temas que la entusiasmaron, familia, personas, lugares, fechas, recuerdos, opiniones estables, rutinas, preferencias y salud cotidiana (movilidad, audición, cansancio). Nada de medicación, dosis, pastillas ni diagnósticos. Nada de charla pasajera ni del clima de hoy. Si corrige un dato, devolvé la versión nueva y completa. Si no hay, [].
category es gusto, disgusto, interes, familia, lugar, epoca, fecha, historia, opinion, rutina, salud, meta u otro.
mood: ánimo percibido de 1 a 5, o null si no se entiende.
engaged_topics: temas que engancharon.
declined_topics: temas que rechazó o no quiso seguir.
human_contact: si mencionó hablar, llamar o ver a alguien de su gente.
closed_threads: hilos previos que se cerraron hoy.
checkin_items_asked: item_id de check-in que se preguntaron aunque no se haya registrado el score.
concern es null o {"level":2|3,"kind":"suicide|emergency|distress|concern","reason":"…","excerpt":"…"}.
Nivel 3: caída, dolor de pecho, falta de aire, signos de ACV, maltrato, ideas de muerte, también pasivas ("estoy cansada de vivir", "ojalá no me despierte", "soy una carga", "ya viví demasiado").
Nivel 2: no come o no duerme hace días, desesperanza, soledad intensa que se repite, confusión nueva, abuso de dinero, medicación mal tomada. Ante la duda, nivel 2.
No devuelvas datos sobre los temas que te indiquen evitar.`;

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

function asStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, limit);
}

function parseMeta(record: Record<string, unknown>): SummaryMeta {
  const moodRaw = record.mood;
  const mood =
    typeof moodRaw === "number" && Number.isFinite(moodRaw) ? Math.min(5, Math.max(1, Math.round(moodRaw))) : null;
  const contact = record.human_contact;
  const humanContact =
    contact && typeof contact === "object"
      ? {
          mentioned: (contact as { mentioned?: unknown }).mentioned === true,
          who: asStringList((contact as { who?: unknown }).who, 6),
        }
      : { mentioned: false, who: [] };
  return {
    mood,
    engagedTopics: asStringList(record.engaged_topics, 6),
    declinedTopics: asStringList(record.declined_topics, 6),
    humanContact,
    closedThreads: asStringList(record.closed_threads, 6),
    checkinItemsAsked: asStringList(record.checkin_items_asked, 8),
  };
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
  const openThreads = asStringList(record.open_threads, 3);
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
  const meta = parseMeta(record);
  const closed = new Set(meta.closedThreads.map((item) => item.trim().toLowerCase()));
  return {
    summary: record.summary.trim().slice(0, 1200),
    openThreads: openThreads.filter((item) => !closed.has(item.trim().toLowerCase())),
    facts,
    concern,
    meta,
  };
}

function parseConcern(value: unknown): SummaryConcern | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const level = record.level === 3 ? 3 : record.level === 2 ? 2 : null;
  if (!level || typeof record.reason !== "string" || typeof record.excerpt !== "string") return null;
  const kindRaw = record.kind;
  const kind: AlertKind | undefined =
    kindRaw === "suicide" || kindRaw === "emergency" || kindRaw === "distress" || kindRaw === "concern"
      ? kindRaw
      : undefined;
  return { level, kind, reason: record.reason.slice(0, 300), excerpt: record.excerpt.slice(0, 500) };
}

export function shouldAlertFromSummary(
  concern: SummaryConcern | null,
): { level: 2 | 3; kind: AlertKind; reason: string; excerpt: string } | null {
  if (!concern) return null;
  const scan = assessUtterance(`${concern.excerpt} ${concern.reason}`);
  return {
    level: scan.level === 3 || concern.level === 3 ? 3 : 2,
    kind: scan.kind === "none" ? (concern.kind ?? "concern") : scan.kind,
    reason: concern.reason,
    excerpt: concern.excerpt,
  };
}

export function fallbackSummary(turns: TranscriptTurn[]): SummaryResult {
  const userLines = turns.map((turn) => (turn.role === "user" ? turn.text.trim() : "")).filter(Boolean);
  const summary = userLines.length
    ? clip(userLines.slice(0, 3).join(" "), 500)
    : "La charla no dejó frases de la persona para resumir.";
  return { summary, openThreads: [], facts: [], concern: null, meta: { ...EMPTY_META }, source: "fallback" };
}

export async function summarizeSession(input: {
  apiKey: string | null;
  model: string;
  turns: TranscriptTurn[];
  fetchImpl: typeof fetch;
  avoidTopics?: string;
  previousThreads?: string[];
}): Promise<SummaryResult> {
  const fallback = fallbackSummary(input.turns);
  if (!input.apiKey) return fallback;
  const extra: string[] = [];
  if (input.avoidTopics?.trim()) extra.push(`No devuelvas datos sobre: ${input.avoidTopics.trim()}`);
  if (input.previousThreads?.length) extra.push(`Hilos previos, marcá closed_threads si se cerraron: ${input.previousThreads.join(" | ")}`);
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
          { role: "system", content: extra.length ? `${SUMMARY_SYSTEM}\n${extra.join("\n")}` : SUMMARY_SYSTEM },
          { role: "user", content: transcriptToText(input.turns).slice(0, 24_000) },
        ],
        text: { format: { type: "json_schema", name: "session_summary", strict: true, schema: SUMMARY_SCHEMA } },
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
