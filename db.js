// 데이터베이스 계층: libSQL(Turso) 클라이언트.
//  - 배포(Vercel): TURSO_DATABASE_URL / TURSO_AUTH_TOKEN 환경변수로 Turso 원격 DB에 연결
//  - 로컬 개발: 환경변수가 없으면 data/calendar.db 파일(SQLite)을 그대로 사용
// 기존 node:sqlite 의 prepare().get/all/run 모양을 그대로 흉내 내되 모든 호출이 Promise 를 돌려준다.
import { createClient } from '@libsql/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.DATA_DIR || path.join(import.meta.dirname, 'data');
export const uploadDir = path.join(dataDir, 'uploads'); // 로컬 개발에서만 사용 (배포 시 첨부파일은 Vercel Blob)
export const usingRemote = !!process.env.TURSO_DATABASE_URL;

// Vercel(서버리스)은 파일을 쓸 수 없고 로컬 DB 파일도 의미가 없다. Turso 연결 정보가 빠졌을 때 시작 단계에서 죽지 않고,
// 요청을 받을 때 무엇이 빠졌는지 알려 주도록 한다. (/api/health 에 오류 문구가 나온다)
const misconfigured = !usingRemote && !!process.env.VERCEL;
if (!usingRemote && !misconfigured) fs.mkdirSync(dataDir, { recursive: true });
const url = usingRemote ? process.env.TURSO_DATABASE_URL : pathToFileURL(path.join(dataDir, 'calendar.db')).href;
const client = misconfigured ? null : createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
const useClient = () => {
  if (!client) throw Object.assign(new Error('DB 연결 정보가 없습니다. Vercel 환경변수 TURSO_DATABASE_URL 과 TURSO_AUTH_TOKEN 을 확인하세요.'), { status: 503 });
  return client;
};

// 트랜잭션 안에서 실행되는 모든 쿼리는 같은 트랜잭션 연결을 쓴다
const als = new AsyncLocalStorage();
const conn = () => als.getStore() ?? useClient();

const clean = (args) => args.map((a) => (a === undefined ? null : a));
const toPlain = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));

export const db = {
  prepare(sql) {
    return {
      get: async (...args) => toPlain(await conn().execute({ sql, args: clean(args) }))[0],
      all: async (...args) => toPlain(await conn().execute({ sql, args: clean(args) })),
      run: async (...args) => {
        const rs = await conn().execute({ sql, args: clean(args) });
        return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid == null ? undefined : Number(rs.lastInsertRowid) };
      },
    };
  },
  // 여러 문장(스키마 등) 실행
  async exec(sql) {
    const c = als.getStore();
    if (c) {
      for (const s of sql.split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean)) await c.execute(s);
    } else {
      await useClient().executeMultiple(sql);
    }
  },
};

/** 여러 문장을 한 번의 왕복으로 묶어 원자적으로 실행한다. list: [{ sql, args }] */
export async function batch(list) {
  if (!list.length) return [];
  const c = als.getStore();
  const stmts = list.map((s) => ({ sql: s.sql, args: clean(s.args || []) }));
  return c ? c.batch(stmts) : useClient().batch(stmts, 'write');
}

/** 트랜잭션: fn 안에서 일어난 쿼리는 모두 함께 커밋되거나 함께 취소된다. */
export async function tx(fn) {
  if (als.getStore()) return fn(); // 이미 트랜잭션 안이면 그대로 이어서 실행
  const t = await useClient().transaction('write');
  try {
    const r = await als.run(t, fn);
    await t.commit();
    return r;
  } catch (e) {
    try {
      await t.rollback();
    } catch {
      // 이미 닫힌 경우
    }
    throw e;
  } finally {
    t.close();
  }
}

// ───────── 스키마 ─────────
const SCHEMA_VERSION = '5';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  color TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  location TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '기타',
  visibility TEXT NOT NULL DEFAULT 'team',
  recur TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  occ TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  override TEXT,
  UNIQUE(event_id, occ)
);
CREATE TABLE IF NOT EXISTS attendees (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, user_id)
);
CREATE TABLE IF NOT EXISTS alarms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  minutes INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alarm_sent (
  alarm_id INTEGER NOT NULL REFERENCES alarms(id) ON DELETE CASCADE,
  occ TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (alarm_id, occ)
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  stored TEXT NOT NULL,
  size INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  ref_start TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);
