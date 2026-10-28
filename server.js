import './env.js';
import express from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import crypto from 'node:crypto';
import path from 'node:path';
import { db, tx, batch, ensureReady } from './db.js';
import { saveFile, openFile, removeFile, storageMode, MAX_UPLOAD_BYTES } from './storage.js';
import { parse, fmt, fmtDate, fmtTime, expand, span, floatingNow, DAY } from './recur.js';
import { startScheduler, runScheduledJobs } from './scheduler.js';
import { mailConfigured } from './mailer.js';
import { pushNote, addHistory } from './notify.js';
import { parseTrainingWorkbook, buildTrainingReport } from './training.js';
import { parseAlertDays, DEFAULT_ALERT_DAYS } from './expirations.js';
import {
  incompleteToday, remindIncomplete,
  getSettings as getTrainingMailSettings, saveSettings as saveTrainingMailSettings, LEAD_CHOICES, isEmail, MAIL_SUBJECT, DEFAULT_INTRO, DEFAULT_OUTRO,
  dueToday, upcomingSends, runDue as runTrainingMailDue, sendTestMail as sendTrainingTestMail,
} from './training-mail.js';

const root = import.meta.dirname;
const PORT = +(process.env.PORT || 3000);
const COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#d6336c', '#5c940d', '#4263eb', '#868e96'];

const app = express();
app.use(express.json({ limit: '1mb' }));
// Vercel 에서는 public/ 폴더가 CDN 으로 직접 서비스되고 이 줄은 무시된다. (로컬 실행용)
app.use(express.static(path.join(root, 'public')));
// Vercel 에서는 화면 파일이 CDN 에서 제공되고 "/" 는 이 함수로 오므로, 첫 화면 파일로 보낸다.
app.get('/', (_req, res) => res.redirect(302, '/index.html'));

// 요청을 처리하기 전에 DB 스키마가 준비돼 있도록 기다린다 (서버리스 콜드 스타트 대응)
app.use('/api', async (req, _res, next) => {
  if (req.path === '/health') return next(); // 상태 확인은 DB 가 안 돼도 오류 이유를 알려 줘야 하므로 건너뛴다
  try {
    await ensureReady();
    next();
  } catch (e) {
    next(e);
  }
});

// 첨부파일은 메모리로 받아 저장소(Vercel Blob / 로컬 폴더)에 올린다. Vercel 요청 본문 한도(4.5MB) 때문에 배포 시 4MB 로 제한된다.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 10 } });

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ---------- 인증 ----------
// HTTPS(Vercel)에서는 쿠키에 Secure 를 붙여 암호화된 연결로만 전송되게 한다
const SECURE_COOKIE = process.env.VERCEL ? '; Secure' : '';

const hashPw = (pw) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
};
const checkPw = (pw, stored) => {
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const getCookie = (req, name) => {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
};
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, color: u.color, role: u.role, site: u.site || '', dept: u.dept || '', position: u.position || '' });
const cleanOrg = (b) => ({
  site: String(b?.site || '').trim().slice(0, 30),
  dept: String(b?.dept || '').trim().slice(0, 30),
  position: String(b?.position || '').trim().slice(0, 30),
});

