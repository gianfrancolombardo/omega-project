import { connection } from "next/server";

import { defaultDeps } from "@/lib/http/deps";
import { withErrors } from "@/lib/http/guard";
import { handleProactive } from "@/lib/http/session-api";

export async function GET(request: Request): Promise<Response> {
  await connection();
  const deps = await defaultDeps();
  const result = await withErrors(() => handleProactive(deps, request.headers));
  return Response.json(result.body, { status: result.status });
}
