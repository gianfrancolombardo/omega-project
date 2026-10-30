import { connection } from "next/server";

import { defaultDeps } from "@/lib/http/deps";
import { withErrors } from "@/lib/http/guard";
import { handlePublicProfile } from "@/lib/http/setup-api";

export async function GET(request: Request): Promise<Response> {
  await connection();
  const deps = await defaultDeps();
  const result = await withErrors(() => handlePublicProfile(deps, request.headers));
  return Response.json(result.body, { status: result.status });
}