async function auth(req, res, next) {
  const token = getCookie(req, 'sid');
  const u = token && (await db.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.created_at > datetime('now', '-30 days')").get(token));
  if (!u) return res.status(401).json({ error: '로그인이 필요합니다.' });
  req.user = u;
  next();
}
async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${SECURE_COOKIE}`);
}

app.post('/api/register', async (req, res) => {
  const { email, name, password, joinCode } = req.body || {};
  if (!email || !name || !password) return res.status(400).json({ error: '이메일, 이름, 비밀번호를 입력하세요.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: '이메일 형식이 올바르지 않습니다.' });
  if (password.length < 6) return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });
  if (process.env.JOIN_CODE && joinCode !== process.env.JOIN_CODE) return res.status(403).json({ error: '가입 코드가 올바르지 않습니다.' });
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.toLowerCase())) return res.status(409).json({ error: '이미 가입된 이메일입니다.' });
  const count = (await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n;
  const org = cleanOrg(req.body);
  const r = await db
    .prepare('INSERT INTO users (email, name, pw_hash, role, color, site, dept, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(email.toLowerCase(), name.trim(), hashPw(password), count === 0 ? 'admin' : 'member', COLORS[count % COLORS.length], org.site, org.dept, org.position);
  await startSession(res, Number(r.lastInsertRowid));
  res.json(publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)));
});

// 로그인 시도 제한: 같은 이메일로 15분 안에 8번 틀리거나, 같은 IP 에서 60번 틀리면 잠시 막는다 (비밀번호 무차별 대입 방지)
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const mail = String(email || '').toLowerCase();
  const ip = clientIp(req);
  const recent = await db.prepare("SELECT SUM(email = ?) AS by_email, SUM(ip = ?) AS by_ip FROM login_attempts WHERE at > datetime('now', '-15 minutes')").get(mail, ip);
  if ((recent?.by_email || 0) >= 8 || (recent?.by_ip || 0) >= 60) return res.status(429).json({ error: '로그인 시도가 너무 많습니다. 15분 뒤에 다시 시도하세요.' });
  const u = await db.prepare('SELECT * FROM users WHERE email = ?').get(mail);
  if (!u || !checkPw(String(password || ''), u.pw_hash)) {
    await db.prepare('INSERT INTO login_attempts (email, ip) VALUES (?, ?)').run(mail, ip);
    return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
  }
  await db.prepare('DELETE FROM login_attempts WHERE email = ? OR at < datetime(\'now\', \'-1 day\')').run(mail);
  await db.prepare("DELETE FROM sessions WHERE created_at < datetime('now', '-30 days')").run(); // 만료된 세션 정리
  await startSession(res, u.id);
  res.json(publicUser(u));
});

app.post('/api/logout', async (req, res) => {
  const token = getCookie(req, 'sid');
  if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', `sid=; HttpOnly; Path=/; Max-Age=0${SECURE_COOKIE}`);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ ...publicUser(req.user), mailConfigured: mailConfigured() }));
app.get('/api/users', auth, async (req, res) =>
  res.json(
    (await db
      .prepare('SELECT id, name, color, email, role, site, dept, position FROM users ORDER BY id')
      .all())
      .map((u) => (req.user.role === 'admin' ? u : { id: u.id, name: u.name, color: u.color, site: u.site, dept: u.dept, position: u.position })),
  ),
);

// 내 소속 정보 수정 / 관리자가 팀원 소속 정보 수정
app.put('/api/me/profile', auth, async (req, res) => {
  const o = cleanOrg(req.body);
  await db.prepare('UPDATE users SET site = ?, dept = ?, position = ? WHERE id = ?').run(o.site, o.dept, o.position, req.user.id);
  res.json({ ok: true });
});
app.put('/api/users/:id/profile', auth, async (req, res, next) => {
  if (req.user.role !== 'admin') return next(httpError(403, '관리자만 사용할 수 있습니다.'));
  const o = cleanOrg(req.body);
  await db.prepare('UPDATE users SET site = ?, dept = ?, position = ? WHERE id = ?').run(o.site, o.dept, o.position, req.params.id);
  res.json({ ok: true });
});
const userNames = async () => new Map((await db.prepare('SELECT id, name FROM users').all()).map((u) => [u.id, u.name]));

// ---------- 비밀번호 / 사용자 관리 ----------
const adminOnly = (req, _res, next) => (req.user.role === 'admin' ? next() : next(httpError(403, '관리자만 사용할 수 있습니다.')));

// 본인 비밀번호 변경 (현재 세션 외 다른 로그인은 해제)
app.post('/api/me/password', auth, async (req, res) => {
  const { current, password } = req.body || {};
  if (!checkPw(String(current || ''), req.user.pw_hash)) throw httpError(400, '현재 비밀번호가 올바르지 않습니다.');
  if (String(password || '').length < 6) throw httpError(400, '새 비밀번호는 6자 이상이어야 합니다.');
  await db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(hashPw(password), req.user.id);
  await db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, getCookie(req, 'sid'));
  res.json({ ok: true });
});

// 관리자가 팀원 비밀번호를 임시 비밀번호로 재설정
app.post('/api/users/:id/reset-password', auth, adminOnly, async (req, res) => {
  const u = await db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!u) throw httpError(404, '사용자를 찾을 수 없습니다.');
  const temp = crypto.randomBytes(6).toString('base64url');
  await db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(hashPw(temp), u.id);
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  res.json({ password: temp });
});

// 관리자가 팀원 삭제 (그 사람이 등록한 일정·첨부파일도 함께 삭제)
app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) throw httpError(404, '사용자를 찾을 수 없습니다.');
  if (u.id === req.user.id) throw httpError(400, '본인 계정은 삭제할 수 없습니다.');
  const owned = await db.prepare('SELECT id FROM events WHERE owner_id = ?').all(u.id);
  for (const e of owned) await deleteEventCascade(e.id); // 그 팀원이 등록한 일정(첨부파일 포함)을 모두 지운다
  // 나머지 흔적 정리 (DB 의 외래키 연쇄 삭제에 의존하지 않고 직접 지운다)
  await batch([
    { sql: 'DELETE FROM attendees WHERE user_id = ?', args: [u.id] },
    { sql: 'UPDATE events SET assignee_id = NULL WHERE assignee_id = ?', args: [u.id] },
    { sql: 'DELETE FROM comments WHERE user_id = ?', args: [u.id] },
    { sql: 'UPDATE history SET user_id = NULL WHERE user_id = ?', args: [u.id] },
    { sql: 'UPDATE attachments SET user_id = NULL WHERE user_id = ?', args: [u.id] },
    { sql: 'DELETE FROM notifications WHERE user_id = ?', args: [u.id] },
    { sql: 'DELETE FROM notes WHERE user_id = ?', args: [u.id] },
    { sql: 'DELETE FROM sessions WHERE user_id = ?', args: [u.id] },
    { sql: 'DELETE FROM users WHERE id = ?', args: [u.id] },
  ]);
  res.json({ ok: true });
});

// 일정 한 건과 딸린 데이터(참석자·알람·예외·댓글·이력·알림·첨부파일)를 함께 지운다
async function deleteEventCascade(id) {
  const files = await db.prepare('SELECT stored FROM attachments WHERE event_id = ?').all(id);
  await batch([
    { sql: 'DELETE FROM alarm_sent WHERE alarm_id IN (SELECT id FROM alarms WHERE event_id = ?)', args: [id] },
    ...['alarms', 'attendees', 'exceptions', 'attachments', 'comments', 'history', 'notifications', 'auto_done'].map((t) => ({ sql: `DELETE FROM ${t} WHERE event_id = ?`, args: [id] })),
    { sql: 'DELETE FROM events WHERE id = ?', args: [id] },
  ]);
  for (const f of files) await removeFile(f.stored);
}

// ---------- 권한 ----------
const CATEGORIES = ['회의', '외근', '출장', '휴가', '교육', '기타'];
const RESPONSES = { pending: '미응답', yes: '참석', no: '불참', maybe: '미정' };

// 공개 범위: team(전체 공개) / attendees(등록자·참석자·담당자만) / me(등록자만)
const isInvolved = (ev, att, userId) => (att || []).some((a) => a.user_id === userId) || ev.assignee_id === userId;
const canSee = (ev, att, userId) =>
  ev.visibility === 'team' || ev.owner_id === userId || (ev.visibility === 'attendees' && isInvolved(ev, att, userId));
// 설정(종류·공개범위·수정권한)을 바꾸거나 삭제할 수 있는 사람: 등록자·관리자
const canManage = (ev, user) => ev.owner_id === user.id || user.role === 'admin';
// 수정 권한: owner(등록자만) / attendees(참석자·담당자도) / team(볼 수 있는 모든 팀원)
const canEditEvent = (ev, att, user) =>
  canManage(ev, user) ||
  (ev.edit_perm === 'attendees' && isInvolved(ev, att, user.id)) ||
  (ev.edit_perm === 'team' && canSee(ev, att, user.id));

const attendeesOf = async (eventId) => await db.prepare('SELECT user_id, response FROM attendees WHERE event_id = ?').all(eventId);
// 일정과 관련된 모든 사람(등록자·참석자·담당자)
const involvedIds = async (ev, att) => {
  att ??= await attendeesOf(ev.id);
  return [ev.owner_id, ev.assignee_id, ...att.map((a) => a.user_id)].filter(Boolean);
};

// ---------- 일정 조회 ----------
// 일정 화면에 필요한 모든 데이터를 한 번에 읽는다. (원격 DB 라 왕복 횟수가 곧 속도이므로 쿼리를 동시에 실행)
const groupBy = (rows, key = 'event_id') => {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[key])) m.set(r[key], []);
    m.get(r[key]).push(r);
  }
  return m;
};
async function loadEvents() {
  const q = (sql) => db.prepare(sql).all();
  const [events, attendees, alarms, attachments, lastEdit, exceptions, comments] = await Promise.all([
    q('SELECT e.*, u.name AS owner_name, u.color AS owner_color FROM events e JOIN users u ON u.id = e.owner_id'),
    q('SELECT event_id, user_id, response FROM attendees'),
    q('SELECT event_id, minutes FROM alarms ORDER BY minutes'),
    q('SELECT a.id, a.event_id, a.filename, a.size, a.created_at, u.name AS uploader FROM attachments a LEFT JOIN users u ON u.id = a.user_id'),
    // 일정별 마지막 변경자 / 변경 시각 (댓글·참석 응답은 제외)
    q("SELECT h.event_id, u.name, h.created_at FROM history h LEFT JOIN users u ON u.id = h.user_id WHERE h.id IN (SELECT MAX(id) FROM history WHERE action IN ('created', 'updated', 'cancelled', 'done', 'restored') AND user_id IS NOT NULL GROUP BY event_id)"),
    q('SELECT * FROM exceptions'),
    q('SELECT event_id, COUNT(*) AS n FROM comments GROUP BY event_id'),
  ]);
  return {
    events,
    attendees: groupBy(attendees),
    alarms: groupBy(alarms),
    attachments: groupBy(attachments),
    lastEdit: new Map(lastEdit.map((r) => [r.event_id, r])),
    exceptions: groupBy(exceptions),
    comments: new Map(comments.map((r) => [r.event_id, r.n])),
  };
}

async function visibleOccurrences(user, from, to) {
  const d = await loadEvents();
  const out = [];
  for (const ev of d.events) {
    const att = d.attendees.get(ev.id);
    if (!canSee(ev, att, user.id)) continue;
    for (const occ of expand(ev, from, to, d.exceptions.get(ev.id) || [])) {
      out.push({
        ev, occ, att: att || [], alarms: d.alarms.get(ev.id) || [], files: d.attachments.get(ev.id) || [],
        commentCount: d.comments.get(ev.id) || 0, last: d.lastEdit.get(ev.id),
      });
    }
  }
  return out;
}

const parseRange = (q) => [parse(String(q.start).slice(0, 19)), parse(String(q.end).slice(0, 19))];

function toEvent({ ev, occ, att, alarms, files, commentCount, last }, user, names) {
  const e = occ.ev;
  return {
    id: `${ev.id}|${occ.key}`,
    title: e.title,
    start: e.start,
    end: e.all_day ? fmtDate(occ.endMs) : fmtTime(occ.endMs),
    allDay: !!e.all_day,
    color: ev.owner_color,
    extendedProps: {
      eventId: ev.id,
      occ: occ.key,
      ownerId: ev.owner_id,
      ownerName: ev.owner_name,
      assigneeId: ev.assignee_id,
      assigneeName: ev.assignee_id ? names.get(ev.assignee_id) || '' : '',
      status: e.status || 'active',
      urgent: !!e.urgent,
      importance: e.importance ?? 1,
      category: e.category,
      location: e.location,
      memo: e.memo,
      kind: ev.kind,
      visibility: ev.visibility,
      editPerm: ev.edit_perm,
      recur: ev.recur ? JSON.parse(ev.recur) : null,
      isException: occ.isException,
      rawStart: e.start,
      rawEnd: e.end,
      attendees: att.map((a) => a.user_id),
      responses: Object.fromEntries(att.map((a) => [a.user_id, a.response])),
      myResponse: att.find((a) => a.user_id === user.id)?.response || null,
      alarms: alarms.map((a) => a.minutes),
      attachments: files.map((f) => ({ id: f.id, filename: f.filename, size: f.size, uploader: f.uploader || '', uploadedAt: f.created_at || '' })),
      commentCount,
      lastEditor: last?.name || '',
      lastEditedAt: last?.created_at || '',
      canEdit: canEditEvent(ev, att, user),
      canManage: canManage(ev, user),
    },
  };
}

app.get('/api/events', auth, async (req, res) => {
  if (!req.query.start || !req.query.end) return res.status(400).json({ error: 'start, end 필요' });
  const [from, to] = parseRange(req.query);
  const names = await userNames();
  res.json((await visibleOccurrences(req.user, from, to)).map((it) => toEvent(it, req.user, names)));
});

// 검색·필터: 기간 / 제목(키워드) / 담당자 / 참석자 / 일정 종류
app.get('/api/search', auth, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const now = floatingNow();
  const from = /^\d{4}-\d\d-\d\d/.test(req.query.from || '') ? parse(req.query.from) : now - 30 * DAY;
  const to = /^\d{4}-\d\d-\d\d/.test(req.query.to || '') ? parse(req.query.to) + DAY : now + 180 * DAY;
  const assignee = +req.query.assignee || null;
  const attendee = +req.query.attendee || null;
  const owner = +req.query.owner || null;
  const kind = ['personal', 'team'].includes(req.query.kind) ? req.query.kind : null;
  const category = CATEGORIES.includes(req.query.category) ? req.query.category : null;
  const status = ['active', 'done', 'cancelled'].includes(req.query.status) ? req.query.status : null;
  const urgentOnly = req.query.urgent === '1';
  const importance = ['0', '1', '2'].includes(req.query.importance) ? +req.query.importance : null;
  const names = await userNames();
  const items = (await visibleOccurrences(req.user, from, to))
    .filter(({ ev, occ, att }) => {
      const e = occ.ev;
      if (status && (e.status || 'active') !== status) return false;
      if (urgentOnly && !e.urgent) return false;
      if (importance !== null && e.importance !== importance) return false;
      if (kind && ev.kind !== kind) return false;
      if (category && e.category !== category) return false;
      if (assignee && ev.assignee_id !== assignee) return false;
      if (owner && ev.owner_id !== owner) return false;
      if (attendee && !att.some((a) => a.user_id === attendee)) return false;
      if (q) {
        const hay = [e.title, e.location, e.memo, ev.owner_name, names.get(ev.assignee_id)].join('\n').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => a.occ.startMs - b.occ.startMs);
  res.json({ total: items.length, items: items.slice(0, 300).map((it) => toEvent(it, req.user, names)) });
});

// ---------- 일정 저장 ----------
async function clean(b) {
  const title = String(b.title || '').trim();
  if (!title) throw httpError(400, '제목을 입력하세요.');
  const all_day = b.all_day ? 1 : 0;
  const re = all_day ? /^\d{4}-\d\d-\d\d$/ : /^\d{4}-\d\d-\d\dT\d\d:\d\d$/;
  if (!re.test(b.start || '') || !re.test(b.end || '')) throw httpError(400, '날짜/시간 형식이 올바르지 않습니다.');
  if (parse(b.end) < parse(b.start)) throw httpError(400, '종료가 시작보다 빠를 수 없습니다.');
  let recur = null;
  if (b.recur && b.recur.freq) {
    const r = b.recur;
    if (!['daily', 'weekly', 'monthly', 'yearly'].includes(r.freq)) throw httpError(400, '반복 주기가 올바르지 않습니다.');
    recur = {
      freq: r.freq,
      interval: Math.min(99, Math.max(1, +r.interval || 1)),
      weekdays: (r.weekdays || []).map(Number).filter((d) => d >= 0 && d <= 6),
      monthlyMode: r.monthlyMode === 'nth' ? 'nth' : 'date',
      endType: ['until', 'count'].includes(r.endType) ? r.endType : 'never',
      until: r.until || null,
      count: r.count ? Math.min(1000, +r.count) : null,
    };
    if (recur.endType === 'until' && !/^\d{4}-\d\d-\d\d$/.test(recur.until || '')) throw httpError(400, '반복 종료일을 입력하세요.');
  }
  const assignee_id = +b.assignee_id || null;
  if (assignee_id && !(await db.prepare('SELECT 1 FROM users WHERE id = ?').get(assignee_id))) throw httpError(400, '담당자를 찾을 수 없습니다.');
  // 존재하는 팀원만 참석자로 인정 (한 번의 쿼리로 확인)
  const wanted = [...new Set((b.attendees || []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  const known = wanted.length ? new Set((await db.prepare(`SELECT id FROM users WHERE id IN (${wanted.map(() => '?').join(',')})`).all(...wanted)).map((u) => u.id)) : new Set();
  return {
    title,
    start: b.start,
    end: b.end,
    all_day,
    location: String(b.location || '').trim(),
    memo: String(b.memo || ''),
    category: CATEGORIES.includes(b.category) ? b.category : '기타',
    urgent: b.urgent ? 1 : 0,
    importance: [0, 1, 2].includes(+b.importance) ? +b.importance : 1,
    assignee_id,
    ...cleanPerms(b),
    recur,
    attendees: wanted.filter((id) => known.has(id)),
    alarms: [...new Set((b.alarms || []).map(Number).filter((m) => m >= 0 && m <= 60 * 24 * 30))],
  };
}

// 일정 종류·공개 범위·수정 권한 조합을 올바른 값으로 정리
function cleanPerms(b) {
  const kind = b.kind === 'team' ? 'team' : 'personal';
  let visibility = ['team', 'attendees', 'me'].includes(b.visibility) ? b.visibility : kind === 'team' ? 'team' : 'me';
  if (kind === 'team' && visibility === 'me') visibility = 'attendees';
  let edit_perm = kind === 'team' && ['owner', 'attendees', 'team'].includes(b.edit_perm) ? b.edit_perm : 'owner';
  if (edit_perm === 'team' && visibility !== 'team') edit_perm = 'attendees';
  return { kind, visibility, edit_perm };
}

// 참석자 목록을 맞추고(기존 응답은 유지), 알람을 맞춘다
async function setChildren(eventId, attendees, alarms) {
  const have = new Set((await attendeesOf(eventId)).map((a) => a.user_id));
  for (const uid of have) if (!attendees.includes(uid)) await db.prepare('DELETE FROM attendees WHERE event_id = ? AND user_id = ?').run(eventId, uid);
  for (const uid of attendees) if (!have.has(uid)) await db.prepare('INSERT INTO attendees (event_id, user_id) VALUES (?, ?)').run(eventId, uid);
  // 기존 알람은 유지하고(발송 기록 보존) 변경된 것만 추가/삭제
  const haveAl = await db.prepare('SELECT id, minutes FROM alarms WHERE event_id = ?').all(eventId);
  for (const a of haveAl) if (!alarms.includes(a.minutes)) await db.prepare('DELETE FROM alarms WHERE id = ?').run(a.id);
  for (const m of alarms) if (!haveAl.some((a) => a.minutes === m)) await db.prepare('INSERT INTO alarms (event_id, minutes) VALUES (?, ?)').run(eventId, m);
}

async function insertEvent(ownerId, f) {
  const r = await db
    .prepare('INSERT INTO events (owner_id, assignee_id, title, start, end, all_day, location, memo, category, urgent, importance, kind, visibility, edit_perm, recur) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(ownerId, f.assignee_id, f.title, f.start, f.end, f.all_day, f.location, f.memo, f.category, f.urgent, f.importance, f.kind, f.visibility, f.edit_perm, f.recur ? JSON.stringify(f.recur) : null);
  const id = Number(r.lastInsertRowid);
  await setChildren(id, f.attendees, f.alarms);
  return id;
}

// 수정 가능한 일정을 가져온다. manage=true 이면 등록자·관리자만 허용 (삭제, 공개/수정권한 변경)
async function ownEvent(req, { manage = false } = {}) {
  const ev = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev) throw httpError(404, '일정을 찾을 수 없습니다.');
  const att = await attendeesOf(ev.id);
  if (!canSee(ev, att, req.user.id) && req.user.role !== 'admin') throw httpError(404, '일정을 찾을 수 없습니다.');
  if (manage ? !canManage(ev, req.user) : !canEditEvent(ev, att, req.user)) {
    throw httpError(403, manage ? '등록자만 할 수 있는 작업입니다.' : '이 일정을 수정할 권한이 없습니다.');
  }
  return ev;
}
// 볼 수 있는 일정만 가져온다 (댓글·이력·응답용)
async function visibleEvent(req) {
  const ev = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev || (!canSee(ev, await attendeesOf(ev.id), req.user.id) && req.user.role !== 'admin')) throw httpError(404, '일정을 찾을 수 없습니다.');
  return ev;
}

// 해당 회차 이전까지만 반복되도록 기존 시리즈를 자른다
async function truncateSeries(ev, occ) {
  const recur = JSON.parse(ev.recur);
  recur.endType = 'until';
  recur.until = fmtDate(parse(occ) - DAY);
  recur.count = null;
  await db.prepare('UPDATE events SET recur = ? WHERE id = ?').run(JSON.stringify(recur), ev.id);
  await db.prepare('DELETE FROM exceptions WHERE event_id = ? AND occ >= ?').run(ev.id, occ);
}
const masterKey = (ev) => fmt(parse(ev.start), ev.all_day);

// 해당 회차의 현재 값 (변경 전 비교용)
async function occurrenceValues(ev, occ) {
  const exceptions = await db.prepare('SELECT * FROM exceptions WHERE event_id = ?').all(ev.id);
  const s = parse(occ);
  return expand(ev, s, s + 1, exceptions).find((o) => o.key === occ)?.ev || ev;
}

const whenText = (e) => (e.all_day ? `${e.start}${e.end !== e.start ? ' ~ ' + e.end : ''} (종일)` : `${e.start.replace('T', ' ')} ~ ${e.end.replace('T', ' ')}`);
const IMPORTANCE = ['낮음', '보통', '높음'];
const STATUS_WORD = { cancelled: '취소', done: '종료', active: '복원' };
const VIS = { team: '전체 공개', attendees: '등록자·참석자만', me: '나만 보기' };
const PERM = { owner: '등록자만', attendees: '등록자+참석자', team: '모든 팀원' };

// 변경 내용 목록 (이력/알림용)
function diffEvent(old, oldEv, f, names, withRecur = true) {
  const out = [];
  const chg = (label, a, b) => a !== b && out.push(`${label}: ${a || '(없음)'} → ${b || '(없음)'}`);
  chg('제목', old.title, f.title);
  chg('시작', old.start.replace('T', ' '), f.start.replace('T', ' '));
  chg('종료', old.end.replace('T', ' '), f.end.replace('T', ' '));
  if (!!old.all_day !== !!f.all_day) out.push(`종일: ${old.all_day ? '예' : '아니오'} → ${f.all_day ? '예' : '아니오'}`);
  chg('장소', old.location, f.location);
  chg('분류', old.category, f.category);
  if (!!old.urgent !== !!f.urgent) out.push(`긴급: ${old.urgent ? '예' : '아니오'} → ${f.urgent ? '예' : '아니오'}`);
  chg('중요도', IMPORTANCE[old.importance ?? 1], IMPORTANCE[f.importance]);
  if (old.memo !== f.memo) out.push('상세 내용 변경');
  chg('담당자', names.get(oldEv.assignee_id), names.get(f.assignee_id));
  chg('종류', oldEv.kind === 'team' ? '팀 일정' : '개인 일정', f.kind === 'team' ? '팀 일정' : '개인 일정');
  chg('공개 범위', VIS[oldEv.visibility], VIS[f.visibility]);
  chg('수정 권한', PERM[oldEv.edit_perm], PERM[f.edit_perm]);
  if (withRecur && (oldEv.recur || null) !== (f.recur ? JSON.stringify(f.recur) : null)) out.push('반복 규칙 변경');
  return out;
}

// 일정 1건 등록 (직접 등록과 엑셀 업로드가 함께 사용): 이력 기록 + 초대/담당자 알림
async function createEvent(user, f, source = '') {
  const id = await tx(async () => {
    const id = await insertEvent(user.id, f);
    await addHistory(id, user.id, 'created', `일정 등록${source}: ${f.title} (${whenText(f)})`);
    return id;
  });
  const invited = f.attendees.filter((u) => u !== user.id);
  const note = { event_id: id, ref_start: f.start, body: `${user.name}님 · ${whenText(f)}${f.location ? ' · ' + f.location : ''}` };
  await pushNote(invited, { ...note, type: 'invite', title: `[초대] ${f.title}` }, user.id);
  await pushNote(f.assignee_id && !invited.includes(f.assignee_id) ? [f.assignee_id] : [], { ...note, type: 'assign', title: `[담당자 지정] ${f.title}` }, user.id);
  return id;
}

app.post('/api/events', auth, async (req, res) => {
  res.json({ id: await createEvent(req.user, await clean(req.body)) });
});

// ---------- 엑셀 업로드 (일정 일괄 등록) ----------
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const IMPORT_MAX_ROWS = 150; // 행마다 DB 왕복이 필요하므로 한 번에 처리할 양을 제한
const TRUE_WORDS = new Set(['y', 'yes', 'o', 'true', '1', '예', '네', 'v', '✔', '✓', 'x', '○', '종일', '긴급', '체크', '해당']);
const FALSE_WORDS = new Set(['n', 'no', 'false', '0', '아니오', '아니요', '×', '-']);
// 헤더 이름 -> 내부 필드. 공백·괄호 내용은 무시하므로 엑셀 내보내기 파일도 그대로 업로드할 수 있다.
const HEADER_ALIASES = {
  title: ['제목', '일정', '일정제목', 'title'],
  start: ['시작', '시작일', '시작일시', 'start'],
  end: ['종료', '종료일', '종료일시', 'end'],
  all_day: ['종일', '종일여부'],
  kind: ['종류', '일정종류'],
  category: ['분류', '카테고리'],
  location: ['장소'],
  assignee: ['담당자'],
  attendees: ['참석자'],
  urgent: ['긴급'],
  importance: ['중요도'],
  visibility: ['공개범위', '공개'],
  edit_perm: ['수정권한'],
  recur: ['반복'],
  recur_days: ['반복요일', '요일'],
  recur_interval: ['반복간격'],
  recur_until: ['반복종료', '반복종료일'],
  alarms: ['알람', '알림'],
  memo: ['메모', '상세내용', '내용'],
};
const normHeader = (s) => String(s || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, '');

// 셀 값을 문자열 또는 Date/숫자로 꺼낸다 (서식 있는 텍스트, 수식, 하이퍼링크 대응)
function cellValue(c) {
  let v = c?.value;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) v = v.result;
    else if ('richText' in v) v = v.richText.map((r) => r.text).join('');
    else if ('text' in v) v = v.text;
    else v = String(v);
  }
  return v ?? '';
}
const cellText = (v) => (v instanceof Date ? '' : String(v ?? '').trim());

// 날짜/시간 해석 -> { date: 'YYYY-MM-DD', time: 'HH:mm' | null }
function parseDateTime(v) {
  if (v === '' || v == null) return null;
  const p2 = (n) => String(n).padStart(2, '0');
  const fromDate = (d) => {
    const time = d.getUTCHours() || d.getUTCMinutes() ? `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` : null;
    return { date: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`, time };
  };
  if (v instanceof Date) return Number.isNaN(+v) ? null : fromDate(v);
  if (typeof v === 'number') return v > 20000 && v < 80000 ? fromDate(new Date(Math.round((v - 25569) * 86400000))) : null;
  const m = /^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})일?(?:[\sT]+(?:(오전|오후)\s*)?(\d{1,2})\s*[:시]\s*(\d{2})?)?/.exec(String(v).trim());
  if (!m) return null;
  const [, y, mo, d, ampm, hh, mm] = m;
  let time = null;
  if (hh !== undefined) {
    let h = +hh;
    if (ampm === '오후' && h < 12) h += 12;
    if (ampm === '오전' && h === 12) h = 0;
    time = `${p2(h)}:${p2(mm || 0)}`;
  }
  const date = `${y}-${p2(mo)}-${p2(d)}`;
  if (Number.isNaN(Date.parse(date))) return null;
  return { date, time };
}

