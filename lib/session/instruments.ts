import type { AddressForm } from "@/lib/domain";

export type CheckinInstrument = "ucla3" | "who5" | "phq2";

export type CheckinItem = {
  instrument: CheckinInstrument;
  itemId: string;
  promptVos: string;
  promptUsted: string;
  scaleHint: string;
};

export const CHECKIN_ITEMS: CheckinItem[] = [
  {
    instrument: "ucla3",
    itemId: "ucla_company",
    promptVos: "En estos días, ¿sentís que tenés con quién estar, o que te falta compañía?",
    promptUsted: "En estos días, ¿siente que tiene con quién estar, o que le falta compañía?",
    scaleHint: "Si se puede, anotá 1 casi nunca, 2 a veces, 3 seguido. No digas que es un test.",
  },
  {
    instrument: "ucla3",
    itemId: "ucla_left_out",
    promptVos: "¿Hay momentos en los que sentís que los demás te dejan afuera?",
    promptUsted: "¿Hay momentos en los que siente que los demás lo dejan afuera?",
    scaleHint: "1 casi nunca, 2 a veces, 3 seguido.",
  },
  {
    instrument: "ucla3",
    itemId: "ucla_isolated",
    promptVos: "¿Te sentís en contacto con tu gente, o más bien lejos de los demás?",
    promptUsted: "¿Se siente en contacto con su gente, o más bien lejos de los demás?",
    scaleHint: "1 casi nunca se siente lejos, 2 a veces, 3 seguido. No uses la palabra diagnóstico.",
  },
  {
    instrument: "who5",
    itemId: "who_cheerful",
    promptVos: "En estos días, ¿te sentís de buen ánimo?",
    promptUsted: "En estos días, ¿se siente de buen ánimo?",
    scaleHint: "De 0 nada a 5 todo el tiempo, si sale natural. Si no, guardá las palabras.",
  },
  {
    instrument: "who5",
    itemId: "who_calm",
    promptVos: "¿Pudiste estar en calma en algún momento del día?",
    promptUsted: "¿Pudo estar en calma en algún momento del día?",
    scaleHint: "0 a 5 si encaja, sin nombrar una escala clínica.",
  },
  {
    instrument: "who5",
    itemId: "who_active",
    promptVos: "¿Hubo algo, aunque chico, que te diera ganas de hacer?",
    promptUsted: "¿Hubo algo, aunque chico, que le diera ganas de hacer?",
    scaleHint: "0 a 5 si encaja.",
  },
  {
    instrument: "who5",
    itemId: "who_rested",
    promptVos: "¿Cómo venís durmiendo: descansás o te levantás sin energía?",
    promptUsted: "¿Cómo viene durmiendo: descansa o se levanta sin energía?",
    scaleHint: "0 a 5 si encaja.",
  },
  {
    instrument: "who5",
    itemId: "who_interest",
    promptVos: "¿Tu día tiene algo que te interese, o se te hace todo parecido?",
    promptUsted: "¿Su día tiene algo que le interese, o se le hace todo parecido?",
    scaleHint: "0 a 5 si encaja.",
  },
  {
    instrument: "phq2",
    itemId: "phq_interest",
    promptVos: "En estas dos semanas, ¿las cosas te dieron poca gracia o más o menos como siempre?",
    promptUsted: "En estas dos semanas, ¿las cosas le dieron poca gracia o más o menos como siempre?",
    scaleHint: "0 nada, 1 varios días, 2 más de la mitad, 3 casi todos los días. No lo llames depresión.",
  },
  {
    instrument: "phq2",
    itemId: "phq_down",
    promptVos: "En estas dos semanas, ¿tuviste días muy bajos de ánimo o sin ganas, o no tanto?",
    promptUsted: "En estas dos semanas, ¿tuvo días muy bajos de ánimo o sin ganas, o no tanto?",
    scaleHint: "0 nada, 1 varios días, 2 más de la mitad, 3 casi todos los días.",
  },
];

const GAPS_DAYS: Record<CheckinInstrument, number> = {
  ucla3: 4,
  who5: 4,
  phq2: 14,
};

export type CheckinHistory = {
  instrument: string;
  itemId: string;
  createdAt: string;
};

function daysBetween(later: Date, earlierIso: string): number | null {
  const earlier = Date.parse(earlierIso);
  if (!Number.isFinite(earlier)) return null;
  return (later.getTime() - earlier) / (24 * 60 * 60 * 1000);
}

export function selectCheckinItem(input: {
  sessionCount: number;
  history: CheckinHistory[];
  now: Date;
}): CheckinItem | null {
  if (input.sessionCount < 1) return null;
  const lastByInstrument = new Map<CheckinInstrument, string>();
  const lastByItem = new Map<string, string>();
  for (const entry of input.history) {
    if (entry.instrument !== "ucla3" && entry.instrument !== "who5" && entry.instrument !== "phq2") continue;
    const previous = lastByInstrument.get(entry.instrument);
    if (!previous || entry.createdAt > previous) lastByInstrument.set(entry.instrument, entry.createdAt);
    const previousItem = lastByItem.get(entry.itemId);
    if (!previousItem || entry.createdAt > previousItem) lastByItem.set(entry.itemId, entry.createdAt);
  }

  const due = (["ucla3", "who5", "phq2"] as CheckinInstrument[]).filter((instrument) => {
    const last = lastByInstrument.get(instrument);
    if (!last) return true;
    const gap = daysBetween(input.now, last);
    return gap == null || gap >= GAPS_DAYS[instrument];
  });
  if (!due.length) return null;

  due.sort((a, b) => {
    const aLast = lastByInstrument.get(a) ?? "";
    const bLast = lastByInstrument.get(b) ?? "";
    return aLast.localeCompare(bLast);
  });

  for (const instrument of due) {
    const items = CHECKIN_ITEMS.filter((item) => item.instrument === instrument);
    const fresh = items.find((item) => !lastByItem.has(item.itemId));
    if (fresh) return fresh;
    const oldest = [...items].sort((a, b) => (lastByItem.get(a.itemId) ?? "").localeCompare(lastByItem.get(b.itemId) ?? ""))[0];
    if (oldest) return oldest;
  }
  return null;
}

export function spokenCheckin(item: CheckinItem, form: AddressForm): string {
  const prompt = form === "usted" ? item.promptUsted : item.promptVos;
  return `${prompt} ${item.scaleHint} Después llamá log_mood con instrument ${item.instrument}, item_id ${item.itemId}, la respuesta textual y el score si se entiende. Es una señal, no un diagnóstico. Una sola pregunta de este tipo en toda la charla.`;
}
