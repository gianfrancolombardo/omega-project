import type { TranscriptTurn } from "@/lib/domain";
import type { IncomingFact } from "@/lib/memory/reconcile";
import { mergeIncomingFacts } from "@/lib/memory/reconcile";
import { isClinicalContent } from "@/lib/profile";
import { assessUtterance } from "@/lib/safety/assess";

const VAGUE = /^(?:eso|esto|mucho|poco|bien|mal|nada|todo|toda|si|sí|no|vos|usted|algo|ahi|allí|aqui)$/i;

function tidyObject(raw: string): string {
  let text = raw.replace(/\s+/g, " ").trim();
  text = (text.split(/\b(?:porque|pero|aunque|entonces)\b/i)[0] ?? text).trim();
  text = text.replace(/[¿?¡!"]/g, "").replace(/[.,;:]+$/g, "").trim();
  if (text.length > 80) text = text.slice(0, 80).trim();
  if (text.length < 3 || VAGUE.test(text) || /^(?:me|no|yo|cuando)\b/i.test(text)) return "";
  if (/\b(mi|mis|me)\b/i.test(text)) return "";
  return text;
}

function splitObjects(raw: string): string[] {
  const objects: string[] = [];
  for (const part of raw.split(/\s+y\s+/i)) {
    const object = tidyObject(part);
    if (!object) continue;
    objects.push(object);
    if (objects.length >= 2) break;
  }
  return objects;
}

function firstPlace(raw: string): string {
  return tidyObject((raw.split(/\s+y\s+/i)[0] ?? raw).trim());
}

function healthFact(sentence: string): IncomingFact | null {
  const normalized = sentence.toLowerCase();
  if (normalized.includes("silla de ruedas")) return { category: "salud", content: "Usa silla de ruedas." };
  if (normalized.includes("andador")) return { category: "salud", content: "Usa andador." };
  if (/bast[oó]n/.test(normalized)) return { category: "salud", content: "Camina con bastón." };
  if (/me cuesta oír|me cuesta oir|oigo poco|oigo mal|escucho poco|escucho mal/.test(normalized)) {
    return { category: "salud", content: "Le cuesta oír." };
  }
  if (/no salgo de casa|no salgo de la casa|no sale de casa/.test(normalized)) {
    return { category: "salud", content: "No sale de casa." };
  }
  if (/me canso|se cansa/.test(normalized)) return { category: "salud", content: "Se cansa con facilidad." };
  if (/no puedo caminar|me cuesta caminar|le cuesta caminar/.test(normalized)) {
    return { category: "salud", content: "Le cuesta caminar." };
  }
  return null;
}

function likePrefix(verb: string): string {
  if (verb.startsWith("me encanta") || verb === "adoro") return verb.endsWith("n") ? "Le encantan" : "Le encanta";
  return verb.endsWith("n") ? "Le gustan" : "Le gusta";
}

function extractFromSentence(sentence: string): IncomingFact[] {
  if (sentence.length < 8 || isClinicalContent(sentence) || assessUtterance(sentence).level > 0) return [];
  if (/\bno s[eé] si\b/i.test(sentence) || /\ba veces\b/i.test(sentence)) return [];
  const facts: IncomingFact[] = [];
  const dislike = sentence.match(/\b(no me gusta|no me gustan|odio|detesto|no soporto)\s+(.+)/i);
  if (dislike?.[2]) {
    const prefix = dislike[1].toLowerCase() === "no me gustan" ? "No le gustan" : "No le gusta";
    for (const object of splitObjects(dislike[2])) facts.push({ category: "disgusto", content: `${prefix} ${object}.` });
  } else {
    const like = sentence.match(/\b(me gusta|me gustan|me encanta|me encantan|adoro)\s+(.+)/i);
    if (like?.[2]) {
      const prefix = likePrefix(like[1].toLowerCase());
      for (const object of splitObjects(like[2])) facts.push({ category: "gusto", content: `${prefix} ${object}.` });
    }
  }

  const interest = sentence.match(
    /\b(?:me interesa|me interesan|me da curiosidad|me llama la atención|me llama la atencion)\s+(.+)/i,
  );
  if (interest?.[1]) {
    for (const object of splitObjects(interest[1])) facts.push({ category: "interes", content: `Le interesa ${object}.` });
  }

  const family = sentence.match(
    /\bmi\s+(hija|hijo|nieta|nieto|esposa|esposo|marido|mujer|hermana|hermano|madre|padre|mamá|mama|papá|papa|sobrina|sobrino|amiga|amigo)\s+se llama\s+([\p{L}][\p{L}'-]{1,30})/iu,
  );
  if (family?.[1] && family[2]) {
    facts.push({ category: "familia", content: `Su ${family[1].toLowerCase()} se llama ${family[2]}.` });
  }

  const born = sentence.match(/\b(?:nací|naci|crecí|creci)\s+en\s+(.+)/i);
  if (born?.[1]) {
    const place = firstPlace(born[1]);
    if (place) facts.push({ category: "lugar", content: `Nació o creció en ${place}.` });
  } else {
    const from = sentence.match(/\bsoy de\s+(.+)/i);
    if (from?.[1]) {
      const place = firstPlace(from[1]);
      if (place) facts.push({ category: "lugar", content: `Es de ${place}.` });
    }
  }

  const birthday = sentence.match(/\bcumplea[nñ]os de\s+(.+?)\s+es el\s+(\d{1,2}\s+de\s+[\p{L}]+)/iu);
  if (birthday?.[1] && birthday[2]) {
    const who = tidyObject(birthday[1]);
    if (who) facts.push({ category: "fecha", content: `El cumpleaños de ${who} es el ${birthday[2]}.` });
  }

  const health = healthFact(sentence);
  if (health) facts.push(health);

  return facts;
}

function sentencesOf(text: string): string[] {
  return text
    .split(/[\n.!?]+/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length >= 8);
}

export function extractFactsFromTranscript(turns: TranscriptTurn[]): IncomingFact[] {
  const found: IncomingFact[] = [];
  for (const turn of turns) {
    if (turn.role !== "user") continue;
    const text = turn.text.trim();
    if (text.length < 8 || isClinicalContent(text) || assessUtterance(text).level > 0) continue;
    for (const sentence of sentencesOf(text)) found.push(...extractFromSentence(sentence));
  }
  return mergeIncomingFacts(found);
}
