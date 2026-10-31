import { clip } from "@/lib/text";

export function transcriptionHint(input: {
  displayName: string;
  importantPeople: string;
  tastes: string;
  lifeNotes: string;
}): string {
  const parts = [input.displayName, input.importantPeople, input.tastes, input.lifeNotes]
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return clip(parts.join(". "), 200);
}
