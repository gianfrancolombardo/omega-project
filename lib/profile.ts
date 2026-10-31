import {
  FACT_CATEGORIES,
  type AddressForm,
  type FactCategory,
  type ProfilePatch,
} from "@/lib/domain";
import { isValidTimeZone } from "@/lib/time";

const LIMITS = {
  displayName: 80,
  tastes: 2000,
  lifeNotes: 4000,
  avoidTopics: 1000,
  importantPeople: 2000,
  emergencyName: 80,
  emergencyPhone: 40,
  emergencyRelation: 80,
} as const;

export type ProfileParseResult =
  | { ok: true; value: ProfilePatch }
  | { ok: false; message: string };

function asRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  max: number,
): { ok: true; value?: string } | { ok: false; message: string } {
  if (!(key in source)) return { ok: true };
  const value = source[key];
  if (typeof value !== "string") return { ok: false, message: `El campo ${key} tiene que ser texto.` };
  return { ok: true, value: value.trim().slice(0, max) };
}

function optionalBoolean(
  source: Record<string, unknown>,
  key: string,
): { ok: true; value?: boolean } | { ok: false; message: string } {
  if (!(key in source)) return { ok: true };
  const value = source[key];
  if (typeof value !== "boolean") {
    return { ok: false, message: `El campo ${key} tiene que ser sí o no.` };
  }
  return { ok: true, value };
}

export function parseProfilePatch(input: unknown): ProfileParseResult {
  const source = asRecord(input);
  if (!source) return { ok: false, message: "El perfil llegó en un formato que no entiendo." };

  const patch: ProfilePatch = {};
  const stringFields: Array<[keyof ProfilePatch, keyof typeof LIMITS]> = [
    ["displayName", "displayName"],
    ["tastes", "tastes"],
    ["lifeNotes", "lifeNotes"],
    ["avoidTopics", "avoidTopics"],
    ["importantPeople", "importantPeople"],
    ["emergencyName", "emergencyName"],
    ["emergencyPhone", "emergencyPhone"],
    ["emergencyRelation", "emergencyRelation"],
  ];

  for (const [field, limitKey] of stringFields) {
    const parsed = optionalString(source, field, LIMITS[limitKey]);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) {
      (patch as Record<string, string>)[field] = parsed.value;
    }
  }

  if ("addressForm" in source) {
    const value = source.addressForm;
    if (value !== "vos" && value !== "usted") {
      return { ok: false, message: "El trato tiene que ser vos o usted." };
    }
    patch.addressForm = value satisfies AddressForm;
  }

  if ("dailyTime" in source) {
    const value = source.dailyTime;
    if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      return { ok: false, message: "La hora tiene que tener la forma HH:MM." };
    }
    patch.dailyTime = value;
  }

  if ("timezone" in source) {
    const value = source.timezone;
    if (typeof value !== "string" || !isValidTimeZone(value)) {
      return { ok: false, message: "No reconozco esa zona horaria." };
    }
    patch.timezone = value;
  }

  for (const field of ["proactiveEnabled", "reducedHearing", "subtitles"] as const) {
    const parsed = optionalBoolean(source, field);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) patch[field] = parsed.value;
  }

  return { ok: true, value: patch };
}

export function isFactCategory(value: string): value is FactCategory {
  return (FACT_CATEGORIES as string[]).includes(value);
}

const CLINICAL =
  /\b(medicaci[oó]n|medicamento|pastilla|comprimido|dosis|miligramos?|\d+\s?mg|diagn[oó]stico|receta)\b/i;

export function isClinicalContent(content: string): boolean {
  return CLINICAL.test(content);
}

export function memoryIsOpen(profile: { memoryDeclinedAt: string | null }): boolean {
  return !profile.memoryDeclinedAt;
}

export function parseFactInput(input: unknown):
  | { ok: true; category: FactCategory; content: string }
  | { ok: false; message: string } {
  const source = asRecord(input);
  if (!source) return { ok: false, message: "El recuerdo llegó en un formato que no entiendo." };
  const categoryValue = source.category;
  const contentValue = source.content;
  if (typeof categoryValue !== "string" || !isFactCategory(categoryValue)) {
    return { ok: false, message: "Elegí una categoría válida." };
  }
  if (typeof contentValue !== "string") {
    return { ok: false, message: "El recuerdo tiene que ser texto." };
  }
  const content = contentValue.trim().slice(0, 500);
  if (content.length < 2) return { ok: false, message: "El recuerdo es demasiado corto." };
  if (isClinicalContent(content)) {
    return { ok: false, message: "No guardo medicación ni diagnósticos." };
  }
  return { ok: true, category: categoryValue, content };
}
