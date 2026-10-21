// 지금까지 쓰던 로컬 데이터(data/calendar.db, data/uploads)를 Turso(+Vercel Blob)로 옮기는 1회용 스크립트.
//
// 사용법 (PowerShell, work-calendar 폴더에서):
//   $env:TURSO_DATABASE_URL = "libsql://내DB이름-계정.turso.io"
//   $env:TURSO_AUTH_TOKEN   = "발급받은 토큰"
//   $env:BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_..."      # 첨부파일이 있을 때만 필요
//   node scripts/migrate-to-turso.mjs
//
// 옵션: --source=경로/calendar.db  (기본: data/calendar.db),  --force (대상 DB 에 이미 데이터가 있어도 덮어쓰기)
import { createClient } from '@libsql/client';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => (a.startsWith('--') ? a.slice(2).split('=') : [a, true])));
const root = path.join(import.meta.dirname, '..');
const sourcePath = path.resolve(args.source || path.join(process.env.DATA_DIR || path.join(root, 'data'), 'calendar.db'));

if (!process.env.TURSO_DATABASE_URL) {
  console.error('TURSO_DATABASE_URL 환경변수가 없습니다. 위 사용법을 확인하세요.');
  process.exit(1);
}
if (!fs.existsSync(sourcePath)) {
  console.error(`원본 DB 파일을 찾을 수 없습니다: ${sourcePath}`);
  process.exit(1);
}

// 대상 DB 연결과 스키마 생성은 앱과 같은 코드를 쓴다 (환경변수로 대상이 정해진다)
const { db, batch, ensureReady } = await import('../db.js');
const { saveFile, useBlob } = await import('../storage.js');
await ensureReady();

const source = createClient({ url: pathToFileURL(sourcePath).href });
const rowsOf = async (sql) => {
  const rs = await source.execute(sql);
  return rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
};

const existing = (await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n;
if (existing > 0 && !args.force) {
  console.error(`대상 DB 에 이미 사용자 ${existing}명이 있습니다. 덮어쓰려면 --force 를 붙이세요. (기존 데이터가 지워집니다)`);
  process.exit(1);
}

// 부모 → 자식 순서. sessions, login_attempts 는 옮기지 않는다 (모두 다시 로그인)
const TABLES = [
  'users', 'events', 'exceptions', 'attendees', 'alarms', 'alarm_sent', 'attachments', 'notifications', 'comments', 'history',
  'notes', 'trainings', 'app_settings', 'trainee_emails', 'training_mail_log', 'auto_done',
];

if (existing > 0) {
  console.log('--force: 대상 DB 의 기존 데이터를 지웁니다...');
  for (const t of [...TABLES].reverse()) await db.prepare(`DELETE FROM ${t}`).run();
  await db.prepare('DELETE FROM sessions').run();
}

const sourceTables = new Set((await rowsOf("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name));
let total = 0;
for (const table of TABLES) {
  if (!sourceTables.has(table)) {
    console.log(`  ${table}: (원본에 없음, 건너뜀)`);
    continue;
  }
  const targetCols = new Set((await db.prepare(`PRAGMA table_info(${table})`).all()).map((c) => c.name));
  const rows = await rowsOf(`SELECT * FROM ${table}`);
  if (!rows.length) {
    console.log(`  ${table}: 0건`);
    continue;
  }
  const cols = Object.keys(rows[0]).filter((c) => targetCols.has(c));
  const sql = `INSERT OR REPLACE INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  for (let i = 0; i < rows.length; i += 100) {
    await batch(rows.slice(i, i + 100).map((r) => ({ sql, args: cols.map((c) => r[c]) })));
  }
  total += rows.length;
  console.log(`  ${table}: ${rows.length}건`);
}

// 첨부파일: 로컬 폴더의 파일을 Vercel Blob 에 올리고 DB 의 저장 위치를 바꾼다
const atts = await db.prepare("SELECT id, filename, stored FROM attachments WHERE stored NOT LIKE 'blob:%'").all();
if (atts.length) {
  if (!useBlob) {
    console.log(`\n첨부파일 ${atts.length}개는 BLOB_READ_WRITE_TOKEN 이 없어 옮기지 못했습니다. 토큰을 넣고 --force 로 다시 실행하거나, 첨부파일은 새로 올려 주세요.`);
  } else {
    let moved = 0;
    for (const a of atts) {
      const p = path.join(process.env.DATA_DIR || path.join(root, 'data'), 'uploads', a.stored);
      if (!fs.existsSync(p)) {
        console.log(`  (파일 없음) ${a.filename}`);
        continue;
      }
      const stored = await saveFile(fs.readFileSync(p), a.filename, 'application/octet-stream');
      await db.prepare('UPDATE attachments SET stored = ? WHERE id = ?').run(stored, a.id);
      moved++;
    }
    console.log(`\n첨부파일 ${moved}/${atts.length}개를 Blob 으로 옮겼습니다.`);
  }
}
console.log(`\n완료: 총 ${total}건을 옮겼습니다. 이제 모두 새로 로그인해야 합니다.`);
process.exit(0);
