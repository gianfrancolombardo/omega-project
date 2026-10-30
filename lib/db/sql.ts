export type SqlValue = string | number | null;

export type SqlRow = Record<string, unknown>;

export interface Db {
  exec(sql: string): Promise<void>;
  all<T extends SqlRow = SqlRow>(sql: string, params?: SqlValue[]): Promise<T[]>;
  get<T extends SqlRow = SqlRow>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
}

export function sqlParams(params: unknown[] = []): SqlValue[] {
  return params.map((value) => {
    if (value == null) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "string") return value;
    return String(value);
  });
}

export function toPostgresSql(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}
