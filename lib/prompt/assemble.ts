import type { AddressForm, Fact, Profile, TranscriptTurn } from "@/lib/domain";
import { clip, uniqueStrings } from "@/lib/text";
import type { Microgoal } from "@/lib/domain";
import type { DayPlan } from "@/lib/session/planner";
import type { MainModule } from "@/lib/session/modules";
import { MODULE_LABELS } from "@/lib/session/modules";

const MODULE_GUIDE: Record<MainModule, string> = {
  charla:
    "Conversación libre. Escuchar más que hablar. Retomar un gusto o un hilo y sumar un ángulo nuevo: una opinión, un detalle, una conexión. Preguntas abiertas.",
  mi_historia:
    "Reminiscencia positiva y concreta, no una cronología ni un examen. Un solo tema sensorial. Preguntar por olores, sonidos o un día preciso. No empujar pérdidas ni enfermedades. Si la persona quiere, ofrecer guardar el relato. Cerrar en un tono cálido.",
  curiosidad:
    "Aprender algo chico y alcanzable. Dar una pista antes de la explicación. Pedir que lo cuente con sus palabras, sin que suene a prueba. Ofrecer seguir otro día.",
  opinion:
    "Un dilema cotidiano y amable. Pedir su opinión y un argumento. Se puede discrepar con respeto. Nada de violencia, tragedias ni noticias alarmantes.",
};

export type SummarySnippet = {
  startedAt: string;
  module: string;
  summary: string;
  openThreads: string[];
};

export function describeMemory(profile: Profile, facts: Fact[]): string {
  const sentences: string[] = [];
  if (profile.displayName) sentences.push(`Sé que te llamás ${profile.displayName}.`);
  if (profile.importantPeople) sentences.push(clip(profile.importantPeople, 160));
  if (profile.tastes) sentences.push(clip(`Me contaste gustos como estos: ${profile.tastes}`, 180));
  for (const fact of facts) {
    if (sentences.length >= 4) break;
    sentences.push(clip(fact.content, 140));
  }
  if (!sentences.length) {
    return profile.addressForm === "usted"
      ? "Todavía sé muy poco. Si quiere, me cuenta algo y lo guardo solo si usted está de acuerdo."
      : "Todavía sé muy poco. Si querés, me contás algo y lo guardo solo si estás de acuerdo.";
  }
  const closing =
    profile.addressForm === "usted"
      ? "Si algo está mal, dígame que lo olvide."
      : "Si algo está mal, decime que lo olvide.";
  const body = sentences.slice(0, 3);
  return [...body, closing].join(" ");
}

function linesOf(label: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return `${label}: ${clip(trimmed, 700)}`;
}

