import type { AppConfig } from "@/lib/env";
import { parseEnv } from "@/lib/env";
import type { Db } from "@/lib/db/sql";
import { migrate } from "@/lib/db/schema";
import { openPostgres } from "@/lib/db/postgres";
import { createMemoryStore, type MemoryStore } from "@/lib/db/memory-store";

type Openers = {
  sqlite: (filePath: string) => Db;
  postgres: (databaseUrl: string) => Db;
};

const globalStore = globalThis as typeof globalThis & {
  __charlaStore?: Promise<MemoryStore>;
};

export function resetStoreForTests(): void {
  globalStore.__charlaStore = undefined;
}

export async function openStoreFromConfig(config: AppConfig, openers: Partial<Openers> = {}): Promise<MemoryStore> {
  const db = config.databaseUrl
    ? (openers.postgres ?? openPostgres)(config.databaseUrl)
    : (openers.sqlite ?? (await import("@/lib/db/sqlite")).openSqliteFile)(config.dbPath);
  await migrate(db, new Date().toISOString(), config.timezone, config.databaseUrl ? "postgres" : "sqlite");
  return createMemoryStore(db);
}

export function getStore(): Promise<MemoryStore> {
  if (!globalStore.__charlaStore) {
    globalStore.__charlaStore = openStoreFromConfig(parseEnv(process.env));
  }
  return globalStore.__charlaStore;
}