const toBool = (s) => TRUE_WORDS.has(String(s).trim().toLowerCase());

function parseAlarms(s) {
  const out = [];
  for (const tok of String(s).split(/[,，;、\s]+/).filter(Boolean)) {
    const m = /^(\d+)\s*(분|시간|일|주)?/.exec(tok);
    if (!m) continue;
    const n = +m[1];
    out.push(m[2] === '시간' ? n * 60 : m[2] === '일' ? n * 1440 : m[2] === '주' ? n * 10080 : n);
  }
  return out;
}

// 엑셀 한 행 -> 일정 입력값 + 오류 목록
function parseImportRow(get, ctx) {
  const errors = [];
  const title = cellText(get('title'));
  if (!title) errors.push('제목이 없습니다');

  const s = parseDateTime(get('start'));
  const eRaw = get('end');
  const e = parseDateTime(eRaw);
  if (!s) errors.push('시작 날짜/시간을 읽을 수 없습니다 (예: 2026-11-02 10:00)');
  if (eRaw !== '' && !e) errors.push('종료 날짜/시간을 읽을 수 없습니다');

  const adRaw = cellText(get('all_day'));
  const all_day = adRaw ? toBool(adRaw) : s ? !s.time : false;
  let start = '';
  let end = '';
  if (s) {
    if (all_day) {
      start = s.date;
      end = e && e.date >= s.date ? e.date : s.date;
    } else {
      const st = s.time || '09:00';
      start = `${s.date}T${st}`;
      end = e ? `${e.date}T${e.time || st}` : '';
      if (!end || end <= start) end = fmtTime(parse(start) + 3600000);
    }
  }

  const kind = cellText(get('kind')).includes('팀') ? 'team' : 'personal';
  const catText = cellText(get('category'));
  const warnings = [];
  const category = CATEGORIES.includes(catText) ? catText : '기타';
  if (catText && !CATEGORIES.includes(catText)) warnings.push(`분류 "${catText}" → 기타`);

  const visText = cellText(get('visibility'));
  const visibility = /나만/.test(visText) ? 'me' : /참석자|등록자/.test(visText) ? 'attendees' : /전체|공개/.test(visText) ? 'team' : undefined;
  const permText = cellText(get('edit_perm'));
  const edit_perm = /모든|팀/.test(permText) ? 'team' : /참석|담당/.test(permText) ? 'attendees' : /등록자/.test(permText) ? 'owner' : undefined;

  const impText = cellText(get('importance'));
  const importance = /높|중요|high|^2$/i.test(impText) ? 2 : /낮|low|^0$/i.test(impText) ? 0 : 1;
  const urgentRaw = cellText(get('urgent'));
  const urgent = urgentRaw ? toBool(urgentRaw) && !FALSE_WORDS.has(urgentRaw.toLowerCase()) : false;

  const findUser = (name) => {
    const hit = ctx.byName.get(name);
    if (!hit) return { error: `팀원 "${name}"을(를) 찾을 수 없습니다` };
    if (hit.length > 1) return { error: `이름 "${name}"이(가) 여러 명입니다` };
    return { id: hit[0] };
  };
  let assignee_id = null;
  const asg = cellText(get('assignee'));
  if (asg) {
    const r = findUser(asg);
    if (r.error) errors.push(r.error);
    else assignee_id = r.id;
  }
  const attendees = [];
  for (const raw of cellText(get('attendees')).split(/[,，;、\n]+/)) {
    const name = raw.replace(/\([^)]*\)/g, '').trim();
    if (!name) continue;
    const r = findUser(name);
    if (r.error) errors.push(r.error);
    else if (r.id !== ctx.userId && !attendees.includes(r.id)) attendees.push(r.id);
  }

  let recur = null;
  const rText = cellText(get('recur'));
  if (rText && !/^(없음|안함|아니오|-|n)$/i.test(rText)) {
    const freq = /매일|daily/i.test(rText) ? 'daily' : /매주|weekly/i.test(rText) ? 'weekly' : /매월|monthly/i.test(rText) ? 'monthly' : /매년|yearly/i.test(rText) ? 'yearly' : null;
    if (!freq) errors.push(`반복 "${rText}"을(를) 알 수 없습니다 (매일/매주/매월/매년)`);
    else {
      const days = [...cellText(get('recur_days'))].map((c) => '일월화수목금토'.indexOf(c)).filter((d) => d >= 0);
      const untilRaw = get('recur_until');
      const until = parseDateTime(untilRaw);
      if (untilRaw !== '' && !until) errors.push('반복 종료일을 읽을 수 없습니다');
      recur = {
        freq, interval: +get('recur_interval') || 1, weekdays: freq === 'weekly' ? days : [], monthlyMode: 'date',
        endType: until ? 'until' : 'never', until: until?.date || null, count: null,
      };
    }
  }

  return {
    errors, warnings,
    body: {
      title, start, end, all_day, kind, category, urgent, importance, location: cellText(get('location')), memo: cellText(get('memo')),
      visibility, edit_perm, assignee_id, attendees, alarms: parseAlarms(cellText(get('alarms'))), recur,
    },
  };
}

