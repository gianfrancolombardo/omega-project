import type { TranscriptTurn } from "@/lib/domain";
import { findElderspeak } from "@/lib/safety/elderspeak";
import { countWords, normalize } from "@/lib/text";

const MISHEARD = /se me corto|no te entendi|no le entendi|no te escuche|no le escuche|me lo repetis|me lo repite/;

export function tallyTranscript(turns: TranscriptTurn[]): {
  userWords: number;
  agentWords: number;
  misunderstood: number;
  elderspeakHits: number;
} {
  let userWords = 0;
  let agentWords = 0;
  let misunderstood = 0;
  let elderspeakHits = 0;
  for (const turn of turns) {
    const words = countWords(turn.text);
    if (turn.role === "user") userWords += words;
    else {
      agentWords += words;
      if (MISHEARD.test(normalize(turn.text))) misunderstood += 1;
      elderspeakHits += findElderspeak(turn.text).length;
    }
  }
  return { userWords, agentWords, misunderstood, elderspeakHits };
}
