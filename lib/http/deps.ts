import { allowSessionMint, assessPinAttempt, type PinLock } from "@/lib/auth/pin";
import { getStore } from "@/lib/db/index";
import type { MemoryStore } from "@/lib/db/memory-store";
import { parseEnv, type AppConfig } from "@/lib/env";
import { scheduleAfterResponse, type DeferFn } from "@/lib/http/defer";

export type PinCheck =
  | { ok: true }
  | { ok: false; status: number; body: { error: string; message: string } };

export type AppDeps = {
  config: AppConfig;
  store: MemoryStore;
  now: () => Date;
  fetchImpl: typeof fetch;
  authorize: (provided: string | null) => PinCheck;
  takeMint: () => { ok: boolean };
  defer: DeferFn;
};

let pinLock: PinLock = { failures: 0, lockedUntil: 0 };
let mintStamps: number[] = [];

export async function defaultDeps(): Promise<AppDeps> {
  const config = parseEnv(process.env);
  const store = await getStore();
  return {
    config,
    store,
    now: () => new Date(),
    fetchImpl: fetch,
    authorize(provided) {
      const result = assessPinAttempt({
        expected: config.setupPin,
        provided,
        now: Date.now(),
        lock: pinLock,
      });
      pinLock = result.lock;
      if (result.ok) return { ok: true };
      return { ok: false, status: result.status, body: { error: result.code, message: result.message } };
    },
    takeMint() {
      const result = allowSessionMint(mintStamps, Date.now());
      mintStamps = result.stamps;
      return { ok: result.ok };
    },
    defer: scheduleAfterResponse,
  };
}
