export async function readJson(request: Request): Promise<unknown | null> {
  const text = await request.text();
  if (!text.trim()) return {};
  if (text.length > 400_000) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