CREATE TABLE IF NOT EXISTS trainings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  no TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  job TEXT NOT NULL DEFAULT '',
  dept TEXT NOT NULL DEFAULT '',
  rank TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  org TEXT NOT NULL DEFAULT '',
  course TEXT NOT NULL,
  days REAL NOT NULL DEFAULT 0,
  hours REAL NOT NULL DEFAULT 0,
  schedule_raw TEXT NOT NULL DEFAULT '',
  start_date TEXT,
  end_date TEXT,
  month INTEGER NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trainee_emails (
  company TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  PRIMARY KEY (company, name)
);
CREATE TABLE IF NOT EXISTS training_mail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  training_id INTEGER NOT NULL,
  lead INTEGER NOT NULL,
  email TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT NOT NULL DEFAULT '',
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tml_once ON training_mail_log (training_id, lead) WHERE ok = 1;
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS auto_done (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  occ TEXT NOT NULL,
  PRIMARY KEY (event_id, occ)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS login_attempts (
  email TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts (email, at);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS expirations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  expire_date TEXT NOT NULL,
  owner TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  alert_days TEXT NOT NULL DEFAULT '60,30,7',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS expiration_alerts (
  exp_id INTEGER NOT NULL REFERENCES expirations(id) ON DELETE CASCADE,
  lead INTEGER NOT NULL,
  expire_date TEXT NOT NULL,
  PRIMARY KEY (exp_id, lead, expire_date)
);
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  items TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS training_remind_log (
  training_id INTEGER NOT NULL,
  sent_on TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (training_id, sent_on)
);
`;

// 이전 버전 DB 에 뒤늦게 추가된 열 (새 DB 에는 ALTER 로 만들어진다)
const COLUMNS = [
  ['users', 'site', "TEXT NOT NULL DEFAULT ''"],
  ['users', 'dept', "TEXT NOT NULL DEFAULT ''"],
  ['users', 'position', "TEXT NOT NULL DEFAULT ''"],
  ['attachments', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'],
  ['attachments', 'created_at', 'TEXT'],
  ['attendees', 'response', "TEXT NOT NULL DEFAULT 'pending'"],
  ['events', 'assignee_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'],
  ['events', 'urgent', 'INTEGER NOT NULL DEFAULT 0'],
  ['events', 'importance', 'INTEGER NOT NULL DEFAULT 1'],
  ['events', 'status', "TEXT NOT NULL DEFAULT 'active'"],
  ['events', 'kind', "TEXT NOT NULL DEFAULT 'personal'"],
  ['events', 'edit_perm', "TEXT NOT NULL DEFAULT 'owner'"],
  ['trainings', 'cert_name', "TEXT NOT NULL DEFAULT ''"],
  ['trainings', 'cert_stored', "TEXT NOT NULL DEFAULT ''"],
];

async function migrate() {
  await useClient().execute('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const cur = (await useClient().execute("SELECT value FROM schema_meta WHERE key = 'version'")).rows[0]?.value;
  if (cur === SCHEMA_VERSION) return; // 이미 최신: 콜드 스타트에 쿼리 1번만 쓴다
  await useClient().executeMultiple(SCHEMA);
  for (const [table, col, ddl] of COLUMNS) {
    const have = (await useClient().execute(`PRAGMA table_info(${table})`)).rows.map((r) => r.name);
    if (have.includes(col)) continue;
    try {
      await useClient().execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    } catch (e) {
      if (!/duplicate column/i.test(String(e.message))) throw e; // 동시에 시작된 다른 인스턴스가 먼저 추가한 경우는 무시
    }
  }
  await useClient().execute("UPDATE events SET visibility = 'attendees' WHERE visibility = 'private'");
  await useClient().execute({ sql: "INSERT INTO schema_meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [SCHEMA_VERSION] });
}

/** 요청을 받기 전에 한 번 기다리는 초기화 (스키마 준비). 실패하면 다음 요청에서 다시 시도한다. */
let readyPromise = null;
export function ensureReady() {
  if (!readyPromise) {
    readyPromise = migrate().catch((e) => {
      readyPromise = null;
      throw e;
    });
  }
  return readyPromise;
}