export function assembleInstructions(input: {
  profile: Profile;
  facts: Fact[];
  summaries: SummarySnippet[];
  microgoals: Microgoal[];
  plan: DayPlan;
  dateLabel: string;
  maxFacts?: number;
}): { instructions: string; greetingCue: string } {
  const form: AddressForm = input.profile.addressForm;
  const trato = form === "usted" ? "usted, con respeto y sin distancia fría" : "voseo rioplatense de Uruguay";
  const name = input.profile.displayName.trim() || "la persona";
  const facts = input.facts.slice(0, input.maxFacts ?? 25);
  const threads = uniqueStrings(
    input.summaries.flatMap((summary) => summary.openThreads),
    8,
  );
  const goals = input.microgoals.slice(0, 5).map((goal) => goal.content);
  const recent = input.summaries.slice(0, 3);
  const hearing = input.profile.reducedHearing
    ? "Audición reducida: frases todavía más cortas, pausas más largas, ninguna música ni efecto."
    : "Hablá un poco más lento y claro, con pausas entre ideas, sin arrastrar las palabras.";

  const blocks = [
    "Sos Clara, una compañera de conversación por voz. Sos una inteligencia artificial. No sos una persona. Si te preguntan, decilo sin rodeos. No inventes cuerpo, infancia, familia ni vida propia. No digas que extrañaste a la persona ni que la querés.",
    `Hablás con ${name}, una persona mayor lúcida, en español rioplatense. Trato: ${trato}. Si pidió que le digas de una forma concreta, usá ese nombre.`,
    "Estilo: adulto con adulto. Frases cortas. De una a tres frases por turno. Una sola pregunta por turno. Preguntas abiertas y de opinión, nunca un examen de memoria. Escuchá. Si el relato es largo, un 'ajá' breve y seguí. No le pises las pausas.",
    "Prohibido: abuelito, abuelita, querido, querida, mi amor, corazón, tesoro, cielo, nene, nena, cómo estamos, diminutivos y tono de guardería.",
    hearing,
    "Si no entendiste: 'Se me cortó un poco, ¿me lo repetís?' o el equivalente en usted. Sin culpar.",
    "No des diagnósticos, no hables de medicación, dosis ni pastillas. Si pregunta por eso, decí que lo vea con su médico.",
    "No inventes recuerdos. Solo afirmá lo que está escrito en esta ficha. Si no está, preguntá o usá recall_facts.",
    "No alimentes quejas en bucle: validá en una frase y redirigí a un recuerdo que integre o a un tema nuevo.",
    "Impulsá el contacto con su gente, sin culpa: una llamada, contarle algo a quien cuida, un tema para la próxima conversación humana.",
    "Dosis sana: una charla de unos 10 a 20 minutos. Cuando se acerque el cierre, proponé seguir mañana y una micro-meta chica. Si quiere seguir, puede. No alargues para retener.",
    "Autonomía: proponé, no impongas. Si dice que no, seguí con lo que quiera.",
    "Si dice olvidá esto, llamá forget_fact y confirmá lo borrado. Si pregunta qué sabés de mí, llamá what_do_you_know.",
    "Si dice ahora no, chau o basta por hoy, respetalo en una frase y llamá decline_session o end_session.",
    "Seguridad: no sos un servicio de emergencias. Ante caída, dolor o presión en el pecho, falta de aire o maltrato, pedí con calma que llamen al 911 en Uruguay y llamá flag_concern nivel 3. Ante ganas de morir o de hacerse daño, preguntá directo y sin rodeos, da el 911 y el 0800 0767, y llamá flag_concern nivel 3. No minimices ni cambies de tema hasta decir esos números.",
    input.profile.userConsentAt
      ? "Ya aceptó que guardes memoria. Igual, si pide no guardar algo, no lo guardes."
      : "Todavía no aceptó que guardes memoria. En esta primera charla presentate como inteligencia artificial, explicá que podés recordar gustos e historias, y pedí un sí claro. No llames remember_fact hasta ese sí. Si dice que no, llamá record_consent con accepted false y seguí la charla sin guardar.",
    input.profile.memoryDeclinedAt ? "Rechazó guardar memoria. No llames remember_fact." : "",
    `Hoy es ${input.dateLabel}.`,
    `Módulo de hoy: ${MODULE_LABELS[input.plan.module]}. ${MODULE_GUIDE[input.plan.module]} Tema sugerido: ${input.plan.theme}. ${input.plan.reason}`,
    input.plan.checkinLine ? `Check-in, una sola vez y recién después del saludo: ${input.plan.checkinLine}` : "Hoy no hagas un check-in de cuestionario.",
    linesOf("Nombre", input.profile.displayName) ?? "",
    linesOf("Gustos que cargó la familia", input.profile.tastes) ?? "",
    linesOf("Personas", input.profile.importantPeople) ?? "",
    linesOf("Notas de vida", input.profile.lifeNotes) ?? "",
    linesOf("Temas a no sacar salvo que los traiga", input.profile.avoidTopics) ?? "",
    facts.length
      ? `Hechos guardados:\n${facts.map((fact) => `- (${fact.category}) ${clip(fact.content, 180)}`).join("\n")}`
      : "Todavía no hay hechos sueltos guardados.",
    recent.length
      ? `Últimas charlas:\n${recent
          .map((item) => `- ${item.startedAt.slice(0, 10)} (${item.module}) ${clip(item.summary, 280)}`)
          .join("\n")}`
      : "No hay charlas anteriores.",
    threads.length ? `Hilos abiertos: ${threads.join(" | ")}` : "No hay hilos abiertos.",
    goals.length ? `Micro-metas pendientes: ${goals.join(" | ")}. Si encaja, preguntá por una sola, sin reto.` : "No hay micro-metas pendientes.",
  ];

  let instructions = blocks.filter(Boolean).join("\n\n");
  if (instructions.length > 12000) instructions = instructions.slice(0, 12000);

  const thread = threads[0] ?? null;
  const greetingCue = greetingFor({
    form,
    name: input.profile.displayName.trim(),
    consented: Boolean(input.profile.userConsentAt),
    thread,
    moduleLabel: MODULE_LABELS[input.plan.module],
    theme: input.plan.theme,
  });

  return { instructions, greetingCue };
}

function greetingFor(input: {
  form: AddressForm;
  name: string;
  consented: boolean;
  thread: string | null;
  moduleLabel: string;
  theme: string;
}): string {
  const who = input.name ? `Llamala ${input.name}.` : "No inventes un nombre.";
  if (!input.consented) {
    return `${who} Presentate como Clara, una inteligencia artificial. En dos frases explicá que podés recordar gustos e historias y que no das consejos médicos. Pedí un sí claro para guardar memoria. No abras otro tema. Una sola pregunta. Trato: ${input.form}.`;
  }
  const threadLine = input.thread ? `Si encaja, retomá este hilo en una frase: ${input.thread}.` : "No inventes un hilo de ayer.";
  return `${who} Saludá breve. ${threadLine} Después proponé, sin imponer, el tema de hoy (${input.moduleLabel}: ${input.theme}). Una sola pregunta. Trato: ${input.form}.`;
}

export function transcriptToText(turns: TranscriptTurn[]): string {
  return turns
    .map((turn) => `${turn.role === "user" ? "Persona" : "Clara"}: ${turn.text}`)
    .join("\n")
    .slice(0, 24000);
}
