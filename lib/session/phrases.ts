import { normalize } from "@/lib/text";

export function isDecline(text: string): boolean {
  const value = normalize(text);
  if (!value || value.length > 80) return false;
  return /^(ahora no|no ahora|despues|mas tarde|hoy no|no gracias|dejame(?: en paz)?|no quiero charlar|no quiero hablar|para un poco|despues charlamos)[. ]*$/.test(
    value,
  );
}

export function isGoodbye(text: string): boolean {
  const value = normalize(text);
  if (!value || value.length > 80) return false;
  return /^(chau|chao|adios|hasta manana|hasta luego|basta por hoy|paramos|corto aca)\b/.test(value);
}

export function isConsentYes(text: string): boolean {
  const value = normalize(text);
  if (!value || value.length > 40) return false;
  return /^(si|dale|bueno|acepto|de acuerdo|esta bien|ok|okay|por supuesto|claro)([, ]+(gracias|dale|esta bien))?[. ]*$/.test(
    value,
  );
}

export function isConsentNo(text: string): boolean {
  const value = normalize(text);
  if (!value || value.length > 40) return false;
  return /^(no|no quiero|prefiero que no|no guardes nada)[. ]*$/.test(value);
}
