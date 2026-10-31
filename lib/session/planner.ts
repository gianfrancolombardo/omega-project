import type { AddressForm } from "@/lib/domain";
import { factTokens } from "@/lib/memory/reconcile";
import { clip } from "@/lib/text";
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
  "el primer sueldo o el primer trabajo que le gustó",
  "un verano, un calor o un mate en la vereda",
  "la casa de la infancia y cómo se oía de noche",
  "un maestro, un oficio o alguien que le enseñó",
  "un domingo de fútbol, radio o familia",
  "un viaje corto, un ómnibus o un tren que no olvida",
  "una receta, un olor a grasa o a pan",
  "un apodo, un patio o un almacén del barrio",
  "una carta, una foto o un objeto que todavía tiene",
  "un logro chico del que todavía se ríe",
  "la música que ponían en los bailes de su época",
];

const CHARLA_THEMES = [
  "un ángulo nuevo sobre algo que ya disfruta, un dato o una conexión",
  "una opinión suave sobre algo cotidiano y amable",
  "un detalle de su vida que todavía no contó",
  "algo del mundo que le dé curiosidad, contado en simple",
  "una persona de su vida en un momento bueno, solo si ella quiere",
  "qué haría con una tarde libre si pudiera elegir",
  "un hábito chico que le hace bien o le da orden",
  "un programa, un diario o una voz de radio que extraña",
  "un sabor, un olor o un sonido de esta semana",
  "un recuerdo corto que se cruce con el presente",
  "una cosa que le gustaría contarle a alguien de su gente",
  "un dilema liviano de barrio o de casa",
  "un oficio, una herramienta o cómo se hacía antes",
  "un lugar de la ciudad que le gustaría volver a ver",
  "una palabra, un dicho o un chiste de su época",
  "un proyecto chico para mañana, si le nace",
  "una noticia amable o una costumbre que cambió",
  "algo que aprendió de grande y todavía le sirve",
];

const CURIOSITY_FALLBACK = [
  "por qué el cielo se pone rojo al atardecer, con una pista primero",
  "cómo sabe una abeja volver a la colmena, en dos ideas",
  "por qué el mate se pone lavado y por qué no se lava con jabón, y que lo cuente con sus palabras",
  "por qué el Río de la Plata es marrón, con una pista primero",
  "cómo hace un faro para no confundir a los barcos",
  "por qué el pan se pone duro y cómo se revive",
  "cómo se forma una nube y por qué a veces no llueve",
  "por qué el tango se escribe en dos por cuatro, en simple",
  "cómo llega el sonido de la radio de un pueblo a otro",
  "por qué el hierro se oxida y el oro no",
  "cómo sabe el cuerpo que ya es de noche",
  "por qué el agua del mar no se puede tomar",
  "cómo se mide el tiempo sin reloj, en dos ideas",
  "por qué algunas palabras se parecen en italiano y en español",
  "cómo funciona un motor diésel, en dos ideas",
  "por qué las estrellas parecen titilar",
  "cómo se hace el carbón o el ladrillo, si ella quiere",
  "por qué el eco devuelve la voz",
];

const OPINIONS = [
  "si en las escuelas guardaran los celulares durante la clase",
  "si un barrio gana más con una plaza nueva o con un local de comida",
  "si conviene contar las historias de familia en voz alta o dejarlas escritas",
  "si la radio de antes acompañaba más que la tele",
  "si un pueblo chico vive mejor que una capital",
  "si hay que saludar al vecino aunque no se lo conozca bien",
  "si los oficios de antes se deberían enseñar otra vez",
  "si un diario en papel todavía vale la pena",
  "si es mejor una visita corta o una llamada larga",
  "si las fiestas de fin de año se pasaron de ruído",
  "si el fútbol de ahora se entiende menos que el de antes",
  "si conviene guardar las fotos en cajas o en el teléfono",
  "si un barrio necesita más árboles o más bancos",
  "si se puede discrepar en familia sin pelear",
  "si el Carnaval se siente igual que cuando era joven",
  "si vale más un consejo de un amigo que el de un experto",
  "si hay que cambiar de médico cuando uno no se siente escuchado",
  "si las ciudades deberían ir más despacio a la tarde",
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
  const lastSeen = new Map<MainModule, number>();
  recent.forEach((item, index) => {
    if (isMainModule(item.module) && !lastSeen.has(item.module)) lastSeen.set(item.module, index);
  });
  const previous = recent[0]?.module;
  const ranked = [...MAIN_MODULES]
    .filter((candidate) => candidate !== previous)
    .sort((left, right) => (lastSeen.get(right) ?? Number.POSITIVE_INFINITY) - (lastSeen.get(left) ?? Number.POSITIVE_INFINITY));
  const picked = ranked[0] ?? "charla";
  return { module: picked, reason: previous ? `Hoy toca ${picked} porque ayer fue ${previous}.` : `Hoy toca ${picked}.` };
}

function overlapsDeclined(theme: string, declined: string[]): boolean {
  const tokens = new Set(factTokens(theme));
  if (!tokens.size) return false;
  return declined.some((item) => factTokens(item).some((token) => tokens.has(token)));
}

function pickTheme(list: string[], today: string, declined: string[]): string {
  if (!list.length) return "";
  const start = dayNumber(today) % list.length;
  for (let step = 0; step < list.length; step += 1) {
    const theme = list[(start + step) % list.length] ?? list[0];
    if (!overlapsDeclined(theme, declined)) return theme;
  }
  return list[start] ?? list[0];
}

function historyThemes(lifeNotes: string): string[] {
  const notes = lifeNotes.trim();
  if (!notes) return HISTORY_THEMES;
  return [`un recuerdo concreto ligado a esto de su vida: ${clip(notes, 80)}`, ...HISTORY_THEMES];
}

export function planDay(input: {
  today: string;
  recent: RecentModule[];
  sessionCount: number;
  history: CheckinHistory[];
  now: Date;
  addressForm: AddressForm;
  lifeNotes?: string;
  declinedTopics?: string[];
}): DayPlan {
  const chosen = chooseModule(input.today, input.recent);
  const declined = input.declinedTopics ?? [];
  const checkin = selectCheckinItem({
    sessionCount: input.sessionCount,
    history: input.history,
    now: input.now,
  });
  const theme =
    chosen.module === "mi_historia"
      ? pickTheme(historyThemes(input.lifeNotes ?? ""), input.today, declined)
      : chosen.module === "curiosidad"
        ? pickTheme(CURIOSITY_FALLBACK, input.today, declined)
        : chosen.module === "opinion"
          ? pickTheme(OPINIONS, input.today, declined)
          : pickTheme(CHARLA_THEMES, input.today, declined);
  return {
    module: chosen.module,
    reason: chosen.reason,
    theme,
    checkin,
    checkinLine: checkin ? spokenCheckin(checkin, input.addressForm) : null,
  };
}
