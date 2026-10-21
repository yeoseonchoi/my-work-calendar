import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.DATA_DIR || path.join(import.meta.dirname, 'data');
fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'calendar.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

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
  start TEXT NOT NULL,          -- 'YYYY-MM-DDTHH:mm' (종일이면 'YYYY-MM-DD'), 타임존 없는 로컬 시각
  end TEXT NOT NULL,            -- 종일이면 마지막 날짜(포함)
  all_day INTEGER NOT NULL DEFAULT 0,
  location TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '기타',
  visibility TEXT NOT NULL DEFAULT 'team',   -- team | private
  recur TEXT,                                 -- 반복 규칙 JSON (없으면 NULL)
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  occ TEXT NOT NULL,            -- 원래 회차 시작 키
  deleted INTEGER NOT NULL DEFAULT 0,
  override TEXT,                -- 변경된 필드 JSON
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
`);

db.exec(`
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,            -- invite | assign | change | cancel | restore | delete | reminder | response | comment
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  ref_start TEXT,                -- 알림을 눌렀을 때 이동할 일정 시작일
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
  kind TEXT NOT NULL DEFAULT '',        -- 직무 / 계층 / 원가 / 일반
  org TEXT NOT NULL DEFAULT '',         -- 교육기관
  course TEXT NOT NULL,                 -- 교육과목
  days REAL NOT NULL DEFAULT 0,
  hours REAL NOT NULL DEFAULT 0,
  schedule_raw TEXT NOT NULL DEFAULT '',
  start_date TEXT,
  end_date TEXT,
  month INTEGER NOT NULL DEFAULT 0,     -- 1~12, 0 = 일정 미정
  cost INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT '',      -- 이수 / 취소 / 퇴사 / 육아휴직 / 다른교육으로대체 / (빈칸=예정·미입력)
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trainee_emails (       -- 교육 대상자 메일 주소 (앱 계정과 별개)
  company TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  PRIMARY KEY (company, name)
);
CREATE TABLE IF NOT EXISTS training_mail_log (    -- 교육 참석 요청 메일 발송 이력
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  training_id INTEGER NOT NULL,
  lead INTEGER NOT NULL,                          -- 교육 시작 며칠 전 메일인지
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
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,          -- created | updated | cancelled | restored | response
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

// 기존 DB 마이그레이션: 일정 종류(개인/팀), 수정 권한, 담당자, 상태, 참석 응답
// 소속 정보 (공장·팀·직책): 통합 일정관리의 공장/팀/구성원 필터에 사용
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
for (const col of ['site', 'dept', 'position']) {
  if (!userCols.includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
}
const fileCols = db.prepare('PRAGMA table_info(attachments)').all().map((c) => c.name);
if (!fileCols.includes('user_id')) db.exec('ALTER TABLE attachments ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
if (!fileCols.includes('created_at')) db.exec('ALTER TABLE attachments ADD COLUMN created_at TEXT');
const attCols = db.prepare('PRAGMA table_info(attendees)').all().map((c) => c.name);
if (!attCols.includes('response')) db.exec("ALTER TABLE attendees ADD COLUMN response TEXT NOT NULL DEFAULT 'pending'");
const eventCols = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
if (!eventCols.includes('assignee_id')) db.exec('ALTER TABLE events ADD COLUMN assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
if (!eventCols.includes('urgent')) db.exec('ALTER TABLE events ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0');
if (!eventCols.includes('importance')) db.exec('ALTER TABLE events ADD COLUMN importance INTEGER NOT NULL DEFAULT 1'); // 0 낮음 / 1 보통 / 2 높음
if (!eventCols.includes('status')) db.exec("ALTER TABLE events ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
if (!eventCols.includes('kind')) db.exec("ALTER TABLE events ADD COLUMN kind TEXT NOT NULL DEFAULT 'personal'");
if (!eventCols.includes('edit_perm')) db.exec("ALTER TABLE events ADD COLUMN edit_perm TEXT NOT NULL DEFAULT 'owner'");
db.exec("UPDATE events SET visibility = 'attendees' WHERE visibility = 'private'");

export const uploadDir = path.join(dataDir, 'uploads');

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
