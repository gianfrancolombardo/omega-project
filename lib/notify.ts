export type NotifyInput = {
  webhookUrl: string | null;
  level: 2 | 3;
  reason: string;
  excerpt: string;
  elderName: string;
  emergencyContact: string;
  at: string;
  fetchImpl?: typeof fetch;
};

export type NotifyResult = { status: "stub" | "sent" | "failed"; detail: string };

export async function dispatchAlert(input: NotifyInput): Promise<NotifyResult> {
  if (!input.webhookUrl) {
    return { status: "stub", detail: "Sin NOTIFY_WEBHOOK_URL: la alerta quedó guardada y no se envió." };
  }
  const payload = {
    source: "charla",
    level: input.level,
    reason: input.reason,
    excerpt: input.excerpt,
    elderName: input.elderName,
    emergencyContact: input.emergencyContact,
    at: input.at,
  };
  try {
    const response = await (input.fetchImpl ?? fetch)(input.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { status: "failed", detail: `El aviso respondió ${response.status}.` };
    return { status: "sent", detail: "Aviso enviado al contacto configurado." };
  } catch {
    return { status: "failed", detail: "No se pudo enviar el aviso." };
  }
}
