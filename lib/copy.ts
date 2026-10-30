import type { AddressForm } from "@/lib/domain";
import { FACT_CATEGORIES, type FactCategory } from "@/lib/domain";

export const DEVICE_PIN_STORAGE_KEY = "charla.devicePin";
export const SETUP_PIN_STORAGE_KEY = "charla.setupPin";

export const FACT_CATEGORY_LABELS: Record<FactCategory, string> = {
  gusto: "Gusto",
  disgusto: "Disgusto",
  interes: "Interés",
  familia: "Familia",
  lugar: "Lugar",
  epoca: "Época",
  fecha: "Fecha",
  historia: "Historia",
  opinion: "Opinión",
  rutina: "Rutina",
  salud: "Salud cotidiana",
  meta: "Meta",
  otro: "Otro",
};

export const FACT_CATEGORY_OPTIONS = FACT_CATEGORIES.map((value) => ({
  value,
  label: FACT_CATEGORY_LABELS[value],
}));

export function idleLabel(form: AddressForm): string {
  return form === "usted" ? "Toque para charlar" : "Tocá para charlar";
}

export function listeningLabel(form: AddressForm): string {
  return form === "usted" ? "Lo escucho…" : "Te escucho…";
}

export function inviteLabel(form: AddressForm, name: string): string {
  const who = name.trim();
  if (form === "usted") {
    return who ? `${who}, buen día. ¿Charlamos un rato?` : "Buen día. ¿Charlamos un rato?";
  }
  return who ? `${who}, buen día. ¿Charlamos un rato?` : "Buen día. ¿Charlamos un rato?";
}

export function accidentalLine(form: AddressForm): string {
  return form === "usted" ? "Si me necesita, acá estoy." : "Si me necesitás, acá estoy.";
}

export function proactiveSilenceLine(form: AddressForm): string {
  return form === "usted"
    ? "Quedo por acá. Cuando quiera, toque la pantalla."
    : "Quedo por acá. Cuando quieras, tocá la pantalla.";
}

export function stillThereLine(form: AddressForm): string {
  return form === "usted" ? "¿Sigue ahí? Tómese su tiempo." : "¿Seguís ahí? Tomate tu tiempo.";
}

export function silenceCloseLine(form: AddressForm): string {
  return form === "usted"
    ? "Ya estuvo buena la charla. Seguimos mañana, si quiere."
    : "Ya estuvo buena la charla. Seguimos mañana, si querés.";
}

export function exactSpeech(line: string): string {
  return `Decí exactamente esta frase, sin agregar nada ni hacer otra pregunta: ${line}`;
}

export const ACTIVATION_MESSAGE =
  "Esta tablet todavía no está activada. Mantené presionada la hora de arriba unos segundos para abrir la configuración.";

export const MISSING_KEY_MESSAGE =
  "Falta la clave de OpenAI. Quien configura Charla tiene que cargar OPENAI_API_KEY en el servidor.";
