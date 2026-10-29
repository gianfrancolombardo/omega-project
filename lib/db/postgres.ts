import { Pool, type PoolConfig } from "pg";

import { sqlParams, toPostgresSql, type Db, type SqlRow, type SqlValue } from "@/lib/db/sql";

export type QueryResult = {
  rows: SqlRow[];
  rowCount: number | null;
};

export type QueryClient = {
  query(sql: string, params?: SqlValue[]): Promise<QueryResult>;
};

export function postgresPoolOptions(databaseUrl: string): PoolConfig {
  const local = /localhost|127\.0\.0\.1/.test(databaseUrl);
  const sslDisabled = /sslmode=disable/.test(databaseUrl);
  return {
    connectionString: databaseUrl,
    max: 1,
    ssl: local || sslDisabled ? undefined : { rejectUnauthorized: false },
  };
}

export function createPostgresDb(client: QueryClient): Db {
  return {
    async exec(sql: string) {
      await client.query(sql);
    },
    async all<T extends SqlRow>(sql: string, params: SqlValue[] = []) {
      const result = await client.query(toPostgresSql(sql), sqlParams(params));
      return result.rows as T[];
    },
    async get<T extends SqlRow>(sql: string, params: SqlValue[] = []) {
      const result = await client.query(toPostgresSql(sql), sqlParams(params));
      return result.rows[0] as T | undefined;
    },
    async run(sql: string, params: SqlValue[] = []) {
      const result = await client.query(toPostgresSql(sql), sqlParams(params));
      return { changes: result.rowCount ?? 0 };
    },
  };
}

export function openPostgres(databaseUrl: string, poolFactory: (url: string) => QueryClient = defaultPool): Db {
  return createPostgresDb(poolFactory(databaseUrl));
}

function defaultPool(databaseUrl: string): QueryClient {
  return new Pool(postgresPoolOptions(databaseUrl));
}
