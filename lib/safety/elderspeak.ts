import { normalize } from "@/lib/text";

const PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "abuelito", pattern: /\babuelit[oa]s?\b/ },
  { id: "querido", pattern: /\bquerid[oa]\b/ },
  { id: "como-estamos", pattern: /\bcomo estamos\b/ },
  { id: "mi-amor", pattern: /\bmi amor\b/ },
  { id: "corazon", pattern: /\bcorazon(cito)?\b/ },
  { id: "tesoro", pattern: /\btesoro\b/ },
  { id: "cielo", pattern: /\bcielo\b/ },
  { id: "nene", pattern: /\bnen[ea]\b/ },
  { id: "chiquito", pattern: /\bchiquit[oa]\b/ },
  { id: "viejito", pattern: /\bviejit[oa]\b/ },
  { id: "diminutivo", pattern: /\b(gordit[oa]|mi nin[oa])\b/ },
];

export function findElderspeak(text: string): string[] {
  const normalized = normalize(text);
  return PATTERNS.filter((item) => item.pattern.test(normalized)).map((item) => item.id);
}
