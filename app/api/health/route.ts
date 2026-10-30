import { connection } from "next/server";

import { defaultDeps } from "@/lib/http/deps";
import { withErrors } from "@/lib/http/guard";
import { handleHealth } from "@/lib/http/setup-api";

export async function GET(): Promise<Response> {
  await connection();
  const deps = await defaultDeps();
  const result = await withErrors(() => handleHealth(deps));
  return Response.json(result.body, { status: result.status });
}
