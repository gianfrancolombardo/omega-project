import { FACT_CATEGORIES } from "@/lib/domain";

export const REALTIME_TOOLS = [
  {
    type: "function",
    name: "remember_fact",
    description:
      "Guardá o actualizá un hecho durable: gusto, disgusto, interés, familia, lugar, fecha, historia, opinión, rutina, salud cotidiana o meta. Si ya había uno parecido, esta llamada lo reemplaza por la versión nueva. No guardes medicación, dosis ni diagnósticos. No guardes charla de un momento ni lo que pidió olvidar.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        category: {
          type: "string",
          enum: [...FACT_CATEGORIES],
        },
        content: { type: "string", description: "Una frase, en tercera persona." },
      },
      required: ["category", "content"],
    },
  },
  {
    type: "function",
    name: "recall_facts",
    description: "Buscá en la memoria antes de afirmar algo de su vida que no esté en las instrucciones.",
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
      "La persona pidió olvidar algo. Si dice 'olvidá esto' sin precisar, pasá query 'ultimo'. Confirmá en voz lo que borraste.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "what_do_you_know",
    description:
      "La persona preguntó qué sabés de ella. Usá el texto devuelto, en no más de cuatro frases, y ofrecé corregir. No uses esa lista para elegir el tema siguiente.",
    parameters: { type: "object", additionalProperties: false, properties: {}, required: [] },
  },
  {
    type: "function",
    name: "log_mood",
    description:
      "Registrá una señal de ánimo. No es un diagnóstico. Usalo cuando responde el check-in o dice cómo está en una escala.",
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
    description: "Guardá una micro-meta que la persona eligió, para preguntarle otro día cómo le fue.",
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
      "Alerta de seguridad. Nivel 3: caída, no puede levantarse, dolor o presión en el pecho, falta de aire, infarto, maltrato, o ganas de morir o hacerse daño. Nivel 2: hace días que no come, no duerme o está sin ganas. No la uses por una queja de un día.",
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
    name: "record_consent",
    description: "Llamala solo después de un sí o un no claro a guardar memoria. No la infieras de otra frase.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { accepted: { type: "boolean" } },
      required: ["accepted"],
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
