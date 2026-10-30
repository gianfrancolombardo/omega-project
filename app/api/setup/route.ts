import { connection } from "next/server";

import { defaultDeps } from "@/lib/http/deps";
import { readJson } from "@/lib/http/body";
import { withErrors } from "@/lib/http/guard";
import { handleSetupGet, handleSetupPost, handleSetupPut } from "@/lib/http/setup-api";

export async function GET(request: Request): Promise<Response> {
  await connection();
  const deps = await defaultDeps();
  const result = await withErrors(() => handleSetupGet(deps, request.headers));
  return Response.json(result.body, { status: result.status });
}

export async function PUT(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (body === null) {
    return Response.json({ error: "bad_request", message: "El mensaje no es un JSON válido." }, { status: 400 });
  }
  const deps = await defaultDeps();
  const result = await withErrors(() => handleSetupPut(deps, request.headers, body));
  return Response.json(result.body, { status: result.status });
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (body === null) {
    return Response.json({ error: "bad_request", message: "El mensaje no es un JSON válido." }, { status: 400 });
  }
  const deps = await defaultDeps();
  const result = await withErrors(() => handleSetupPost(deps, request.headers, body));
  return Response.json(result.body, { status: result.status });
}