async function readImportSheet(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw httpError(400, '엑셀(.xlsx) 파일을 읽을 수 없습니다. 파일 형식을 확인해 주세요.');
  }
  const ws = wb.getWorksheet('일정') || wb.worksheets[0];
  if (!ws) throw httpError(400, '시트를 찾을 수 없습니다.');
  const cols = {}; // 내부 필드 -> 열 번호
  ws.getRow(1).eachCell((c, i) => {
    const h = normHeader(cellValue(c));
    for (const [field, names] of Object.entries(HEADER_ALIASES)) if (names.map(normHeader).includes(h) && !(field in cols)) cols[field] = i;
  });
  if (!cols.title || !cols.start) {
    // 일정 양식이 아니라 교육계획 파일(교육과목·성명 열)이면 교육 현황 메뉴로 안내한다
    const isTraining = wb.worksheets.some((sheet) => {
      for (let r = 1; r <= Math.min(sheet.rowCount, 15); r++) {
        const hs = [];
        sheet.getRow(r).eachCell((c) => hs.push(normHeader(cellValue(c))));
        if (hs.includes('교육과목') && hs.includes('성명')) return true;
      }
      return false;
    });
    if (isTraining) throw Object.assign(httpError(400, '교육계획 파일입니다. 일정이 아니라 📚 교육 현황 메뉴에서 업로드해야 합니다.'), { code: 'training_file' });
    throw httpError(400, '첫 행에 "제목"과 "시작" 열이 필요합니다. 템플릿을 내려받아 사용해 보세요.');
  }
  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (f) => (cols[f] ? cellValue(row.getCell(cols[f])) : '');
    if (!['title', 'start', 'end', 'memo'].some((f) => cellText(get(f)) || get(f) instanceof Date || typeof get(f) === 'number')) continue; // 빈 행
    rows.push({ r, get });
  }
  return rows;
}

app.post('/api/import/preview', auth, uploadMem.single('file'), async (req, res) => {
  if (!req.file) throw httpError(400, '엑셀 파일을 선택하세요.');
  const rows = await readImportSheet(req.file.buffer);
  if (!rows.length) throw httpError(400, '등록할 일정 행이 없습니다.');
  if (rows.length > IMPORT_MAX_ROWS) throw httpError(400, `한 번에 ${IMPORT_MAX_ROWS}행까지 업로드할 수 있습니다. (현재 ${rows.length}행)`);

  const byName = new Map();
  for (const u of (await db.prepare('SELECT id, name FROM users').all())) byName.set(u.name, [...(byName.get(u.name) || []), u.id]);
  const names = await userNames();
  const existing = new Set((await db.prepare('SELECT title, start FROM events WHERE owner_id = ?').all(req.user.id)).map((e) => `${e.title}|${e.start}`));
  const seen = new Set();
  const out = [];
  for (const { r, get } of rows) {
    const p = parseImportRow(get, { byName, userId: req.user.id });
    let cleaned = null;
    if (!p.errors.length) {
      try {
        cleaned = await clean(p.body);
      } catch (e) {
        p.errors.push(e.message);
      }
    }
    const key = `${p.body.title}|${p.body.start}`;
    const dup = !p.errors.length && (existing.has(key) || seen.has(key));
    seen.add(key);
    out.push({
      row: r, errors: p.errors, warnings: p.warnings, dup,
      body: p.errors.length ? null : p.body,
      preview: {
        title: p.body.title, start: p.body.start, end: p.body.end, all_day: p.body.all_day,
        kind: p.body.kind, category: p.body.category, urgent: p.body.urgent, importance: p.body.importance,
        location: p.body.location, assignee: names.get(p.body.assignee_id) || '',
        attendees: p.body.attendees.map((u) => names.get(u)), recur: p.body.recur ? RECUR_LABEL[p.body.recur.freq] : '',
        visibility: cleaned?.visibility,
      },
    });
  }
  res.json({ total: out.length, ok: out.filter((o) => !o.errors.length).length, rows: out });
});

app.post('/api/import/commit', auth, async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) throw httpError(400, '등록할 일정이 없습니다.');
  if (rows.length > IMPORT_MAX_ROWS) throw httpError(400, `한 번에 ${IMPORT_MAX_ROWS}건까지 등록할 수 있습니다.`);
  let created = 0;
  const failed = [];
  for (const [i, b] of rows.entries()) {
    try {
      const f = await clean(b);
      f.attendees = f.attendees.filter((u) => u !== req.user.id);
      await createEvent(req.user, f, ' (엑셀 업로드)');
      created++;
    } catch (e) {
      failed.push({ index: i, title: String(b?.title || ''), error: e.message });
    }
  }
  res.json({ created, failed });
});

