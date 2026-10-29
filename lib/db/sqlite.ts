import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { sqlParams, type Db, type SqlRow, type SqlValue } from "@/lib/db/sql";

type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: SqlValue[]): SqlRow[];
    get(...params: SqlValue[]): SqlRow | undefined;
    run(...params: SqlValue[]): { changes: number | bigint };
  };
  close(): void;
};

function wrap(database: DatabaseSync): Db & { close(): void } {
  const db = database as unknown as SqliteDb;
  return {
    async exec(sql: string) {
      db.exec(sql);
    },
    async all<T extends SqlRow>(sql: string, params: SqlValue[] = []) {
      return db.prepare(sql).all(...sqlParams(params)) as T[];
    },
    async get<T extends SqlRow>(sql: string, params: SqlValue[] = []) {
      return db.prepare(sql).get(...sqlParams(params)) as T | undefined;
    },
    async run(sql: string, params: SqlValue[] = []) {
      const result = db.prepare(sql).run(...sqlParams(params));
      return { changes: Number(result.changes) };
    },
    close() {
      db.close();
    },
  };
}

export function openSqliteMemory(): Db & { close(): void } {
  return wrap(new DatabaseSync(":memory:"));
}

export function openSqliteFile(filePath: string): Db & { close(): void } {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const database = new DatabaseSync(filePath);
  try {
    database.exec("PRAGMA journal_mode = WAL");
  } catch {
    // Some in-memory or locked files reject WAL. The default journal still works.
  }
  database.exec("PRAGMA busy_timeout = 3000");
  return wrap(database);
}
