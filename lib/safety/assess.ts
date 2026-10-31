import type { AddressForm } from "@/lib/domain";
import { normalize } from "@/lib/text";

export type RiskKind = "none" | "suicide" | "emergency" | "distress";

export type RiskAssessment = {
  level: 0 | 2 | 3;
  kind: RiskKind;
  reason: string;
};

export const AFTERCARE =
  "Ya diste los números. Quedate con ella: preguntá si hay alguien en la casa y si está a salvo ahora. No vuelvas al tema anterior ni cierres la charla.";

export const PASSIVE_NOTE =
  "Preguntale directo y con calma si está pensando en hacerse daño. Si dice que sí, llamá flag_concern nivel 3.";

const SUICIDE = [
  /\bsuicid/,
  /\bme quiero morir\b(?! de)/,
  /\bno quiero vivir mas\b/,
  /\bno quiero seguir viviendo\b/,
  /\bquiero dejar de vivir\b/,
  /\bme voy a matar\b/,
  /\bquiero matarme\b/,
  /\btengo un plan para matarme\b/,
  /\bterminar con (todo|mi vida)\b/,
  /\bno vale la pena (seguir )?viv/,
  /\bmejor estar muerto\b/,
  /\bmejor no estar vivo\b/,
  /\bhacerme dano\b/,
  /\bme voy a hacer dano\b/,
  /\bno quiero amanecer\b/,
  /\bquitarme la vida\b/,
];

const PASSIVE = [
  /\bcansad[oa] de vivir\b/,
  /\bojala no (me )?despierte\b/,
  /\bsoy una carga\b/,
  /\bestaria mejor muert[oa]\b/,
  /\bpara que seguir\b/,
  /\bya vivi demasiado\b/,
  /\bya no le encuentro sentido\b/,
  /\bno le encuentro sentido a nada\b/,
];

const STROKE =
  /no puedo mover (el|la) (brazo|pierna|mano)|se me (durmio|cayo|torcio) (la cara|la boca|medio cuerpo)|no me salen las palabras/;

function isFigurative(text: string): boolean {
  return /de risa|de la risa|de ganas|de calor|de verguenza|matar el tiempo|cai en la cuenta/.test(text);
}

function isSuicide(text: string): boolean {
  return SUICIDE.some((pattern) => pattern.test(text));
}

function isPassiveIdeation(text: string): boolean {
  return PASSIVE.some((pattern) => pattern.test(text));
}

function isStroke(text: string): boolean {
  return STROKE.test(text);
}

function isEmergency(text: string): boolean {
  if (/(dolor|duele|aprieta|opresion|presion).{0,40}pecho|pecho.{0,30}(duele|aprieta|dolor|opresion)/.test(text)) {
    return true;
  }
  if (/no puedo respirar|me falta el aire|me estoy ahogando|no me entra el aire/.test(text)) return true;
  if (/\binfarto\b/.test(text)) return true;
  if (/me cai de la cama/.test(text)) return true;
  if (/estoy en el (piso|suelo)/.test(text) && /levant/.test(text)) return true;
  if (/me cai/.test(text) && /no (me )?puedo levantar|no puedo levantarme/.test(text)) return true;
  if (/no me puedo levantar|no puedo levantarme/.test(text) && /me cai|caida|piso|suelo/.test(text)) return true;
  if (/me (esta |estan )?pegando|me maltrata|alguien me pega/.test(text)) return true;
  if (isStroke(text)) return true;
  return false;
}

function isDistress(text: string): boolean {
  return /hace (dias|una semana|semanas) que no (como|duermo|tengo ganas)|no (como|duermo) hace (dias|una semana|semanas)/.test(
    text,
  );
}

export function assessUtterance(text: string): RiskAssessment {
  const normalized = normalize(text);
  if (!normalized) return { level: 0, kind: "none", reason: "" };
  const figurative = isFigurative(normalized);
  if (!figurative && isSuicide(normalized)) {
    return { level: 3, kind: "suicide", reason: "Ideación suicida" };
  }
  if (!figurative && isPassiveIdeation(normalized)) {
    return { level: 2, kind: "suicide", reason: "Ideación pasiva" };
  }
  const emergencyAllowed = !figurative || /pecho|infarto|piso|suelo|cama|pegando|maltrata|brazo|boca|palabras/.test(normalized);
  if (emergencyAllowed && isEmergency(normalized)) {
    return { level: 3, kind: "emergency", reason: "Posible emergencia física" };
  }
  if (isDistress(normalized)) {
    return { level: 2, kind: "distress", reason: "Malestar que se sostiene hace días" };
  }
  return { level: 0, kind: "none", reason: "" };
}

export function safetyScript(kind: Exclude<RiskKind, "none">, form: AddressForm): string {
  if (kind === "suicide") {
    return form === "usted"
      ? "Le pregunto directo: ¿está pensando en hacerse daño o en quitarse la vida? Si es así, llame ahora al 911. También puede llamar al 0800 0767, la línea de prevención del suicidio en Uruguay. No tiene que pasar por esto en soledad. Yo soy una inteligencia artificial y no puedo llamar por usted. Voy a dejar un aviso para su contacto de emergencia."
      : "Te pregunto directo: ¿estás pensando en hacerte daño o en quitarte la vida? Si es así, llamá ahora al 911. También podés llamar al 0800 0767, la línea de prevención del suicidio en Uruguay. No tenés que pasar por esto en soledad. Yo soy una inteligencia artificial y no puedo llamar por vos. Voy a dejar un aviso para tu contacto de emergencia.";
  }
  if (kind === "emergency") {
    return form === "usted"
      ? "Esto puede ser una emergencia. Llame ahora al 911. Si hay alguien cerca, pídale que llame. Yo soy una inteligencia artificial y no reemplazo a una ambulancia. Voy a dejar un aviso para su contacto de emergencia."
      : "Esto puede ser una emergencia. Llamá ahora al 911. Si hay alguien cerca, pedile que llame. Yo soy una inteligencia artificial y no reemplazo a una ambulancia. Voy a dejar un aviso para tu contacto de emergencia.";
  }
  return form === "usted"
    ? "Hace unos días que esto le pesa. No soy un servicio médico y no puedo dar un diagnóstico ni hablar de medicación. ¿Le parece comentarlo con su médico de cabecera? Si quiere, dejo un aviso a su contacto."
    : "Hace unos días que esto te pesa. No soy un servicio médico y no puedo dar un diagnóstico ni hablar de medicación. ¿Te parece comentarlo con tu médico de cabecera? Si querés, dejo un aviso a tu contacto.";
}
