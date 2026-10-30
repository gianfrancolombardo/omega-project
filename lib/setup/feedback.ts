export type ActionFeedback = {
  tone: "success" | "error";
  message: string;
};

export function saveProfileFeedback(input: {
  networkError: boolean;
  status: number | null;
  serverMessage: string | null;
}): ActionFeedback {
  if (input.networkError) {
    return {
      tone: "error",
      message: "No hay conexión. Revisá la red y probá de nuevo. La ficha no se guardó.",
    };
  }
  if (input.status === 401) {
    return {
      tone: "error",
      message: input.serverMessage?.trim() || "El PIN no coincide. La ficha no se guardó.",
    };
  }
  if (input.status !== 200) {
    return {
      tone: "error",
      message: input.serverMessage?.trim() || "No pude guardar la ficha. Probá de nuevo en un momento.",
    };
  }
  return { tone: "success", message: "Listo. La ficha quedó guardada." };
}

export function activateTabletFeedback(input: {
  networkError: boolean;
  status: number | null;
  serverMessage: string | null;
  storageError: boolean;
}): ActionFeedback {
  if (input.networkError) {
    return {
      tone: "error",
      message: "No hay conexión. Revisá la red y probá de nuevo. Esta tablet no quedó activada.",
    };
  }
  if (input.status === 401) {
    return {
      tone: "error",
      message: input.serverMessage?.trim() || "El PIN no coincide. Esta tablet no quedó activada.",
    };
  }
  if (input.status !== 200) {
    return {
      tone: "error",
      message: input.serverMessage?.trim() || "No pude activar la tablet. Probá de nuevo en un momento.",
    };
  }
  if (input.storageError) {
    return {
      tone: "error",
      message: "El PIN está bien, pero esta tablet no dejó guardar la activación. Revisá que el navegador permita guardar datos.",
    };
  }
  return { tone: "success", message: "Listo. Esta tablet ya puede charlar. Volvé a la pantalla grande." };
}
