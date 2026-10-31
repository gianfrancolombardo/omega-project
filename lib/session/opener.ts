import type { OpenerKind } from "@/lib/domain";
import { normalize } from "@/lib/text";

const UNSAFE_THREAD =
  /\b(salud|hospital|dolor|muerte|fallec|viud|perdid|enfermedad|cancer|medic|duelo|entierro|pastilla|diagnostico)\b/;

export function hashSeed(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash + value.charCodeAt(index) * (index + 1)) >>> 0;
  }
  return hash;
}

export function openerKindFor(sessionId: string): OpenerKind {
  return hashSeed(sessionId) % 2 ? "thread" : "today";
}

export function isSafeThread(thread: string): boolean {
  const value = normalize(thread);
  if (!value || value.length < 3) return false;
  return !UNSAFE_THREAD.test(value);
}
