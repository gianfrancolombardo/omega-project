import type { AppDeps } from "@/lib/http/deps";

export type HttpResult = { status: number; body: unknown };

export function pinHeader(headers: Headers): string | null {
  const value = headers.get("x-setup-pin")?.trim();
  return value ? value : null;
}

export function requirePin(deps: AppDeps, headers: Headers): HttpResult | null {
  const result = deps.authorize(pinHeader(headers));
  if (result.ok) return null;
  return { status: result.status, body: result.body };
}

export async function withErrors(run: () => Promise<HttpResult>): Promise<HttpResult> {
  try {
    return await run();
  } catch {
    return { status: 500, body: { error: "server", message: "Algo falló del lado de Charla. Probá de nuevo." } };
  }
}
