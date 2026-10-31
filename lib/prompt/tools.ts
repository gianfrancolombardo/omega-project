import { FACT_CATEGORIES } from "@/lib/domain";

export const REALTIME_TOOLS = [
  {
    type: "function",
    name: "recall_facts",
    description:
      "Consultá en silencio antes de afirmar un dato de su vida que no esté en las instrucciones. No digas que estás buscando ni que hay una memoria.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "forget_fact",
    description:
      "Llamala si pide no volver a mencionar algo o dice «olvidá eso». Si precisa el tema, pasá ese tema. Si no precisa, no adivines: pasá query 'ultimo' y preguntá «¿lo de …?» con un dato reciente.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "record_consent",
    description:
      "Solo si la persona dice por su cuenta que no quiere que te acuerdes de nada, o que sí. No lo pidas. No hables de permiso.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { accepted: { type: "boolean" } },
      required: ["accepted"],
    },
  },
  {
    type: "function",
    name: "what_do_you_know",
    description:
      "Si pregunta qué sabés de ella, respondé con el texto devuelto. Podés decir con naturalidad que te acordás de cosas que te contó. No ofrezcas guardar ni borrar.",
    parameters: { type: "object", additionalProperties: false, properties: {}, required: [] },
  },
  {
    type: "function",
    name: "log_mood",
    description:
      "Registrá en silencio una señal de ánimo. No es un diagnóstico y no digas que la registrás. Usalo cuando responde el check-in o dice cómo está.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        instrument: { type: "string", enum: ["ucla3", "who5", "phq2", "daily"] },
        item_id: { type: "string" },
        raw_answer: { type: "string" },
        score: { type: "number" },
        note: { type: "string" },
      },
      required: ["instrument", "item_id", "raw_answer"],
    },
  },
  {
    type: "function",
    name: "save_microgoal",
    description:
      "Anotá en silencio una micro-meta que ella eligió, concreta y para mañana. Mejor si incluye a alguien de su gente. No digas que la guardás.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { content: { type: "string" } },
      required: ["content"],
    },
  },
  {
    type: "function",
    name: "complete_microgoal",
    description: "La persona cuenta que cumplió una micro-meta. Marcala hecha.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "flag_concern",
    description:
      "Alerta de seguridad. Nivel 3: caída con no poder levantarse, dolor o presión en el pecho, falta de aire, signos de ACV, maltrato, o ganas de morir o hacerse daño. Nivel 2: hace días que no come, no duerme o está sin ganas; ideación pasiva. No la uses por una queja de un día ni por «no me puedo levantar» si es su día a día.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        level: { type: "integer", enum: [2, 3] },
        reason: { type: "string" },
        excerpt: { type: "string" },
      },
      required: ["level", "reason", "excerpt"],
    },
  },
  {
    type: "function",
    name: "decline_session",
    description: "Dijo que ahora no quiere charlar. Respetalo. No insistas.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        retry_ok: {
          type: "boolean",
          description: "true solo si pidió probar más tarde. false si el no es claro.",
        },
      },
      required: ["retry_ok"],
    },
  },
  {
    type: "function",
    name: "end_session",
    description: "Se quiere despedir: chau, basta por hoy, hasta mañana. Despedite en una frase y llamá esta herramienta.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
] as const;

export const FACT_TOOL_CATEGORIES = FACT_CATEGORIES;
