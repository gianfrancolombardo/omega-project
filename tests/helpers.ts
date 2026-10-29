import { assessPinAttempt, allowSessionMint, type PinLock } from "@/lib/auth/pin";
import { openSqliteMemory } from "@/lib/db/sqlite";
import { migrate } from "@/lib/db/schema";
import { createMemoryStore, type MemoryStore } from "@/lib/db/memory-store";
import { parseEnv, type AppConfig } from "@/lib/env";
import type { AppDeps } from "@/lib/http/deps";

export async function memoryDb(now = "2026-10-29T14:00:00.000Z"): Promise<{ store: MemoryStore; close: () => void }> {
  const db = openSqliteMemory();
  await migrate(db, now, "America/Montevideo");
  return {
    store: createMemoryStore(db, { now: () => new Date(now) }),
    close: () => db.close(),
  };
}

export function depsFor(
  store: MemoryStore,
  overrides: Partial<AppConfig> = {},
  fetchImpl: typeof fetch = fetch,
  now = () => new Date("2026-10-29T14:00:00.000Z"),
): AppDeps {
  const config: AppConfig = {
    ...parseEnv({
      SETUP_PIN: "2468",
      OPENAI_API_KEY: "sk-test-secret",
      APP_TIMEZONE: "America/Montevideo",
      OPENAI_VOICE: "marin",
      OPENAI_REALTIME_MODEL: "gpt-realtime-2.1-mini",
    }),
    ...overrides,
  };
  let lock: PinLock = { failures: 0, lockedUntil: 0 };
  let stamps: number[] = [];
  return {
    config,
    store,
    now,
    fetchImpl,
    authorize(provided) {
      const result = assessPinAttempt({ expected: config.setupPin, provided, now: now().getTime(), lock });
      lock = result.lock;
      if (result.ok) return { ok: true };
      return { ok: false, status: result.status, body: { error: result.code, message: result.message } };
    },
    takeMint() {
      const result = allowSessionMint(stamps, now().getTime());
      stamps = result.stamps;
      return { ok: result.ok };
    },
  };
}

export function pinHeaders(pin = "2468"): Headers {
  return new Headers({ "x-setup-pin": pin });
}
