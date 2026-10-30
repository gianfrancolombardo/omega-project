import type { AddressForm } from "@/lib/domain";
import { selectCheckinItem, spokenCheckin, type CheckinHistory, type CheckinItem } from "@/lib/session/instruments";
import { isMainModule, MAIN_MODULES, type MainModule } from "@/lib/session/modules";

const HISTORY_THEMES = [
  "las comidas de domingo y los olores de la cocina",
  "un día concreto de la escuela o del trabajo que recuerde bien",
  "una fiesta, un baile o el Carnaval",
  "un lugar querido: la playa, el barrio o un viaje",
  "una persona querida en un momento bueno",
  "una canción o una novela de radio de su juventud",
  "algo que supo hacer con las manos",
];

const CHARLA_THEMES = [
  "cómo viene el día y qué le quedó dando vueltas",
  "un recuerdo cotidiano que todavía no haya contado",
  "una opinión sobre algo cotidiano y amable",
  "algo del mundo que le dé curiosidad, contado en simple",
  "una persona de su vida en un momento bueno, solo si ella quiere",
  "qué haría con una tarde libre",
];

const CURIOSITY_FALLBACK = [
  "por qué el cielo se pone rojo al atardecer, con una pista primero",
  "cómo sabe una abeja volver a la colmena, en dos ideas",
  "por qué el mate se lava y no se lava con jabón, y que lo cuente con sus palabras",
];

const OPINIONS = [
  "si en las escuelas guardaran los celulares durante la clase",
  "si un barrio gana más con una plaza nueva o con un local de comida",
  "si conviene contar las historias de familia en voz alta o dejarlas escritas",
  "si la radio de antes acompañaba más que la tele",
];

export type RecentModule = {
  module: string;
  localDate: string;
};

export type DayPlan = {
  module: MainModule;
  reason: string;
  theme: string;
  checkin: CheckinItem | null;
  checkinLine: string | null;
};

function dayNumber(localDate: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) return 0;
  return Number(match[1]) * 372 + Number(match[2]) * 31 + Number(match[3]);
}

export function chooseModule(today: string, recent: RecentModule[]): { module: MainModule; reason: string } {
  const usedToday = new Set(recent.filter((item) => item.localDate === today).map((item) => item.module));
  const previous = recent.find((item) => item.localDate !== today && isMainModule(item.module));
  const blocked = new Set(usedToday);
  if (previous) blocked.add(previous.module);
  const available = MAIN_MODULES.find((module) => !blocked.has(module));
  if (available) {
    const because = previous ? `ayer fue ${previous.module}` : "todavía no hay una charla anterior";
    return { module: available, reason: `Hoy toca ${available} porque ${because}.` };
  }
  const last = recent[0]?.module;
  const fallback = MAIN_MODULES.find((module) => module !== last) ?? "charla";
  return { module: fallback, reason: "Ya se usaron los módulos del día; se elige uno distinto al último." };
}

function historyTheme(today: string, recent: RecentModule[]): string {
  const index = dayNumber(today) % HISTORY_THEMES.length;
  const yesterdayWasHistory = recent.some((item) => item.localDate !== today && item.module === "mi_historia");
  const shifted = yesterdayWasHistory ? (index + 1) % HISTORY_THEMES.length : index;
  return HISTORY_THEMES[shifted] ?? HISTORY_THEMES[0];
}

function charlaTheme(today: string): string {
  return CHARLA_THEMES[dayNumber(today) % CHARLA_THEMES.length] ?? CHARLA_THEMES[0];
}

function curiosityTheme(today: string): string {
  return CURIOSITY_FALLBACK[dayNumber(today) % CURIOSITY_FALLBACK.length] ?? CURIOSITY_FALLBACK[0];
}

export function planDay(input: {
  today: string;
  recent: RecentModule[];
  sessionCount: number;
  history: CheckinHistory[];
  now: Date;
  addressForm: AddressForm;
  consented: boolean;
}): DayPlan {
  if (!input.consented) {
    return {
      module: "charla",
      reason: "Todavía no hubo un sí para guardar memoria. La charla es una presentación.",
      theme: "presentarse como inteligencia artificial y pedir un sí claro",
      checkin: null,
      checkinLine: null,
    };
  }
  const chosen = chooseModule(input.today, input.recent);
  const checkin = selectCheckinItem({
    sessionCount: input.sessionCount,
    history: input.history,
    now: input.now,
  });
  const theme =
    chosen.module === "mi_historia"
      ? historyTheme(input.today, input.recent)
      : chosen.module === "curiosidad"
        ? curiosityTheme(input.today)
        : chosen.module === "opinion"
          ? OPINIONS[dayNumber(input.today) % OPINIONS.length] ?? OPINIONS[0]
          : charlaTheme(input.today);
  return {
    module: chosen.module,
    reason: chosen.reason,
    theme,
    checkin,
    checkinLine: checkin ? spokenCheckin(checkin, input.addressForm) : null,
  };
}