// 업로드용 엑셀 템플릿 (예시 행 + 입력 안내 시트)
app.get('/api/import/template', auth, async (req, res) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('일정');
  const heads = ['제목', '시작', '종료', '종일', '종류', '분류', '장소', '담당자', '참석자', '긴급', '중요도', '공개범위', '수정권한', '반복', '반복요일', '반복간격', '반복종료', '알람', '메모'];
  const widths = [28, 18, 18, 7, 8, 8, 16, 10, 20, 7, 9, 16, 16, 8, 10, 9, 12, 10, 36];
  ws.columns = heads.map((h, i) => ({ header: h, key: String(i), width: widths[i] }));
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4EBDD' } };
  const d = new Date(floatingNow());
  const monMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  const day = (o) => fmtDate(monMs + o * DAY);
  ws.addRow(['주간 업무 회의', `${day(0)} 10:00`, `${day(0)} 11:00`, '', '팀', '회의', '회의실A', req.user.name, '', '', '높음', '전체 공개', '등록자+참석자', '매주', '월', 1, day(56), '10, 60', '안건: 주간 진행 상황 공유']);
  ws.addRow(['고객사 방문', `${day(3)} 14:00`, `${day(3)} 16:00`, '', '개인', '외근', '고객사', '', '', 'Y', '보통', '나만 보기', '', '', '', '', '', '60', '']);
  ws.addRow(['팀 워크숍', day(10), day(11), '종일', '팀', '교육', '', '', '', '', '', '전체 공개', '', '', '', '', '', '1440', '']);
  for (let r = 2; r <= 4; r++) ws.getRow(r).eachCell((c) => (c.numFmt = '@'));
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const guide = wb.addWorksheet('입력 안내');
  guide.getColumn(1).width = 16;
  guide.getColumn(2).width = 90;
  guide.addRows([
    ['열', '입력 방법'],
    ['제목 *', '필수'],
    ['시작 *', '필수. 예) 2026-11-02 10:00 또는 2026-11-02 (시간을 비우면 종일 일정)'],
    ['종료', '비우면 시작 1시간 뒤(종일이면 시작과 같은 날)'],
    ['종일', '종일 일정이면 Y 또는 "종일"'],
    ['종류', '개인 / 팀 (비우면 개인)'],
    ['분류', '회의 / 외근 / 출장 / 휴가 / 교육 / 기타'],
    ['담당자', '팀원 이름 1명'],
    ['참석자', '팀원 이름을 쉼표로 구분 (예: 홍길동, 김철수). 초대 알림이 갑니다.'],
    ['긴급', '긴급이면 Y'],
    ['중요도', '낮음 / 보통 / 높음'],
    ['공개범위', '전체 공개 / 등록자·참석자만 / 나만 보기 (비우면 개인=나만, 팀=전체)'],
    ['수정권한', '등록자만 / 등록자+참석자 / 모든 팀원 (팀 일정에만 적용)'],
    ['반복', '매일 / 매주 / 매월 / 매년 (비우면 반복 없음)'],
    ['반복요일', '매주 반복일 때 요일. 예) 월,수 (비우면 시작일의 요일)'],
    ['반복간격', '2주마다처럼 간격 숫자 (비우면 1)'],
    ['반복종료', '반복을 끝낼 날짜 (비우면 종료 없음)'],
    ['알람', '시작 몇 분 전에 알릴지. 예) 10, 60, 1일 (쉼표로 여러 개)'],
    ['메모', '상세 내용'],
    ['', ''],
    ['참고', '일정 엑셀 내보내기로 받은 파일도 그대로 업로드할 수 있습니다. 한 번에 최대 150행, 4MB까지.'],
  ]);
  guide.getRow(1).font = { bold: true };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('일정_업로드_템플릿.xlsx')}`);
  await wb.xlsx.write(res);
  res.end();
});

app.put('/api/events/:id', auth, async (req, res) => {
  const ev = await ownEvent(req);
  const f = await clean(req.body);
  // 종류·공개 범위·수정 권한은 등록자(또는 관리자)만 바꿀 수 있다
  if (!canManage(ev, req.user)) Object.assign(f, { kind: ev.kind, visibility: ev.visibility, edit_perm: ev.edit_perm });
  let scope = req.body.scope || 'all';
  const occ = req.body.occ || masterKey(ev);
  if (!ev.recur) scope = 'all';
  if (scope === 'future' && occ === masterKey(ev)) scope = 'all';

  const names = await userNames();
  const oldOcc = await occurrenceValues(ev, occ);
  const oldAtt = await attendeesOf(ev.id);
  const oldAttIds = oldAtt.map((a) => a.user_id);
  const changes = diffEvent(oldOcc, ev, f, names, scope !== 'one'); // '이 일정만' 수정에서는 반복 규칙을 바꾸지 않는다

  const id = await tx(async () => {
    if (scope === 'one') {
      const ov = { title: f.title, start: f.start, end: f.end, all_day: f.all_day, location: f.location, memo: f.memo, category: f.category, urgent: f.urgent, importance: f.importance };
      const cur = await db.prepare('SELECT override FROM exceptions WHERE event_id = ? AND occ = ?').get(ev.id, occ);
      const merged = { ...(cur?.override ? JSON.parse(cur.override) : {}), ...ov };
      await db.prepare('INSERT INTO exceptions (event_id, occ, deleted, override) VALUES (?, ?, 0, ?) ON CONFLICT(event_id, occ) DO UPDATE SET deleted = 0, override = excluded.override').run(ev.id, occ, JSON.stringify(merged));
      await db.prepare('UPDATE events SET assignee_id = ?, kind = ?, visibility = ?, edit_perm = ? WHERE id = ?').run(f.assignee_id, f.kind, f.visibility, f.edit_perm, ev.id);
      await setChildren(ev.id, f.attendees, f.alarms);
      return ev.id;
    }
    if (scope === 'future') {
      await truncateSeries(ev, occ);
      const nid = await insertEvent(ev.owner_id, f);
      // 참석 응답은 새 시리즈로 이어받는다
      for (const a of oldAtt) await db.prepare('UPDATE attendees SET response = ? WHERE event_id = ? AND user_id = ?').run(a.response, nid, a.user_id);
      return nid;
    }
    let { start, end } = f;
    if (ev.recur) {
      // 회차에서 바꾼 만큼 시리즈 전체를 이동
      const delta = parse(f.start) - parse(occ);
      const dur = span({ start: f.start, end: f.end, all_day: f.all_day });
      const s = parse(ev.start) + delta;
      start = fmt(s, f.all_day);
      end = fmt(s + (dur[1] - dur[0]) - (f.all_day ? DAY : 0), f.all_day);
    }
    await db.prepare('UPDATE events SET title=?, start=?, end=?, all_day=?, location=?, memo=?, category=?, urgent=?, importance=?, assignee_id=?, kind=?, visibility=?, edit_perm=?, recur=? WHERE id=?').run(
      f.title, start, end, f.all_day, f.location, f.memo, f.category, f.urgent, f.importance, f.assignee_id, f.kind, f.visibility, f.edit_perm, f.recur ? JSON.stringify(f.recur) : null, ev.id,
    );
    if (ev.recur && start !== ev.start) await db.prepare('DELETE FROM exceptions WHERE event_id = ?').run(ev.id);
    await setChildren(ev.id, f.attendees, f.alarms);
    return ev.id;
  });

  // 이력 + 알림
  const invited = f.attendees.filter((u) => !oldAttIds.includes(u) && u !== req.user.id);
  const removed = oldAttIds.filter((u) => !f.attendees.includes(u));
  const lines = [...changes];
  if (invited.length) lines.push(`참석자 초대: ${invited.map((u) => names.get(u)).join(', ')}`);
  if (removed.length) lines.push(`참석자 제외: ${removed.map((u) => names.get(u)).join(', ')}`);
  const prefix = scope === 'one' ? `[이 일정만 · ${occ.replace('T', ' ')}] ` : scope === 'future' ? `[이후 일정 · ${occ.replace('T', ' ')}] ` : '';
  if (lines.length) await addHistory(id, req.user.id, 'updated', prefix + lines.join('\n'));
  const note = { event_id: id, ref_start: f.start };
  await pushNote(invited, { ...note, type: 'invite', title: `[초대] ${f.title}`, body: `${req.user.name}님 · ${whenText(f)}` }, req.user.id);
  if (f.assignee_id !== ev.assignee_id && f.assignee_id && !invited.includes(f.assignee_id)) {
    await pushNote([f.assignee_id], { ...note, type: 'assign', title: `[담당자 지정] ${f.title}`, body: `${req.user.name}님이 지정했습니다.` }, req.user.id);
  }
  if (changes.length) {
    const audience = (await involvedIds({ ...ev, assignee_id: f.assignee_id }, f.attendees.map((u) => ({ user_id: u })))).filter((u) => !invited.includes(u) && u !== f.assignee_id);
    const withAssignee = f.assignee_id && f.assignee_id === ev.assignee_id ? [f.assignee_id] : [];
    await pushNote([...audience, ...withAssignee], { ...note, type: 'change', title: `[변경] ${f.title}`, body: `${req.user.name}님이 변경\n${changes.join('\n')}` }, req.user.id);
  }
  res.json({ id });
});

// 일정 종료(완료) / 취소 / 복원 (삭제와 달리 기록이 남고 되돌릴 수 있다)
app.post('/api/events/:id/status', auth, async (req, res) => {
  const ev = await ownEvent(req);
  const status = ['cancelled', 'done'].includes(req.body.status) ? req.body.status : 'active';
  let scope = req.body.scope === 'one' ? 'one' : 'all';
  const occ = req.body.occ || masterKey(ev);
  if (!ev.recur) scope = 'all';
  const cur = await occurrenceValues(ev, occ);
  const word = status === 'active' ? (cur.status === 'done' ? '종료 해제' : '복원') : STATUS_WORD[status];
  await tx(async () => {
    if (scope === 'one') {
      const row = await db.prepare('SELECT override FROM exceptions WHERE event_id = ? AND occ = ?').get(ev.id, occ);
      const ov = { ...(row?.override ? JSON.parse(row.override) : {}), status };
      await db.prepare('INSERT INTO exceptions (event_id, occ, deleted, override) VALUES (?, ?, 0, ?) ON CONFLICT(event_id, occ) DO UPDATE SET deleted = 0, override = excluded.override').run(ev.id, occ, JSON.stringify(ov));
    } else {
      await db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, ev.id);
      // 개별 회차의 취소/복원 설정은 전체 설정을 따르도록 정리
      for (const x of (await db.prepare('SELECT id, override FROM exceptions WHERE event_id = ? AND override IS NOT NULL').all(ev.id))) {
        const ov = JSON.parse(x.override);
        if ('status' in ov) {
          delete ov.status;
          await db.prepare('UPDATE exceptions SET override = ? WHERE id = ?').run(JSON.stringify(ov), x.id);
        }
      }
    }
    await addHistory(ev.id, req.user.id, status === 'active' ? 'restored' : status, `${scope === 'one' ? `이 일정만 (${occ.replace('T', ' ')}) ` : ev.recur ? '모든 일정 ' : ''}${word}`);
  });
  await pushNote(await involvedIds(ev), {
    type: { cancelled: 'cancel', done: 'done', active: 'restore' }[status], event_id: ev.id, ref_start: cur.start,
    title: `[${word}] ${cur.title}`, body: `${req.user.name}님이 일정을 ${word}했습니다. (${whenText(cur)})`,
  }, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/events/:id', auth, async (req, res) => {
  const ev = await ownEvent(req, { manage: true });
  let scope = String(req.query.scope || 'all');
  const occ = String(req.query.occ || masterKey(ev));
  if (!ev.recur) scope = 'all';
  if (scope === 'future' && occ === masterKey(ev)) scope = 'all';
  const audience = await involvedIds(ev);
  const cur = await occurrenceValues(ev, occ);
  let wholeDelete = false;
  await tx(async () => {
    if (scope === 'one') {
      await db.prepare('INSERT INTO exceptions (event_id, occ, deleted, override) VALUES (?, ?, 1, NULL) ON CONFLICT(event_id, occ) DO UPDATE SET deleted = 1, override = NULL').run(ev.id, occ);
      await addHistory(ev.id, req.user.id, 'updated', `이 일정만 삭제 (${occ.replace('T', ' ')})`);
    } else if (scope === 'future') {
      await truncateSeries(ev, occ);
      await addHistory(ev.id, req.user.id, 'updated', `이후 일정 삭제 (${occ.replace('T', ' ')} 부터)`);
    } else {
      wholeDelete = true; // 트랜잭션 밖에서 연쇄 삭제 (첨부파일 저장소 정리 포함)
    }
  });
  if (wholeDelete) await deleteEventCascade(ev.id);
  await pushNote(audience, { type: 'delete', title: `[삭제] ${cur.title}`, body: `${req.user.name}님이 일정을 삭제했습니다. (${whenText(cur)})` }, req.user.id);
  res.json({ ok: true });
});

// ---------- 참석 응답 / 겹침 안내 ----------
app.post('/api/events/:id/respond', auth, async (req, res) => {
  const ev = await visibleEvent(req);
  const response = req.body.response;
  if (!['yes', 'no', 'maybe'].includes(response)) throw httpError(400, '응답 값이 올바르지 않습니다.');
  const r = await db.prepare('UPDATE attendees SET response = ? WHERE event_id = ? AND user_id = ?').run(response, ev.id, req.user.id);
  if (r.changes === 0) throw httpError(403, '참석자로 초대된 일정이 아닙니다.');
  await addHistory(ev.id, req.user.id, 'response', `${req.user.name}님 응답: ${RESPONSES[response]}`);
  await pushNote([ev.owner_id], {
    type: 'response', event_id: ev.id, ref_start: ev.start,
    title: `[참석 응답] ${ev.title}`, body: `${req.user.name}님: ${RESPONSES[response]}`,
  }, req.user.id);
  res.json({ ok: true });
});

// 선택한 시간에 등록자·참석자·담당자의 다른 일정이 있는지 알려준다
app.post('/api/conflicts', auth, async (req, res) => {
  const b = req.body || {};
  const all_day = !!b.all_day;
  const re = all_day ? /^\d{4}-\d\d-\d\d$/ : /^\d{4}-\d\d-\d\dT\d\d:\d\d$/;
  if (!re.test(b.start || '') || !re.test(b.end || '') || parse(b.end) < parse(b.start)) return res.json([]);
  const [s, e] = span({ start: b.start, end: b.end, all_day });
  const exclude = +b.exclude_id || null;
  const owner = exclude ? (await db.prepare('SELECT owner_id FROM events WHERE id = ?').get(exclude))?.owner_id : req.user.id;
  const people = new Set([owner, +b.assignee_id || null, ...(b.attendees || []).map(Number)].filter(Boolean));
  const names = await userNames();
  const d = await loadEvents();
  const out = [];
  for (const ev of d.events) {
    if (ev.id === exclude) continue;
    const att = d.attendees.get(ev.id) || [];
    const who = [...new Set([ev.owner_id, ev.assignee_id, ...att.filter((a) => a.response !== 'no').map((a) => a.user_id)])].filter((u) => people.has(u));
    if (!who.length) continue;
    const visible = canSee(ev, att, req.user.id);
    for (const occ of expand(ev, s, e, d.exceptions.get(ev.id) || [])) {
      if (occ.ev.status === 'cancelled') continue;
      out.push({
        who: who.map((u) => names.get(u)),
        title: visible ? occ.ev.title : '(비공개 일정)',
        start: occ.ev.start, end: occ.ev.end, all_day: !!occ.ev.all_day,
      });
    }
  }
  res.json(out.slice(0, 20));
});

// ---------- 댓글 / 변경 이력 ----------
app.get('/api/events/:id/comments', auth, async (req, res) => {
  const ev = await visibleEvent(req);
  res.json(
    (await db.prepare('SELECT c.id, c.body, c.created_at, c.user_id, u.name FROM comments c JOIN users u ON u.id = c.user_id WHERE c.event_id = ? ORDER BY c.id').all(ev.id))
      .map((c) => ({ ...c, canDelete: c.user_id === req.user.id || canManage(ev, req.user) })),
  );
});
app.post('/api/events/:id/comments', auth, async (req, res) => {
  const ev = await visibleEvent(req);
  const body = String(req.body.body || '').trim().slice(0, 2000);
  if (!body) throw httpError(400, '댓글 내용을 입력하세요.');
  await db.prepare('INSERT INTO comments (event_id, user_id, body) VALUES (?, ?, ?)').run(ev.id, req.user.id, body);
  await addHistory(ev.id, req.user.id, 'comment', `댓글 작성: ${body.length > 80 ? body.slice(0, 80) + '…' : body}`);
  await pushNote(await involvedIds(ev), {
    type: 'comment', event_id: ev.id, ref_start: ev.start,
    title: `[댓글] ${ev.title}`, body: `${req.user.name}: ${body.slice(0, 80)}`,
  }, req.user.id);
  res.json({ ok: true });
});
app.delete('/api/comments/:id', auth, async (req, res) => {
  const c = await db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!c) throw httpError(404, '댓글을 찾을 수 없습니다.');
  const ev = await db.prepare('SELECT * FROM events WHERE id = ?').get(c.event_id);
  if (c.user_id !== req.user.id && !canManage(ev, req.user)) throw httpError(403, '권한이 없습니다.');
  await db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
  const author = (await userNames()).get(c.user_id) || '(알 수 없음)';
  await addHistory(ev.id, req.user.id, 'comment', `댓글 삭제 (작성자 ${author}): ${c.body.length > 60 ? c.body.slice(0, 60) + '…' : c.body}`);
  res.json({ ok: true });
});

// 최근 활동 기록 (내가 볼 수 있는 일정의 등록·변경·취소·댓글·첨부·응답 이력)
app.get('/api/activity', auth, async (req, res) => {
  const d = await loadEvents();
  const visible = new Map();
  for (const ev of d.events) if (canSee(ev, d.attendees.get(ev.id), req.user.id)) visible.set(ev.id, ev);
  const rows = (await db
    .prepare('SELECT h.id, h.event_id, h.action, h.detail, h.created_at, h.user_id, u.name FROM history h LEFT JOIN users u ON u.id = h.user_id ORDER BY h.id DESC LIMIT 400')
    .all())
    .filter((h) => visible.has(h.event_id) && !(h.action === 'done' && !h.user_id)) // 시스템 자동 종료는 제외
    .slice(0, 15)
    .map((h) => ({ id: h.id, action: h.action, detail: h.detail, who: h.name || '', at: h.created_at, event_id: h.event_id, title: visible.get(h.event_id).title, ref_start: visible.get(h.event_id).start }));
  res.json({ items: rows });
});
// 활동 기록 삭제 (관리자): 선택한 기록만 지운다. 일정의 변경 이력에서도 함께 사라진다.
app.post('/api/activity/delete', auth, adminOnly, async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 400);
  if (!ids.length) throw httpError(400, '삭제할 기록이 없습니다.');
  await batch(ids.map((id) => ({ sql: 'DELETE FROM history WHERE id = ?', args: [id] })));
  res.json({ ok: true, deleted: ids.length });
});
app.get('/api/events/:id/history', auth, async (req, res) => {
  const ev = await visibleEvent(req);
  res.json(
    await db.prepare('SELECT h.id, h.action, h.detail, h.created_at, u.name FROM history h LEFT JOIN users u ON u.id = h.user_id WHERE h.event_id = ? ORDER BY h.id DESC LIMIT 100').all(ev.id),
  );
});

// ---------- 대시보드 빠른 메모 (본인만 볼 수 있음) ----------
app.get('/api/notes', auth, async (req, res) => {
  res.json(await db.prepare('SELECT id, body, created_at FROM notes WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id));
});
app.post('/api/notes', auth, async (req, res) => {
  const body = String(req.body?.body || '').trim().slice(0, 500);
  if (!body) throw httpError(400, '메모 내용을 입력하세요.');
  const r = await db.prepare('INSERT INTO notes (user_id, body) VALUES (?, ?)').run(req.user.id, body);
  res.json({ id: Number(r.lastInsertRowid) });
});
app.delete('/api/notes/:id', auth, async (req, res) => {
  await db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ---------- 내부 알림 ----------
app.get('/api/notifications', auth, async (req, res) => {
  const items = await db.prepare('SELECT id, type, event_id, ref_start, title, body, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);
  const unread = (await db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id)).n;
  res.json({ unread, items });
});
app.post('/api/notifications/read', auth, async (req, res) => {
  if (req.body?.all) {
    await db.prepare("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL").run(req.user.id);
  } else {
    for (const id of (req.body?.ids || []).map(Number)) {
      await db.prepare("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND read_at IS NULL").run(id, req.user.id);
    }
  }
  res.json({ ok: true });
});
app.delete('/api/notifications', auth, async (req, res) => {
  await db.prepare('DELETE FROM notifications WHERE user_id = ? AND read_at IS NOT NULL').run(req.user.id);
  res.json({ ok: true });
});

// ---------- 첨부파일 ----------
app.post('/api/events/:id/attachments', auth, upload.array('files'), async (req, res) => {
  const ev = await ownEvent(req); // 권한이 없으면 파일을 저장하기 전에 여기서 거부된다
  const names = [];
  for (const f of req.files || []) {
    const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
    names.push(name);
    const stored = await saveFile(f.buffer, name, f.mimetype);
    await db.prepare("INSERT INTO attachments (event_id, filename, stored, size, user_id, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))").run(req.params.id, name, stored, f.size, req.user.id);
  }
  if (names.length) await addHistory(ev.id, req.user.id, 'updated', `첨부파일 추가: ${names.join(', ')}`);
  res.json({ ok: true });
});

async function attachmentFor(req) {
  const a = await db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!a) throw httpError(404, '파일을 찾을 수 없습니다.');
  const ev = await db.prepare('SELECT * FROM events WHERE id = ?').get(a.event_id);
  if (!canSee(ev, await attendeesOf(a.event_id), req.user.id)) throw httpError(403, '권한이 없습니다.');
  return { a, ev };
}
app.get('/api/attachments/:id', auth, async (req, res) => {
  const { a } = await attachmentFor(req);
  const file = await openFile(a.stored);
  if (!file) throw httpError(404, '저장된 파일을 찾을 수 없습니다.');
  res.setHeader('Content-Type', file.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
  if (file.size) res.setHeader('Content-Length', file.size);
  file.stream.on('error', () => res.destroy());
  file.stream.pipe(res);
});
app.delete('/api/attachments/:id', auth, async (req, res) => {
  const { a, ev } = await attachmentFor(req);
  if (!canEditEvent(ev, await attendeesOf(ev.id), req.user)) throw httpError(403, '권한이 없습니다.');
  await removeFile(a.stored);
  await db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
  await addHistory(ev.id, req.user.id, 'updated', `첨부파일 삭제: ${a.filename}`);
  res.json({ ok: true });
});

// ---------- 엑셀 내보내기 ----------
const RECUR_LABEL = { daily: '매일', weekly: '매주', monthly: '매월', yearly: '매년' };
app.get('/api/export', auth, async (req, res) => {
  if (!req.query.start || !req.query.end) return res.status(400).json({ error: 'start, end 필요' });
  const [from, to] = parseRange(req.query);
  const onlyMine = req.query.users ? new Set(String(req.query.users).split(',').map(Number)) : null;
  const names = await userNames();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('일정');
  ws.columns = [
    { header: '시작', key: 'start', width: 18 },
    { header: '종료', key: 'end', width: 18 },
    { header: '제목', key: 'title', width: 32 },
    { header: '상태', key: 'status', width: 8 },
    { header: '긴급', key: 'urgent', width: 6 },
    { header: '중요도', key: 'importance', width: 8 },
    { header: '종류', key: 'kind', width: 8 },
    { header: '분류', key: 'category', width: 8 },
    { header: '장소', key: 'location', width: 18 },
    { header: '등록자', key: 'owner', width: 10 },
    { header: '담당자', key: 'assignee', width: 10 },
    { header: '참석자(응답)', key: 'attendees', width: 28 },
    { header: '반복', key: 'recur', width: 8 },
    { header: '메모', key: 'memo', width: 40 },
  ];
  ws.getRow(1).font = { bold: true };
  const rows = (await visibleOccurrences(req.user, from, to))
    .filter(({ ev }) => !onlyMine || onlyMine.has(ev.owner_id))
    .sort((a, b) => a.occ.startMs - b.occ.startMs);
  for (const { ev, occ, att } of rows) {
    const e = occ.ev;
    ws.addRow({
      start: e.all_day ? e.start : e.start.replace('T', ' '),
      end: e.all_day ? e.end : e.end.replace('T', ' '),
      title: e.title,
      status: e.status === 'cancelled' ? '취소' : e.status === 'done' ? '종료' : '진행',
      urgent: e.urgent ? '긴급' : '',
      importance: IMPORTANCE[e.importance ?? 1],
      kind: ev.kind === 'team' ? '팀' : '개인',
      category: e.category,
      location: e.location,
      owner: names.get(ev.owner_id),
      assignee: names.get(ev.assignee_id) || '',
      attendees: att.map((a) => `${names.get(a.user_id)}(${RESPONSES[a.response]})`).join(', '),
      recur: ev.recur ? RECUR_LABEL[JSON.parse(ev.recur).freq] : '',
      memo: e.memo,
    });
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('업무일정.xlsx')}`);
  await wb.xlsx.write(res);
  res.end();
});

