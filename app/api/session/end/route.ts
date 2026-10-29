import { defaultDeps } from "@/lib/http/deps";
import { readJson } from "@/lib/http/body";
import { withErrors } from "@/lib/http/guard";
import { handleEndSession } from "@/lib/http/session-api";

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (body === null) {
    return Response.json({ error: "bad_request", message: "El mensaje no es un JSON válido." }, { status: 400 });
  }
  const deps = await defaultDeps();
  const result = await withErrors(() => handleEndSession(deps, request.headers, body));
  return Response.json(result.body, { status: result.status });
}
