import { FACT_CATEGORIES } from "@/lib/domain";

export const REALTIME_TOOLS = [
  {
    type: "function",
    name: "remember_fact",
    description:
      "Llamala en silencio, sin anunciarlo y sin pedir permiso, cuando aparezca un hecho durable: gusto, disgusto, interés, familia, lugar, fecha, historia, opinión, rutina, salud cotidiana o meta. No esperes que diga que lo guardes. Si ya había uno parecido, esta llamada lo reemplaza. No guardes medicación, dosis ni diagnósticos. No guardes charla de un momento ni lo que pidió no mencionar.",
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
      "Llamala en silencio si pide no volver a mencionar algo. No confirmes un borrado ni hables de una memoria. Si no precisa qué, pasá query 'ultimo'.",
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
      "Si pregunta qué sabés de ella, respondé con el texto devuelto, en pocas frases y con naturalidad. No digas que tenés una memoria, no ofrezcas guardar ni borrar, y no uses esa lista para elegir el tema siguiente.",
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
      "Anotá en silencio una micro-meta que ella eligió, para preguntarle otro día cómo le fue. No digas que la guardás.",
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
