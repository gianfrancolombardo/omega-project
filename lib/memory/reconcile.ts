import type { FactCategory } from "@/lib/domain";
import { isClinicalContent, isFactCategory } from "@/lib/profile";
import { normalize } from "@/lib/text";

const STOP = new Set([
  "los",
  "las",
  "una",
  "unos",
  "unas",
  "del",
  "que",
  "por",
  "con",
  "sus",
  "para",
  "como",
  "esta",
  "muy",
  "mas",
  "pero",
  "cuando",
  "donde",
  "sobre",
  "tiene",
  "hacer",
  "hace",
  "desde",
  "entre",
  "tambien",
  "todo",
  "toda",
  "todos",
  "todas",
  "ella",
  "ello",
  "eso",
  "esto",
  "ese",
  "esa",
  "aqui",
  "alli",
  "hoy",
  "ayer",
  "bien",
  "mal",
  "algo",
  "nada",
  "poco",
  "mucho",
  "solo",
  "cada",
  "otro",
  "otra",
  "otros",
  "otras",
]);

export type IncomingFact = {
  category: FactCategory;
  content: string;
};

export type StoredFactRef = {
  id: string;
  category: FactCategory;
  content: string;
};

export type FactWritePlan =
  | { type: "insert" }
  | { type: "keep"; id: string }
  | { type: "update"; id: string; category: FactCategory; content: string };

export function factTokens(content: string): string[] {
  const words = normalize(content).split(" ").filter(Boolean);
  const tokens: string[] = [];
  for (const word of words) {
    if (word === "no" || word === "ni" || word === "sin" || word === "nunca") {
      tokens.push(word);
      continue;
    }
    if (word.length > 2 && !STOP.has(word)) tokens.push(word);
  }
  return tokens;
}

export function factOverlap(left: string, right: string): number {
  if (normalize(left) === normalize(right)) return 1;
  const a = factTokens(left);
  const b = factTokens(right);
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : shared / union;
}

function hasNegation(tokens: string[]): boolean {
  return tokens.includes("no") || tokens.includes("nunca") || tokens.includes("sin");
}

export function planFactWrite(existing: StoredFactRef[], incoming: IncomingFact): FactWritePlan {
  let best: { fact: StoredFactRef; score: number } | null = null;
  for (const fact of existing) {
    const score = factOverlap(fact.content, incoming.content);
    if (!best || score > best.score) best = { fact, score };
  }
  if (!best || best.score < 0.6) return { type: "insert" };

  const current = best.fact;
  if (normalize(current.content) === normalize(incoming.content)) {
    if (current.category === incoming.category) return { type: "keep", id: current.id };
    return { type: "update", id: current.id, category: incoming.category, content: current.content };
  }

  const oldTokens = factTokens(current.content);
  const newTokens = factTokens(incoming.content);
  const oldSet = new Set(oldTokens);
  const newSet = new Set(newTokens);
  const adds = [...newSet].some((token) => !oldSet.has(token));
  const drops = [...oldSet].some((token) => !newSet.has(token));
  if (hasNegation(oldTokens) !== hasNegation(newTokens)) {
    return { type: "update", id: current.id, category: incoming.category, content: incoming.content };
  }
  if (adds && !drops) {
    return { type: "update", id: current.id, category: incoming.category, content: incoming.content };
  }
  if (!adds && drops) return { type: "keep", id: current.id };
  if (best.score >= 0.75) {
    return { type: "update", id: current.id, category: incoming.category, content: incoming.content };
  }
  return { type: "insert" };
}

export function mergeIncomingFacts(facts: IncomingFact[]): IncomingFact[] {
  const merged: IncomingFact[] = [];
  for (const item of facts) {
    const content = item.content.trim().replace(/\s+/g, " ").slice(0, 500);
    if (content.length < 2 || !isFactCategory(item.category) || isClinicalContent(content)) continue;
    const plan = planFactWrite(
      merged.map((fact, index) => ({ id: String(index), category: fact.category, content: fact.content })),
      { category: item.category, content },
    );
    if (plan.type === "insert") {
      if (merged.length >= 16) continue;
      merged.push({ category: item.category, content });
      continue;
    }
    if (plan.type === "update") {
      const index = Number(plan.id);
      if (Number.isInteger(index) && merged[index]) {
        merged[index] = { category: plan.category, content: plan.content };
      }
    }
  }
  return merged;
}