// ---------- 교육 현황 (교육계획 엑셀 -> 월별·인원별 정리) ----------
app.get('/api/trainings', auth, async (_req, res) => {
  const rows = await db.prepare('SELECT * FROM trainings ORDER BY month = 0, month, COALESCE(start_date, \'9999\'), dept, name').all();
  // 저장 위치(cert_stored)는 화면에 내보내지 않고, 수료증이 있는지만 알려 준다
  res.json(rows.map(({ cert_stored, ...r }) => ({ ...r, has_cert: !!cert_stored })));
});

// 같은 교육(소속·성명·과목·시작일)을 다시 찾기 위한 열쇠. 엑셀을 다시 올려도 직접 입력한 이수 결과·수료증을 이어 붙인다.
const trainingKey = (r) => `${r.company}|${r.name}|${r.course}|${r.start_date || ''}`;

// 교육계획 엑셀 업로드: 기존 교육 현황을 업로드한 파일 내용으로 교체한다 (관리자)
app.post('/api/trainings/import', auth, adminOnly, uploadMem.single('file'), async (req, res) => {
  if (!req.file) throw httpError(400, '엑셀 파일을 선택하세요.');
  let parsed;
  try {
    parsed = await parseTrainingWorkbook(req.file.buffer);
  } catch (e) {
    if (e.status) throw e;
    throw httpError(400, '엑셀(.xlsx) 파일을 읽을 수 없습니다. 파일 형식을 확인해 주세요.');
  }
  const { rows, warnings } = parsed;
  if (!rows.length) throw httpError(400, '등록할 교육 행이 없습니다.');
  const before = (await db.prepare('SELECT COUNT(*) AS n FROM trainings').get()).n;
  // 삭제와 전체 입력을 한 번의 요청(원자적)으로 보낸다 — 원격 DB 에서 수백 번 왕복하지 않도록
  const old = new Map((await db.prepare('SELECT * FROM trainings').all()).map((o) => [trainingKey(o), o]));
  const insertSql = 'INSERT INTO trainings (no, company, job, dept, rank, name, kind, org, course, days, hours, schedule_raw, start_date, end_date, month, cost, result, note, cert_name, cert_stored) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
  const kept = new Set();
  const args = rows.map((r) => {
    const o = old.get(trainingKey(r));
    if (o?.cert_stored) kept.add(o.cert_stored);
    // 엑셀의 실적 칸이 비어 있으면 화면에서 직접 입력한 이수 결과를 유지한다
    return [r.no, r.company, r.job, r.dept, r.rank, r.name, r.kind, r.org, r.course, r.days, r.hours, r.schedule_raw, r.start_date, r.end_date, r.month, r.cost, r.result || o?.result || '', r.note, o?.cert_name || '', o?.cert_stored || ''];
  });
  // 삭제와 전체 입력을 한 번의 요청(원자적)으로 보낸다 — 원격 DB 에서 수백 번 왕복하지 않도록
  await batch([{ sql: 'DELETE FROM trainings' }, ...args.map((a) => ({ sql: insertSql, args: a }))]);
  // 더 이상 연결되지 않은 수료증 파일 정리
  for (const o of old.values()) if (o.cert_stored && !kept.has(o.cert_stored)) await removeFile(o.cert_stored);
  res.json({ imported: rows.length, replaced: before, warnings });
});

