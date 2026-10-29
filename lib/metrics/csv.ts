import type { SessionRecord } from "@/lib/domain";

export type SessionMetrics = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  initiator: string;
  module: string;
  status: string;
  durationSeconds: number | null;
  userWords: number;
  agentWords: number;
  talkRatio: number | null;
  misunderstoodCount: number;
  elderspeakHits: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costApproximate: boolean;
  model: string;
  summary: string;
};

export function talkRatio(userWords: number, agentWords: number): number | null {
  if (agentWords <= 0) return null;
  return Math.round((userWords / agentWords) * 100) / 100;
}

export function toMetrics(session: SessionRecord): SessionMetrics {
  return {
    id: session.id,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    initiator: session.initiator,
    module: session.module,
    status: session.status,
    durationSeconds: session.durationSeconds,
    userWords: session.userWords,
    agentWords: session.agentWords,
    talkRatio: talkRatio(session.userWords, session.agentWords),
    misunderstoodCount: session.misunderstoodCount,
    elderspeakHits: session.elderspeakHits,
    inputTokens: session.usage.inputTokens,
    outputTokens: session.usage.outputTokens,
    totalTokens: session.usage.totalTokens,
    costUsd: session.costUsd,
    costApproximate: session.costApproximate,
    model: session.model,
    summary: session.summary,
  };
}

function csvCell(value: string | number | boolean | null): string {
  if (value == null) return "";
  const text = String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  if (/[",\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

const COLUMNS: Array<keyof SessionMetrics> = [
  "id",
  "startedAt",
  "endedAt",
  "initiator",
  "module",
  "status",
  "durationSeconds",
  "userWords",
  "agentWords",
  "talkRatio",
  "misunderstoodCount",
  "elderspeakHits",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "costUsd",
  "costApproximate",
  "model",
  "summary",
];

export function metricsToCsv(rows: SessionMetrics[]): string {
  const header = COLUMNS.join(",");
  const body = rows.map((row) => COLUMNS.map((column) => csvCell(row[column])).join(","));
  return [header, ...body].join("\n");
}
