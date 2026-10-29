import { createHash, timingSafeEqual } from "node:crypto";

export type PinLock = { failures: number; lockedUntil: number };

export function pinsMatch(expected: string, provided: string): boolean {
  const left = createHash("sha256").update(expected).digest();
  const right = createHash("sha256").update(provided).digest();
  return timingSafeEqual(left, right);
}

export type PinAttempt =
  | { ok: true; lock: PinLock }
  | { ok: false; status: number; code: string; message: string; lock: PinLock };

export function assessPinAttempt(input: {
  expected: string | null;
  provided: string | null;
  now: number;
  lock: PinLock;
  maxFailures?: number;
  lockMs?: number;
}): PinAttempt {
  const maxFailures = input.maxFailures ?? 8;
  const lockMs = input.lockMs ?? 15 * 60 * 1000;
  if (!input.expected) {
    return {
      ok: false,
      status: 503,
      code: "missing_pin",
      message: "Falta SETUP_PIN en el servidor.",
      lock: input.lock,
    };
  }
  if (input.lock.lockedUntil > input.now) {
    return {
      ok: false,
      status: 429,
      code: "locked",
      message: "Demasiados intentos. Esperá unos minutos y probá de nuevo.",
      lock: input.lock,
    };
  }
  if (!input.provided || !pinsMatch(input.expected, input.provided)) {
    const failures = input.lock.failures + 1;
    const locked = failures >= maxFailures;
    return {
      ok: false,
      status: 401,
      code: "wrong_pin",
      message: "El PIN no coincide.",
      lock: { failures: locked ? 0 : failures, lockedUntil: locked ? input.now + lockMs : 0 },
    };
  }
  return { ok: true, lock: { failures: 0, lockedUntil: 0 } };
}

export function allowSessionMint(
  stamps: number[],
  now: number,
  limit = 30,
  windowMs = 60 * 60 * 1000,
): { ok: boolean; stamps: number[] } {
  const fresh = stamps.filter((stamp) => now - stamp < windowMs);
  if (fresh.length >= limit) return { ok: false, stamps: fresh };
  return { ok: true, stamps: [...fresh, now] };
}