// 월별·인원별 정리본 엑셀 내려받기
app.get('/api/trainings/export', auth, async (_req, res) => {
  const rows = await db.prepare('SELECT * FROM trainings ORDER BY id').all();
  if (!rows.length) throw httpError(404, '내보낼 교육 현황이 없습니다. 먼저 교육계획 엑셀을 업로드하세요.');
  const wb = buildTrainingReport(rows);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('교육현황_월별_인원별_정리.xlsx')}`);
  await wb.xlsx.write(res);
  res.end();
});

// ---------- 교육 참석 요청 메일 (관리자) ----------
const TRAINEES_SQL = `SELECT t.company, t.name, MAX(t.dept) AS dept, MAX(t.rank) AS rank, COUNT(*) AS n, e.email AS email
  FROM trainings t LEFT JOIN trainee_emails e ON e.company = t.company AND e.name = t.name
  GROUP BY t.company, t.name ORDER BY t.company, MAX(t.dept), t.name`;

app.get('/api/training-mail/settings', auth, adminOnly, async (_req, res) => {
  const people = await db.prepare(TRAINEES_SQL).all();
  res.json({ ...(await getTrainingMailSettings()), subject: MAIL_SUBJECT, defaultIntro: DEFAULT_INTRO, defaultOutro: DEFAULT_OUTRO, leadChoices: LEAD_CHOICES, smtp: mailConfigured(), people: people.length, withEmail: people.filter((p) => p.email).length });
});
app.put('/api/training-mail/settings', auth, adminOnly, async (req, res) => {
  res.json(await saveTrainingMailSettings(req.body || {}));
});

app.get('/api/training-mail/emails', auth, adminOnly, async (_req, res) => res.json(await db.prepare(TRAINEES_SQL).all()));
app.put('/api/training-mail/emails', auth, adminOnly, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const bad = [];
  const stmts = [];
  for (const it of items) {
    const company = String(it.company || '');
    const name = String(it.name || '');
    const email = String(it.email || '').trim();
    if (!name) continue;
    if (!email) stmts.push({ sql: 'DELETE FROM trainee_emails WHERE company = ? AND name = ?', args: [company, name] });
    else if (!isEmail(email)) bad.push(`${name}: ${email}`);
    else stmts.push({ sql: 'INSERT INTO trainee_emails (company, name, email) VALUES (?, ?, ?) ON CONFLICT(company, name) DO UPDATE SET email = excluded.email', args: [company, name, email] });
  }
  await batch(stmts);
  if (bad.length) throw httpError(400, `메일 주소 형식이 올바르지 않아 저장하지 못한 항목이 있습니다.\n${bad.join('\n')}`);
  res.json({ ok: true });
});

// 메일 주소 입력용 템플릿: 교육 대상자 전원이 미리 들어 있어 "메일주소" 열만 채워서 올리면 된다
app.get('/api/training-mail/emails/template', auth, adminOnly, async (_req, res) => {
  const people = await db.prepare(TRAINEES_SQL).all();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('메일주소');
  ws.columns = [['소속', 12], ['부서', 18], ['직급', 8], ['성명', 10], ['메일주소', 34]].map(([header, width]) => ({ header, width }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF0FB' } };
  for (const p of people) ws.addRow([p.company, p.dept, p.rank, p.name, p.email || '']);
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('교육대상자_메일주소_입력.xlsx')}`);
  await wb.xlsx.write(res);
  res.end();
});

// 메일 주소 엑셀 업로드: 성명(필수), 소속(선택·동명이인 구분), 메일주소
app.post('/api/training-mail/emails/import', auth, adminOnly, uploadMem.single('file'), async (req, res) => {
  if (!req.file) throw httpError(400, '엑셀 파일을 선택하세요.');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(req.file.buffer);
  } catch {
    throw httpError(400, '엑셀(.xlsx) 파일을 읽을 수 없습니다.');
  }
  const ws = wb.worksheets[0];
  const cols = {};
  const names = { name: ['성명', '이름'], company: ['소속', '회사'], email: ['메일주소', '메일', '이메일', 'email', 'e-mail', '이메일주소'] };
  ws.getRow(1).eachCell((c, i) => {
    const h = normHeader(cellValue(c));
    for (const [f, list] of Object.entries(names)) if (list.map(normHeader).includes(h) && !(f in cols)) cols[f] = i;
  });
  if (!cols.name || !cols.email) throw httpError(400, '첫 행에 "성명"과 "메일주소" 열이 필요합니다. 템플릿을 내려받아 사용해 보세요.');
  const people = await db.prepare(TRAINEES_SQL).all();
  const byName = new Map();
  for (const p of people) byName.set(p.name, [...(byName.get(p.name) || []), p]);
  const result = { updated: 0, notFound: [], ambiguous: [], invalid: [] };
  const stmts = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name = cellText(cellValue(row.getCell(cols.name)));
    const email = cellText(cellValue(row.getCell(cols.email)));
    const company = cols.company ? cellText(cellValue(row.getCell(cols.company))) : '';
    if (!name || !email) continue;
    if (!isEmail(email)) {
      result.invalid.push(`${r}행 ${name}: ${email}`);
      continue;
    }
    let cands = byName.get(name) || [];
    if (company) cands = cands.filter((p) => p.company === company);
    if (!cands.length) result.notFound.push(`${r}행 ${name}`);
    else if (cands.length > 1) result.ambiguous.push(`${r}행 ${name}`);
    else {
      stmts.push({ sql: 'INSERT INTO trainee_emails (company, name, email) VALUES (?, ?, ?) ON CONFLICT(company, name) DO UPDATE SET email = excluded.email', args: [cands[0].company, cands[0].name, email] });
      result.updated++;
    }
  }
  await batch(stmts); // 한 번의 요청으로 모두 반영
  res.json(result);
});

