import type { Db } from "@/lib/db/sql";

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS profile (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    address_form TEXT NOT NULL,
    timezone TEXT NOT NULL,
    daily_time TEXT NOT NULL,
    proactive_enabled INTEGER NOT NULL,
    tastes TEXT NOT NULL,
    life_notes TEXT NOT NULL,
    avoid_topics TEXT NOT NULL,
    important_people TEXT NOT NULL,
    emergency_name TEXT NOT NULL,
    emergency_phone TEXT NOT NULL,
    emergency_relation TEXT NOT NULL,
    reduced_hearing INTEGER NOT NULL,
    subtitles INTEGER NOT NULL,
    user_consent_at TEXT,
    memory_declined_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    source_session_id TEXT,
    source TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    initiator TEXT NOT NULL,
    module TEXT NOT NULL,
    status TEXT NOT NULL,
    transcript_json TEXT NOT NULL,
    summary TEXT NOT NULL,
    open_threads_json TEXT NOT NULL,
    duration_seconds INTEGER,
    user_words INTEGER NOT NULL,
    agent_words INTEGER NOT NULL,
    misunderstood_count INTEGER NOT NULL,
    elderspeak_hits INTEGER NOT NULL,
    usage_json TEXT NOT NULL,
    cost_usd REAL,
    cost_approximate INTEGER NOT NULL,
    model TEXT NOT NULL,
    voice TEXT NOT NULL,
    summary_source TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS mood_signals (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    instrument TEXT NOT NULL,
    item_id TEXT NOT NULL,
    raw_answer TEXT NOT NULL,
    score REAL,
    note TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    level INTEGER NOT NULL,
    kind TEXT NOT NULL,
    reason TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    created_at TEXT NOT NULL,
    notify_status TEXT NOT NULL,
    notify_detail TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS microgoals (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    session_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS proactive_days (
    local_date TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    declined INTEGER NOT NULL,
    engaged INTEGER NOT NULL,
    next_retry_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS facts_created ON facts (created_at)",
  "CREATE INDEX IF NOT EXISTS sessions_started ON sessions (started_at)",
  "CREATE INDEX IF NOT EXISTS sessions_token ON sessions (token_hash)",
  "CREATE INDEX IF NOT EXISTS alerts_created ON alerts (created_at)",
];

// The database owner used by DATABASE_URL bypasses RLS. The public Supabase API does not.
export const POSTGRES_LOCKDOWN = [
  "ALTER TABLE profile ENABLE ROW LEVEL SECURITY",
  "ALTER TABLE facts ENABLE ROW LEVEL SECURITY",
  "ALTER TABLE sessions ENABLE ROW LEVEL SECURITY",
  "ALTER TABLE mood_signals ENABLE ROW LEVEL SECURITY",
  "ALTER TABLE alerts ENABLE ROW LEVEL SECURITY",
  "ALTER TABLE microgoals ENABLE ROW LEVEL SECURITY",
  "ALTER TABLE proactive_days ENABLE ROW LEVEL SECURITY",
];

export async function migrate(db: Db, nowIso: string, timezone: string, dialect: "sqlite" | "postgres" = "sqlite"): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await db.exec(statement);
  }
  if (dialect === "postgres") {
    for (const statement of POSTGRES_LOCKDOWN) {
      await db.exec(statement);
    }
  }
  await db.run(
    `INSERT INTO profile (
      id, display_name, address_form, timezone, daily_time, proactive_enabled,
      tastes, life_notes, avoid_topics, important_people,
      emergency_name, emergency_phone, emergency_relation,
      reduced_hearing, subtitles, user_consent_at, memory_declined_at,
      created_at, updated_at
    )
    SELECT 'primary', '', 'vos', ?, '11:00', 1,
      '', '', '', '',
      '', '', '',
      0, 1, NULL, NULL,
      ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM profile WHERE id = 'primary')`,
    [timezone, nowIso, nowIso],
  );
}
