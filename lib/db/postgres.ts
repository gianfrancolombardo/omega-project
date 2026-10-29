import { Client, type ClientConfig } from "pg";

import { sqlParams, toPostgresSql, type Db, type SqlRow, type SqlValue } from "@/lib/db/sql";

export type QueryResult = {
  rows: SqlRow[];
  rowCount: number | null;
};

export type QueryClient = {
  query(sql: string, params?: SqlValue[]): Promise<QueryResult>;
};

export type SimpleConnection = {
  query(text: string): Promise<QueryResult>;
  end(): Promise<void>;
};

// Supabase transaction mode (port 6543) drops session state after each transaction.
// node-postgres sends parameters with the extended protocol, which that pooler rejects.
// Each call opens one client, sends a simple query with the values inlined, and closes it.
export function postgresClientConfig(databaseUrl: string): ClientConfig {
  const local = /localhost|127\.0\.0\.1/.test(databaseUrl);
  const sslDisabled = /(?:[?&])sslmode=disable(?:&|$)/.test(databaseUrl);
  return {
    connectionString: stripPoolerHints(databaseUrl),
    ssl: local || sslDisabled ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    application_name: "charla",
  };
}

export function stripPoolerHints(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    url.searchParams.delete("pgbouncer");
    url.searchParams.delete("sslmode");
    return url.toString();
  } catch {
    return databaseUrl;
  }
}

export function postgresLiteral(value: SqlValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${value.replaceAll("'", "''")}'`;
}

export function bindPostgresValues(sql: string, params: SqlValue[] = []): string {
  return sql.replace(/\$(\d+)\b/g, (_match, digits: string) => {
    const index = Number(digits) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= params.length) {
      throw new Error("SQL parameter count does not match");
    }
    return postgresLiteral(params[index] ?? null);
  });
}

export function createSimplePostgresClient(
  databaseUrl: string,
  connect: (config: ClientConfig) => Promise<SimpleConnection> = connectPg,
): QueryClient {
  const config = postgresClientConfig(databaseUrl);
  return {
    async query(sql, params = []) {
      const text = bindPostgresValues(sql, params);
      const connection = await connect(config);
      try {
        return await connection.query(text);
      } finally {
        await connection.end();
      }
    },
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

export function openPostgres(databaseUrl: string, clientFactory: (url: string) => QueryClient = createSimplePostgresClient): Db {
  return createPostgresDb(clientFactory(databaseUrl));
}

async function connectPg(config: ClientConfig): Promise<SimpleConnection> {
  const client = new Client(config);
  await client.connect();
  return {
    query: async (text) => {
      const result = await client.query(text);
      return { rows: result.rows as SqlRow[], rowCount: result.rowCount };
    },
    end: () => client.end(),
  };
}