// 오늘 발송 대상 + 앞으로 예정된 발송 일정 미리보기
app.get('/api/training-mail/preview', auth, adminOnly, async (_req, res) => {
  const s = await getTrainingMailSettings();
  res.json({ smtp: mailConfigured(), enabled: s.enabled, sendTime: s.sendTime, due: await dueToday(s), upcoming: (await upcomingSends(s)).slice(0, 200) });
});

// 지금 발송 (오늘 대상 중 아직 안 보낸 것만, 중복 발송 방지)
app.post('/api/training-mail/send-now', auth, adminOnly, async (_req, res) => {
  if (!mailConfigured()) throw httpError(400, '이메일(SMTP) 설정이 없어 발송할 수 없습니다. .env 파일에 SMTP 정보를 입력하고 서버를 다시 시작하세요.');
  res.json(await runTrainingMailDue());
});

app.post('/api/training-mail/test', auth, adminOnly, async (req, res) => {
  const to = String(req.body?.to || '').trim();
  if (!isEmail(to)) throw httpError(400, '받을 메일 주소를 올바르게 입력하세요.');
  if (!mailConfigured()) throw httpError(400, '이메일(SMTP) 설정이 없어 발송할 수 없습니다. .env 파일에 SMTP 정보를 입력하고 서버를 다시 시작하세요.');
  try {
    await sendTrainingTestMail(to);
  } catch (e) {
    throw httpError(502, `테스트 메일 발송에 실패했습니다: ${e.message}`);
  }
  res.json({ ok: true });
});

app.get('/api/training-mail/log', auth, adminOnly, async (_req, res) => {
  res.json(
    await db.prepare(`SELECT l.id, l.lead, l.email, l.ok, l.error, l.sent_at, t.name, t.course, t.start_date
      FROM training_mail_log l LEFT JOIN trainings t ON t.id = l.training_id ORDER BY l.id DESC LIMIT 150`).all(),
  );
});

// ---------- 교육 이수 관리 (관리자): 이수 결과 입력 · 수료증 첨부 · 미이수자 안내 메일 ----------
const RESULT_CHOICES = ['', '이수', '취소', '퇴사', '휴직', '대체'];
app.post('/api/trainings/:id/result', auth, adminOnly, async (req, res) => {
  const result = String(req.body?.result ?? '');
  if (!RESULT_CHOICES.includes(result)) throw httpError(400, '실적 값이 올바르지 않습니다.');
  const r = await db.prepare('UPDATE trainings SET result = ? WHERE id = ?').run(result, req.params.id);
  if (!r.changes) throw httpError(404, '교육을 찾을 수 없습니다.');
  res.json({ ok: true });
});

app.post('/api/trainings/:id/cert', auth, adminOnly, upload.single('file'), async (req, res) => {
  if (!req.file) throw httpError(400, '수료증 파일을 선택하세요.');
  const t = await db.prepare('SELECT id, cert_stored FROM trainings WHERE id = ?').get(req.params.id);
  if (!t) throw httpError(404, '교육을 찾을 수 없습니다.');
  const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const stored = await saveFile(req.file.buffer, name, req.file.mimetype);
  await db.prepare('UPDATE trainings SET cert_name = ?, cert_stored = ? WHERE id = ?').run(name, stored, t.id);
  if (t.cert_stored) await removeFile(t.cert_stored);
  res.json({ ok: true, name });
});
app.get('/api/trainings/:id/cert', auth, adminOnly, async (req, res) => {
  const t = await db.prepare('SELECT cert_name, cert_stored FROM trainings WHERE id = ?').get(req.params.id);
  if (!t?.cert_stored) throw httpError(404, '첨부된 수료증이 없습니다.');
  const file = await openFile(t.cert_stored);
  if (!file) throw httpError(404, '저장된 파일을 찾을 수 없습니다.');
  res.setHeader('Content-Type', file.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(t.cert_name || '수료증')}`);
  if (file.size) res.setHeader('Content-Length', file.size);
  file.stream.on('error', () => res.destroy());
  file.stream.pipe(res);
});
app.delete('/api/trainings/:id/cert', auth, adminOnly, async (req, res) => {
  const t = await db.prepare('SELECT cert_stored FROM trainings WHERE id = ?').get(req.params.id);
  if (t?.cert_stored) await removeFile(t.cert_stored);
  await db.prepare("UPDATE trainings SET cert_name = '', cert_stored = '' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// 교육이 끝났는데 실적(이수 결과)이 비어 있는 사람에게 확인 요청 메일 (하루에 한 번만)
app.get('/api/training-mail/remind-preview', auth, adminOnly, async (_req, res) => {
  res.json({ smtp: mailConfigured(), people: await incompleteToday() });
});
app.post('/api/training-mail/remind', auth, adminOnly, async (_req, res) => {
  if (!mailConfigured()) throw httpError(400, '이메일(SMTP) 설정이 없어 발송할 수 없습니다. .env 파일에 SMTP 정보를 입력하고 서버를 다시 시작하세요.');
  res.json(await remindIncomplete());
});

// ---------- 만료일 관리 (계약·보험·점검 등): 조회는 모두, 입력·수정·삭제는 관리자 ----------
function cleanExpiration(b) {
  const name = String(b.name || '').trim();
  if (!name) throw httpError(400, '항목 이름을 입력하세요.');
  if (!/^\d{4}-\d\d-\d\d$/.test(b.expire_date || '')) throw httpError(400, '만료일을 입력하세요.');
  const alerts = parseAlertDays(b.alert_days);
  return {
    category: String(b.category || '').trim().slice(0, 20), name: name.slice(0, 100), expire_date: b.expire_date,
    owner: String(b.owner || '').trim().slice(0, 40), memo: String(b.memo || '').trim().slice(0, 500),
    alert_days: (alerts.length ? alerts : DEFAULT_ALERT_DAYS).join(','),
  };
}
app.get('/api/expirations', auth, async (_req, res) => {
  res.json(await db.prepare('SELECT id, category, name, expire_date, owner, memo, alert_days FROM expirations ORDER BY expire_date, name').all());
});
app.post('/api/expirations', auth, adminOnly, async (req, res) => {
  const f = cleanExpiration(req.body || {});
  const r = await db.prepare('INSERT INTO expirations (category, name, expire_date, owner, memo, alert_days, created_by) VALUES (?,?,?,?,?,?,?)').run(f.category, f.name, f.expire_date, f.owner, f.memo, f.alert_days, req.user.id);
  res.json({ id: r.lastInsertRowid });
});
app.put('/api/expirations/:id', auth, adminOnly, async (req, res) => {
  const f = cleanExpiration(req.body || {});
  const r = await db.prepare('UPDATE expirations SET category = ?, name = ?, expire_date = ?, owner = ?, memo = ?, alert_days = ? WHERE id = ?').run(f.category, f.name, f.expire_date, f.owner, f.memo, f.alert_days, req.params.id);
  if (!r.changes) throw httpError(404, '항목을 찾을 수 없습니다.');
  res.json({ ok: true });
});
app.delete('/api/expirations/:id', auth, adminOnly, async (req, res) => {
  await db.prepare('DELETE FROM expirations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 업무 템플릿: 정해진 절차를 한 번에 일정(체크리스트)으로 만든다 ----------
function cleanTemplate(b) {
  const name = String(b.name || '').trim().slice(0, 40);
  if (!name) throw httpError(400, '템플릿 이름을 입력하세요.');
  const items = (Array.isArray(b.items) ? b.items : [])
    .map((i) => ({ title: String(i.title || '').trim().slice(0, 100), offset: Math.max(-365, Math.min(365, Math.round(+i.offset || 0))), urgent: !!i.urgent }))
    .filter((i) => i.title)
    .slice(0, 40);
  if (!items.length) throw httpError(400, '할 일을 한 개 이상 입력하세요.');
  return { name, items: JSON.stringify(items) };
}
const templateOut = (t) => ({ id: t.id, name: t.name, items: JSON.parse(t.items || '[]') });
app.get('/api/templates', auth, async (_req, res) => {
  res.json((await db.prepare('SELECT id, name, items FROM templates ORDER BY id').all()).map(templateOut));
});
app.post('/api/templates', auth, async (req, res) => {
  const f = cleanTemplate(req.body || {});
  const r = await db.prepare('INSERT INTO templates (name, items) VALUES (?, ?)').run(f.name, f.items);
  res.json({ id: r.lastInsertRowid });
});
app.put('/api/templates/:id', auth, async (req, res) => {
  const f = cleanTemplate(req.body || {});
  const r = await db.prepare('UPDATE templates SET name = ?, items = ? WHERE id = ?').run(f.name, f.items, req.params.id);
  if (!r.changes) throw httpError(404, '템플릿을 찾을 수 없습니다.');
  res.json({ ok: true });
});
app.delete('/api/templates/:id', auth, async (req, res) => {
  await db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 주기 작업 호출 / 상태 확인 ----------
// 서버가 상시 떠 있지 않은 Vercel 에서는 이 주소를 5분마다 호출해 알람·자동 종료·교육 메일을 실행한다.
// (Vercel Cron 또는 cron-job.org 같은 외부 서비스가 "Authorization: Bearer <CRON_SECRET>" 헤더와 함께 호출)
app.get('/api/cron/tick', async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  const given = String(req.headers.authorization || '');
  const expected = `Bearer ${secret}`;
  const ok = secret && given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  await ensureReady();
  res.json(await runScheduledJobs());
});

// 배포가 제대로 됐는지 확인용 (비밀 정보 없이 연결 상태만 알려준다)
app.get('/api/health', async (_req, res) => {
  const out = { ok: true, storage: storageMode, smtp: mailConfigured(), cronSecret: !!process.env.CRON_SECRET, joinCode: !!process.env.JOIN_CODE, tzOffsetMin: Number(process.env.APP_TZ_OFFSET_MIN || 540) };
  try {
    await ensureReady();
    out.users = (await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n;
    out.db = true;
  } catch (e) {
    out.ok = false;
    out.db = false;
    out.error = String(e.message).slice(0, 200);
  }
  res.status(out.ok ? 200 : 503).json(out);
});

// ---------- 오류 처리 ----------
app.use((err, _req, res, _next) => {
  if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: `파일이 너무 큽니다. (한 파일 ${Math.floor(MAX_UPLOAD_BYTES / 1048576)}MB 이하로 올려 주세요)` });
  console.error(err);
  res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

// Vercel 은 이 앱을 함수로 실행한다(기본 export). 직접 실행(npm start)할 때만 포트를 열고 스케줄러를 켠다.
if (!process.env.VERCEL) {
  // 내 컴퓨터에서만 접속되도록 localhost 에만 연다. 사내망의 다른 사람도 쓰게 하려면 HOST=0.0.0.0 을 .env 에 지정한다.
  app.listen(PORT, process.env.HOST || '127.0.0.1', () => {
    console.log(`업무 캘린더 실행 중: http://localhost:${PORT}`);
    if (!mailConfigured()) console.log('※ SMTP가 설정되지 않아 알람 메일은 발송되지 않습니다. (앱 상단 알림은 정상 동작) .env 파일을 확인하세요.');
    ensureReady().then(startScheduler).catch((e) => console.error('DB 초기화 실패:', e));
  });
}

export default app;
