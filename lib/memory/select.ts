import type { Fact, FactCategory } from "@/lib/domain";
import { factTokens } from "@/lib/memory/reconcile";

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function selectFactsForPrompt(facts: Fact[], seed: string, limit: number, avoid = ""): Fact[] {
  if (limit <= 0) return [];
  const avoidTokens = new Set(factTokens(avoid));
  const usable = facts.filter((fact) => {
    if (!avoidTokens.size) return true;
    return !factTokens(fact.content).some((token) => avoidTokens.has(token));
  });
  const groups = new Map<FactCategory, Fact[]>();
  for (const fact of usable) {
    const list = groups.get(fact.category);
    if (list) list.push(fact);
    else groups.set(fact.category, [fact]);
  }
  const categories = [...groups.keys()];
  if (!categories.length) return [];
  const shift = hashString(seed) % categories.length;
  const ordered = [...categories.slice(shift), ...categories.slice(0, shift)];
  const perCategory = categories.length === 1 ? limit : Math.min(2, limit);
  const cursors = new Map<FactCategory, number>();
  for (const category of ordered) {
    const list = groups.get(category) ?? [];
    cursors.set(category, list.length ? hashString(`${seed}:${category}`) % list.length : 0);
  }
  const picked: Fact[] = [];
  const seen = new Set<string>();
  let idleRounds = 0;
  while (picked.length < limit && idleRounds < ordered.length) {
    let added = false;
    for (const category of ordered) {
      if (picked.length >= limit) break;
      const list = groups.get(category) ?? [];
      const count = picked.filter((fact) => fact.category === category).length;
      if (count >= perCategory) continue;
      const start = cursors.get(category) ?? 0;
      for (let step = 0; step < list.length; step += 1) {
        const fact = list[(start + step) % list.length];
        if (!fact || seen.has(fact.id)) continue;
        seen.add(fact.id);
        picked.push(fact);
        cursors.set(category, (start + step + 1) % list.length);
        added = true;
        break;
      }
    }
    idleRounds = added ? 0 : idleRounds + 1;
  }
  return picked;
}
