import './env.js';
import express from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, tx, uploadDir } from './db.js';
import { parse, fmt, fmtDate, fmtTime, expand, span, floatingNow, DAY } from './recur.js';
import { startScheduler } from './scheduler.js';
import { mailConfigured } from './mailer.js';
import { pushNote, addHistory } from './notify.js';
import { parseTrainingWorkbook, buildTrainingReport } from './training.js';
import {
  getSettings as getTrainingMailSettings, saveSettings as saveTrainingMailSettings, LEAD_CHOICES, isEmail, MAIL_SUBJECT, DEFAULT_INTRO, DEFAULT_OUTRO,
  dueToday, upcomingSends, runDue as runTrainingMailDue, sendTestMail as sendTrainingTestMail,
} from './training-mail.js';

const root = import.meta.dirname;
const PORT = +(process.env.PORT || 3000);
const COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#d6336c', '#5c940d', '#4263eb', '#868e96'];

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/vendor/fc', express.static(path.join(root, 'node_modules/fullcalendar')));
app.use('/vendor/fc-locales', express.static(path.join(root, 'node_modules/@fullcalendar/core/locales')));
app.use(express.static(path.join(root, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
});

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ---------- 인증 ----------
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

function auth(req, res, next) {
  const token = getCookie(req, 'sid');
  const u = token && db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);
  if (!u) return res.status(401).json({ error: '로그인이 필요합니다.' });
  req.user = u;
  next();
}
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
}

app.post('/api/register', (req, res) => {
  const { email, name, password, joinCode } = req.body || {};
  if (!email || !name || !password) return res.status(400).json({ error: '이메일, 이름, 비밀번호를 입력하세요.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: '이메일 형식이 올바르지 않습니다.' });
  if (password.length < 6) return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });
  if (process.env.JOIN_CODE && joinCode !== process.env.JOIN_CODE) return res.status(403).json({ error: '가입 코드가 올바르지 않습니다.' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.toLowerCase())) return res.status(409).json({ error: '이미 가입된 이메일입니다.' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const org = cleanOrg(req.body);
  const r = db
    .prepare('INSERT INTO users (email, name, pw_hash, role, color, site, dept, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(email.toLowerCase(), name.trim(), hashPw(password), count === 0 ? 'admin' : 'member', COLORS[count % COLORS.length], org.site, org.dept, org.position);
  startSession(res, Number(r.lastInsertRowid));
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)));
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
  if (!u || !checkPw(String(password || ''), u.pw_hash)) return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
  startSession(res, u.id);
  res.json(publicUser(u));
});

app.post('/api/logout', (req, res) => {
  const token = getCookie(req, 'sid');
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ ...publicUser(req.user), mailConfigured: mailConfigured() }));
app.get('/api/users', auth, (req, res) =>
  res.json(
    db
      .prepare('SELECT id, name, color, email, role, site, dept, position FROM users ORDER BY id')
      .all()
      .map((u) => (req.user.role === 'admin' ? u : { id: u.id, name: u.name, color: u.color, site: u.site, dept: u.dept, position: u.position })),
  ),
);

// 내 소속 정보 수정 / 관리자가 팀원 소속 정보 수정
app.put('/api/me/profile', auth, (req, res) => {
  const o = cleanOrg(req.body);
  db.prepare('UPDATE users SET site = ?, dept = ?, position = ? WHERE id = ?').run(o.site, o.dept, o.position, req.user.id);
  res.json({ ok: true });
});
app.put('/api/users/:id/profile', auth, (req, res, next) => {
  if (req.user.role !== 'admin') return next(httpError(403, '관리자만 사용할 수 있습니다.'));
  const o = cleanOrg(req.body);
  db.prepare('UPDATE users SET site = ?, dept = ?, position = ? WHERE id = ?').run(o.site, o.dept, o.position, req.params.id);
  res.json({ ok: true });
});
const userNames = () => new Map(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));

// ---------- 비밀번호 / 사용자 관리 ----------
const adminOnly = (req, _res, next) => (req.user.role === 'admin' ? next() : next(httpError(403, '관리자만 사용할 수 있습니다.')));

// 본인 비밀번호 변경 (현재 세션 외 다른 로그인은 해제)
app.post('/api/me/password', auth, (req, res) => {
  const { current, password } = req.body || {};
  if (!checkPw(String(current || ''), req.user.pw_hash)) throw httpError(400, '현재 비밀번호가 올바르지 않습니다.');
  if (String(password || '').length < 6) throw httpError(400, '새 비밀번호는 6자 이상이어야 합니다.');
  db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(hashPw(password), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, getCookie(req, 'sid'));
  res.json({ ok: true });
});

// 관리자가 팀원 비밀번호를 임시 비밀번호로 재설정
app.post('/api/users/:id/reset-password', auth, adminOnly, (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!u) throw httpError(404, '사용자를 찾을 수 없습니다.');
  const temp = crypto.randomBytes(6).toString('base64url');
  db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(hashPw(temp), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  res.json({ password: temp });
});

// 관리자가 팀원 삭제 (그 사람이 등록한 일정·첨부파일도 함께 삭제)
app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) throw httpError(404, '사용자를 찾을 수 없습니다.');
  if (u.id === req.user.id) throw httpError(400, '본인 계정은 삭제할 수 없습니다.');
  const files = db
    .prepare('SELECT a.stored FROM attachments a JOIN events e ON e.id = a.event_id WHERE e.owner_id = ?')
    .all(u.id);
  tx(() => db.prepare('DELETE FROM users WHERE id = ?').run(u.id));
  for (const f of files) fs.rmSync(path.join(uploadDir, f.stored), { force: true });
  res.json({ ok: true });
});

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

const attendeesOf = (eventId) => db.prepare('SELECT user_id, response FROM attendees WHERE event_id = ?').all(eventId);
// 일정과 관련된 모든 사람(등록자·참석자·담당자)
const involvedIds = (ev, att = attendeesOf(ev.id)) => [ev.owner_id, ev.assignee_id, ...att.map((a) => a.user_id)].filter(Boolean);

// ---------- 일정 조회 ----------
function loadEvents() {
  const events = db.prepare('SELECT e.*, u.name AS owner_name, u.color AS owner_color FROM events e JOIN users u ON u.id = e.owner_id').all();
  const group = (sql) => {
    const m = new Map();
    for (const r of db.prepare(sql).all()) {
      if (!m.has(r.event_id)) m.set(r.event_id, []);
      m.get(r.event_id).push(r);
    }
    return m;
  };
  return {
    events,
    attendees: group('SELECT event_id, user_id, response FROM attendees'),
    alarms: group('SELECT event_id, minutes FROM alarms ORDER BY minutes'),
    attachments: group('SELECT a.id, a.event_id, a.filename, a.size, a.created_at, u.name AS uploader FROM attachments a LEFT JOIN users u ON u.id = a.user_id'),
    // 일정별 마지막 변경자 / 변경 시각 (댓글·참석 응답은 제외)
    lastEdit: new Map(
      db.prepare("SELECT h.event_id, u.name, h.created_at FROM history h LEFT JOIN users u ON u.id = h.user_id WHERE h.id IN (SELECT MAX(id) FROM history WHERE action IN ('created', 'updated', 'cancelled', 'done', 'restored') AND user_id IS NOT NULL GROUP BY event_id)")
        .all().map((r) => [r.event_id, r]),
    ),
    exceptions: group('SELECT * FROM exceptions'),
    comments: new Map(db.prepare('SELECT event_id, COUNT(*) AS n FROM comments GROUP BY event_id').all().map((r) => [r.event_id, r.n])),
  };
}

function visibleOccurrences(user, from, to) {
  const d = loadEvents();
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

app.get('/api/events', auth, (req, res) => {
  if (!req.query.start || !req.query.end) return res.status(400).json({ error: 'start, end 필요' });
  const [from, to] = parseRange(req.query);
  const names = userNames();
  res.json(visibleOccurrences(req.user, from, to).map((it) => toEvent(it, req.user, names)));
});

// 검색·필터: 기간 / 제목(키워드) / 담당자 / 참석자 / 일정 종류
app.get('/api/search', auth, (req, res) => {
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
  const names = userNames();
  const items = visibleOccurrences(req.user, from, to)
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
function clean(b) {
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
  if (assignee_id && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(assignee_id)) throw httpError(400, '담당자를 찾을 수 없습니다.');
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
    attendees: [...new Set((b.attendees || []).map(Number))].filter((id) => db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)),
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
function setChildren(eventId, attendees, alarms) {
  const have = new Set(attendeesOf(eventId).map((a) => a.user_id));
  for (const uid of have) if (!attendees.includes(uid)) db.prepare('DELETE FROM attendees WHERE event_id = ? AND user_id = ?').run(eventId, uid);
  for (const uid of attendees) if (!have.has(uid)) db.prepare('INSERT INTO attendees (event_id, user_id) VALUES (?, ?)').run(eventId, uid);
  // 기존 알람은 유지하고(발송 기록 보존) 변경된 것만 추가/삭제
  const haveAl = db.prepare('SELECT id, minutes FROM alarms WHERE event_id = ?').all(eventId);
  for (const a of haveAl) if (!alarms.includes(a.minutes)) db.prepare('DELETE FROM alarms WHERE id = ?').run(a.id);
  for (const m of alarms) if (!haveAl.some((a) => a.minutes === m)) db.prepare('INSERT INTO alarms (event_id, minutes) VALUES (?, ?)').run(eventId, m);
}

function insertEvent(ownerId, f) {
  const r = db
    .prepare('INSERT INTO events (owner_id, assignee_id, title, start, end, all_day, location, memo, category, urgent, importance, kind, visibility, edit_perm, recur) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(ownerId, f.assignee_id, f.title, f.start, f.end, f.all_day, f.location, f.memo, f.category, f.urgent, f.importance, f.kind, f.visibility, f.edit_perm, f.recur ? JSON.stringify(f.recur) : null);
  const id = Number(r.lastInsertRowid);
  setChildren(id, f.attendees, f.alarms);
  return id;
}

// 수정 가능한 일정을 가져온다. manage=true 이면 등록자·관리자만 허용 (삭제, 공개/수정권한 변경)
function ownEvent(req, { manage = false } = {}) {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev) throw httpError(404, '일정을 찾을 수 없습니다.');
  const att = attendeesOf(ev.id);
  if (!canSee(ev, att, req.user.id) && req.user.role !== 'admin') throw httpError(404, '일정을 찾을 수 없습니다.');
  if (manage ? !canManage(ev, req.user) : !canEditEvent(ev, att, req.user)) {
    throw httpError(403, manage ? '등록자만 할 수 있는 작업입니다.' : '이 일정을 수정할 권한이 없습니다.');
  }
  return ev;
}
// 볼 수 있는 일정만 가져온다 (댓글·이력·응답용)
function visibleEvent(req) {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev || (!canSee(ev, attendeesOf(ev.id), req.user.id) && req.user.role !== 'admin')) throw httpError(404, '일정을 찾을 수 없습니다.');
  return ev;
}

// 해당 회차 이전까지만 반복되도록 기존 시리즈를 자른다
function truncateSeries(ev, occ) {
  const recur = JSON.parse(ev.recur);
  recur.endType = 'until';
  recur.until = fmtDate(parse(occ) - DAY);
  recur.count = null;
  db.prepare('UPDATE events SET recur = ? WHERE id = ?').run(JSON.stringify(recur), ev.id);
  db.prepare('DELETE FROM exceptions WHERE event_id = ? AND occ >= ?').run(ev.id, occ);
}
const masterKey = (ev) => fmt(parse(ev.start), ev.all_day);

// 해당 회차의 현재 값 (변경 전 비교용)
function occurrenceValues(ev, occ) {
  const exceptions = db.prepare('SELECT * FROM exceptions WHERE event_id = ?').all(ev.id);
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
function createEvent(user, f, source = '') {
  const id = tx(() => {
    const id = insertEvent(user.id, f);
    addHistory(id, user.id, 'created', `일정 등록${source}: ${f.title} (${whenText(f)})`);
    return id;
  });
  const invited = f.attendees.filter((u) => u !== user.id);
  const note = { event_id: id, ref_start: f.start, body: `${user.name}님 · ${whenText(f)}${f.location ? ' · ' + f.location : ''}` };
  pushNote(invited, { ...note, type: 'invite', title: `[초대] ${f.title}` }, user.id);
  pushNote(f.assignee_id && !invited.includes(f.assignee_id) ? [f.assignee_id] : [], { ...note, type: 'assign', title: `[담당자 지정] ${f.title}` }, user.id);
  return id;
}

app.post('/api/events', auth, (req, res) => {
  res.json({ id: createEvent(req.user, clean(req.body)) });
});

// ---------- 엑셀 업로드 (일정 일괄 등록) ----------
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const IMPORT_MAX_ROWS = 500;
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
  for (const u of db.prepare('SELECT id, name FROM users').all()) byName.set(u.name, [...(byName.get(u.name) || []), u.id]);
  const names = userNames();
  const existing = new Set(db.prepare('SELECT title, start FROM events WHERE owner_id = ?').all(req.user.id).map((e) => `${e.title}|${e.start}`));
  const seen = new Set();
  const out = rows.map(({ r, get }) => {
    const p = parseImportRow(get, { byName, userId: req.user.id });
    let cleaned = null;
    if (!p.errors.length) {
      try {
        cleaned = clean(p.body);
      } catch (e) {
        p.errors.push(e.message);
      }
    }
    const key = `${p.body.title}|${p.body.start}`;
    const dup = !p.errors.length && (existing.has(key) || seen.has(key));
    seen.add(key);
    return {
      row: r, errors: p.errors, warnings: p.warnings, dup,
      body: p.errors.length ? null : p.body,
      preview: {
        title: p.body.title, start: p.body.start, end: p.body.end, all_day: p.body.all_day,
        kind: p.body.kind, category: p.body.category, urgent: p.body.urgent, importance: p.body.importance,
        location: p.body.location, assignee: names.get(p.body.assignee_id) || '',
        attendees: p.body.attendees.map((u) => names.get(u)), recur: p.body.recur ? RECUR_LABEL[p.body.recur.freq] : '',
        visibility: cleaned?.visibility,
      },
    };
  });
  res.json({ total: out.length, ok: out.filter((o) => !o.errors.length).length, rows: out });
});

app.post('/api/import/commit', auth, (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) throw httpError(400, '등록할 일정이 없습니다.');
  if (rows.length > IMPORT_MAX_ROWS) throw httpError(400, `한 번에 ${IMPORT_MAX_ROWS}건까지 등록할 수 있습니다.`);
  let created = 0;
  const failed = [];
  rows.forEach((b, i) => {
    try {
      const f = clean(b);
      f.attendees = f.attendees.filter((u) => u !== req.user.id);
      createEvent(req.user, f, ' (엑셀 업로드)');
      created++;
    } catch (e) {
      failed.push({ index: i, title: String(b?.title || ''), error: e.message });
    }
  });
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
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() + ((8 - d.getDay()) % 7 || 7));
  const day = (o) => fmtDate(Date.UTC(mon.getFullYear(), mon.getMonth(), mon.getDate() + o));
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
    ['참고', '일정 엑셀 내보내기로 받은 파일도 그대로 업로드할 수 있습니다. 한 번에 최대 500행, 5MB까지.'],
  ]);
  guide.getRow(1).font = { bold: true };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('일정_업로드_템플릿.xlsx')}`);
  await wb.xlsx.write(res);
  res.end();
});

app.put('/api/events/:id', auth, (req, res) => {
  const ev = ownEvent(req);
  const f = clean(req.body);
  // 종류·공개 범위·수정 권한은 등록자(또는 관리자)만 바꿀 수 있다
  if (!canManage(ev, req.user)) Object.assign(f, { kind: ev.kind, visibility: ev.visibility, edit_perm: ev.edit_perm });
  let scope = req.body.scope || 'all';
  const occ = req.body.occ || masterKey(ev);
  if (!ev.recur) scope = 'all';
  if (scope === 'future' && occ === masterKey(ev)) scope = 'all';

  const names = userNames();
  const oldOcc = occurrenceValues(ev, occ);
  const oldAtt = attendeesOf(ev.id);
  const oldAttIds = oldAtt.map((a) => a.user_id);
  const changes = diffEvent(oldOcc, ev, f, names, scope !== 'one'); // '이 일정만' 수정에서는 반복 규칙을 바꾸지 않는다

  const id = tx(() => {
    if (scope === 'one') {
      const ov = { title: f.title, start: f.start, end: f.end, all_day: f.all_day, location: f.location, memo: f.memo, category: f.category, urgent: f.urgent, importance: f.importance };
      const cur = db.prepare('SELECT override FROM exceptions WHERE event_id = ? AND occ = ?').get(ev.id, occ);
      const merged = { ...(cur?.override ? JSON.parse(cur.override) : {}), ...ov };
      db.prepare('INSERT INTO exceptions (event_id, occ, deleted, override) VALUES (?, ?, 0, ?) ON CONFLICT(event_id, occ) DO UPDATE SET deleted = 0, override = excluded.override').run(ev.id, occ, JSON.stringify(merged));
      db.prepare('UPDATE events SET assignee_id = ?, kind = ?, visibility = ?, edit_perm = ? WHERE id = ?').run(f.assignee_id, f.kind, f.visibility, f.edit_perm, ev.id);
      setChildren(ev.id, f.attendees, f.alarms);
      return ev.id;
    }
    if (scope === 'future') {
      truncateSeries(ev, occ);
      const nid = insertEvent(ev.owner_id, f);
      // 참석 응답은 새 시리즈로 이어받는다
      for (const a of oldAtt) db.prepare('UPDATE attendees SET response = ? WHERE event_id = ? AND user_id = ?').run(a.response, nid, a.user_id);
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
    db.prepare('UPDATE events SET title=?, start=?, end=?, all_day=?, location=?, memo=?, category=?, urgent=?, importance=?, assignee_id=?, kind=?, visibility=?, edit_perm=?, recur=? WHERE id=?').run(
      f.title, start, end, f.all_day, f.location, f.memo, f.category, f.urgent, f.importance, f.assignee_id, f.kind, f.visibility, f.edit_perm, f.recur ? JSON.stringify(f.recur) : null, ev.id,
    );
    if (ev.recur && start !== ev.start) db.prepare('DELETE FROM exceptions WHERE event_id = ?').run(ev.id);
    setChildren(ev.id, f.attendees, f.alarms);
    return ev.id;
  });

  // 이력 + 알림
  const invited = f.attendees.filter((u) => !oldAttIds.includes(u) && u !== req.user.id);
  const removed = oldAttIds.filter((u) => !f.attendees.includes(u));
  const lines = [...changes];
  if (invited.length) lines.push(`참석자 초대: ${invited.map((u) => names.get(u)).join(', ')}`);
  if (removed.length) lines.push(`참석자 제외: ${removed.map((u) => names.get(u)).join(', ')}`);
  const prefix = scope === 'one' ? `[이 일정만 · ${occ.replace('T', ' ')}] ` : scope === 'future' ? `[이후 일정 · ${occ.replace('T', ' ')}] ` : '';
  if (lines.length) addHistory(id, req.user.id, 'updated', prefix + lines.join('\n'));
  const note = { event_id: id, ref_start: f.start };
  pushNote(invited, { ...note, type: 'invite', title: `[초대] ${f.title}`, body: `${req.user.name}님 · ${whenText(f)}` }, req.user.id);
  if (f.assignee_id !== ev.assignee_id && f.assignee_id && !invited.includes(f.assignee_id)) {
    pushNote([f.assignee_id], { ...note, type: 'assign', title: `[담당자 지정] ${f.title}`, body: `${req.user.name}님이 지정했습니다.` }, req.user.id);
  }
  if (changes.length) {
    const audience = involvedIds({ ...ev, assignee_id: f.assignee_id }, f.attendees.map((u) => ({ user_id: u }))).filter((u) => !invited.includes(u) && u !== f.assignee_id);
    const withAssignee = f.assignee_id && f.assignee_id === ev.assignee_id ? [f.assignee_id] : [];
    pushNote([...audience, ...withAssignee], { ...note, type: 'change', title: `[변경] ${f.title}`, body: `${req.user.name}님이 변경\n${changes.join('\n')}` }, req.user.id);
  }
  res.json({ id });
});

// 일정 종료(완료) / 취소 / 복원 (삭제와 달리 기록이 남고 되돌릴 수 있다)
app.post('/api/events/:id/status', auth, (req, res) => {
  const ev = ownEvent(req);
  const status = ['cancelled', 'done'].includes(req.body.status) ? req.body.status : 'active';
  let scope = req.body.scope === 'one' ? 'one' : 'all';
  const occ = req.body.occ || masterKey(ev);
  if (!ev.recur) scope = 'all';
  const cur = occurrenceValues(ev, occ);
  const word = status === 'active' ? (cur.status === 'done' ? '종료 해제' : '복원') : STATUS_WORD[status];
  tx(() => {
    if (scope === 'one') {
      const row = db.prepare('SELECT override FROM exceptions WHERE event_id = ? AND occ = ?').get(ev.id, occ);
      const ov = { ...(row?.override ? JSON.parse(row.override) : {}), status };
      db.prepare('INSERT INTO exceptions (event_id, occ, deleted, override) VALUES (?, ?, 0, ?) ON CONFLICT(event_id, occ) DO UPDATE SET deleted = 0, override = excluded.override').run(ev.id, occ, JSON.stringify(ov));
    } else {
      db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, ev.id);
      // 개별 회차의 취소/복원 설정은 전체 설정을 따르도록 정리
      for (const x of db.prepare('SELECT id, override FROM exceptions WHERE event_id = ? AND override IS NOT NULL').all(ev.id)) {
        const ov = JSON.parse(x.override);
        if ('status' in ov) {
          delete ov.status;
          db.prepare('UPDATE exceptions SET override = ? WHERE id = ?').run(JSON.stringify(ov), x.id);
        }
      }
    }
    addHistory(ev.id, req.user.id, status === 'active' ? 'restored' : status, `${scope === 'one' ? `이 일정만 (${occ.replace('T', ' ')}) ` : ev.recur ? '모든 일정 ' : ''}${word}`);
  });
  pushNote(involvedIds(ev), {
    type: { cancelled: 'cancel', done: 'done', active: 'restore' }[status], event_id: ev.id, ref_start: cur.start,
    title: `[${word}] ${cur.title}`, body: `${req.user.name}님이 일정을 ${word}했습니다. (${whenText(cur)})`,
  }, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/events/:id', auth, (req, res) => {
  const ev = ownEvent(req, { manage: true });
  let scope = String(req.query.scope || 'all');
  const occ = String(req.query.occ || masterKey(ev));
  if (!ev.recur) scope = 'all';
  if (scope === 'future' && occ === masterKey(ev)) scope = 'all';
  const audience = involvedIds(ev);
  const cur = occurrenceValues(ev, occ);
  tx(() => {
    if (scope === 'one') {
      db.prepare('INSERT INTO exceptions (event_id, occ, deleted, override) VALUES (?, ?, 1, NULL) ON CONFLICT(event_id, occ) DO UPDATE SET deleted = 1, override = NULL').run(ev.id, occ);
      addHistory(ev.id, req.user.id, 'updated', `이 일정만 삭제 (${occ.replace('T', ' ')})`);
    } else if (scope === 'future') {
      truncateSeries(ev, occ);
      addHistory(ev.id, req.user.id, 'updated', `이후 일정 삭제 (${occ.replace('T', ' ')} 부터)`);
    } else {
      for (const a of db.prepare('SELECT stored FROM attachments WHERE event_id = ?').all(ev.id)) fs.rmSync(path.join(uploadDir, a.stored), { force: true });
      db.prepare('DELETE FROM events WHERE id = ?').run(ev.id);
    }
  });
  pushNote(audience, { type: 'delete', title: `[삭제] ${cur.title}`, body: `${req.user.name}님이 일정을 삭제했습니다. (${whenText(cur)})` }, req.user.id);
  res.json({ ok: true });
});

// ---------- 참석 응답 / 겹침 안내 ----------
app.post('/api/events/:id/respond', auth, (req, res) => {
  const ev = visibleEvent(req);
  const response = req.body.response;
  if (!['yes', 'no', 'maybe'].includes(response)) throw httpError(400, '응답 값이 올바르지 않습니다.');
  const r = db.prepare('UPDATE attendees SET response = ? WHERE event_id = ? AND user_id = ?').run(response, ev.id, req.user.id);
  if (r.changes === 0) throw httpError(403, '참석자로 초대된 일정이 아닙니다.');
  addHistory(ev.id, req.user.id, 'response', `${req.user.name}님 응답: ${RESPONSES[response]}`);
  pushNote([ev.owner_id], {
    type: 'response', event_id: ev.id, ref_start: ev.start,
    title: `[참석 응답] ${ev.title}`, body: `${req.user.name}님: ${RESPONSES[response]}`,
  }, req.user.id);
  res.json({ ok: true });
});

// 선택한 시간에 등록자·참석자·담당자의 다른 일정이 있는지 알려준다
app.post('/api/conflicts', auth, (req, res) => {
  const b = req.body || {};
  const all_day = !!b.all_day;
  const re = all_day ? /^\d{4}-\d\d-\d\d$/ : /^\d{4}-\d\d-\d\dT\d\d:\d\d$/;
  if (!re.test(b.start || '') || !re.test(b.end || '') || parse(b.end) < parse(b.start)) return res.json([]);
  const [s, e] = span({ start: b.start, end: b.end, all_day });
  const exclude = +b.exclude_id || null;
  const owner = exclude ? db.prepare('SELECT owner_id FROM events WHERE id = ?').get(exclude)?.owner_id : req.user.id;
  const people = new Set([owner, +b.assignee_id || null, ...(b.attendees || []).map(Number)].filter(Boolean));
  const names = userNames();
  const d = loadEvents();
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
app.get('/api/events/:id/comments', auth, (req, res) => {
  const ev = visibleEvent(req);
  res.json(
    db.prepare('SELECT c.id, c.body, c.created_at, c.user_id, u.name FROM comments c JOIN users u ON u.id = c.user_id WHERE c.event_id = ? ORDER BY c.id').all(ev.id)
      .map((c) => ({ ...c, canDelete: c.user_id === req.user.id || canManage(ev, req.user) })),
  );
});
app.post('/api/events/:id/comments', auth, (req, res) => {
  const ev = visibleEvent(req);
  const body = String(req.body.body || '').trim().slice(0, 2000);
  if (!body) throw httpError(400, '댓글 내용을 입력하세요.');
  db.prepare('INSERT INTO comments (event_id, user_id, body) VALUES (?, ?, ?)').run(ev.id, req.user.id, body);
  addHistory(ev.id, req.user.id, 'comment', `댓글 작성: ${body.length > 80 ? body.slice(0, 80) + '…' : body}`);
  pushNote(involvedIds(ev), {
    type: 'comment', event_id: ev.id, ref_start: ev.start,
    title: `[댓글] ${ev.title}`, body: `${req.user.name}: ${body.slice(0, 80)}`,
  }, req.user.id);
  res.json({ ok: true });
});
app.delete('/api/comments/:id', auth, (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!c) throw httpError(404, '댓글을 찾을 수 없습니다.');
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(c.event_id);
  if (c.user_id !== req.user.id && !canManage(ev, req.user)) throw httpError(403, '권한이 없습니다.');
  db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
  const author = userNames().get(c.user_id) || '(알 수 없음)';
  addHistory(ev.id, req.user.id, 'comment', `댓글 삭제 (작성자 ${author}): ${c.body.length > 60 ? c.body.slice(0, 60) + '…' : c.body}`);
  res.json({ ok: true });
});

// 최근 활동 기록 (내가 볼 수 있는 일정의 등록·변경·취소·댓글·첨부·응답 이력)
app.get('/api/activity', auth, (req, res) => {
  const d = loadEvents();
  const visible = new Map();
  for (const ev of d.events) if (canSee(ev, d.attendees.get(ev.id), req.user.id)) visible.set(ev.id, ev);
  const rows = db
    .prepare('SELECT h.id, h.event_id, h.action, h.detail, h.created_at, h.user_id, u.name FROM history h LEFT JOIN users u ON u.id = h.user_id ORDER BY h.id DESC LIMIT 400')
    .all()
    .filter((h) => visible.has(h.event_id) && !(h.action === 'done' && !h.user_id)) // 시스템 자동 종료는 제외
    .slice(0, 15)
    .map((h) => ({ id: h.id, action: h.action, detail: h.detail, who: h.name || '', at: h.created_at, event_id: h.event_id, title: visible.get(h.event_id).title, ref_start: visible.get(h.event_id).start }));
  res.json({ items: rows });
});
app.get('/api/events/:id/history', auth, (req, res) => {
  const ev = visibleEvent(req);
  res.json(
    db.prepare('SELECT h.id, h.action, h.detail, h.created_at, u.name FROM history h LEFT JOIN users u ON u.id = h.user_id WHERE h.event_id = ? ORDER BY h.id DESC LIMIT 100').all(ev.id),
  );
});

// ---------- 대시보드 빠른 메모 (본인만 볼 수 있음) ----------
app.get('/api/notes', auth, (req, res) => {
  res.json(db.prepare('SELECT id, body, created_at FROM notes WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id));
});
app.post('/api/notes', auth, (req, res) => {
  const body = String(req.body?.body || '').trim().slice(0, 500);
  if (!body) throw httpError(400, '메모 내용을 입력하세요.');
  const r = db.prepare('INSERT INTO notes (user_id, body) VALUES (?, ?)').run(req.user.id, body);
  res.json({ id: Number(r.lastInsertRowid) });
});
app.delete('/api/notes/:id', auth, (req, res) => {
  db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ---------- 내부 알림 ----------
app.get('/api/notifications', auth, (req, res) => {
  const items = db.prepare('SELECT id, type, event_id, ref_start, title, body, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).n;
  res.json({ unread, items });
});
app.post('/api/notifications/read', auth, (req, res) => {
  if (req.body?.all) {
    db.prepare("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL").run(req.user.id);
  } else {
    for (const id of (req.body?.ids || []).map(Number)) {
      db.prepare("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND read_at IS NULL").run(id, req.user.id);
    }
  }
  res.json({ ok: true });
});
app.delete('/api/notifications', auth, (req, res) => {
  db.prepare('DELETE FROM notifications WHERE user_id = ? AND read_at IS NOT NULL').run(req.user.id);
  res.json({ ok: true });
});

// ---------- 첨부파일 ----------
app.post('/api/events/:id/attachments', auth, upload.array('files'), (req, res) => {
  let ev;
  try {
    ev = ownEvent(req);
  } catch (e) {
    for (const f of req.files || []) fs.rmSync(f.path, { force: true });
    throw e;
  }
  const names = [];
  for (const f of req.files || []) {
    const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
    names.push(name);
    db.prepare("INSERT INTO attachments (event_id, filename, stored, size, user_id, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))").run(req.params.id, name, f.filename, f.size, req.user.id);
  }
  if (names.length) addHistory(ev.id, req.user.id, 'updated', `첨부파일 추가: ${names.join(', ')}`);
  res.json({ ok: true });
});

function attachmentFor(req) {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!a) throw httpError(404, '파일을 찾을 수 없습니다.');
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(a.event_id);
  if (!canSee(ev, attendeesOf(a.event_id), req.user.id)) throw httpError(403, '권한이 없습니다.');
  return { a, ev };
}
app.get('/api/attachments/:id', auth, (req, res) => {
  const { a } = attachmentFor(req);
  res.download(path.join(uploadDir, a.stored), a.filename);
});
app.delete('/api/attachments/:id', auth, (req, res) => {
  const { a, ev } = attachmentFor(req);
  if (!canEditEvent(ev, attendeesOf(ev.id), req.user)) throw httpError(403, '권한이 없습니다.');
  fs.rmSync(path.join(uploadDir, a.stored), { force: true });
  db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
  addHistory(ev.id, req.user.id, 'updated', `첨부파일 삭제: ${a.filename}`);
  res.json({ ok: true });
});

// ---------- 엑셀 내보내기 ----------
const RECUR_LABEL = { daily: '매일', weekly: '매주', monthly: '매월', yearly: '매년' };
app.get('/api/export', auth, async (req, res) => {
  if (!req.query.start || !req.query.end) return res.status(400).json({ error: 'start, end 필요' });
  const [from, to] = parseRange(req.query);
  const onlyMine = req.query.users ? new Set(String(req.query.users).split(',').map(Number)) : null;
  const names = userNames();
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
  const rows = visibleOccurrences(req.user, from, to)
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
app.get('/api/trainings', auth, (_req, res) => {
  res.json(db.prepare('SELECT * FROM trainings ORDER BY month = 0, month, COALESCE(start_date, \'9999\'), dept, name').all());
});

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
  const before = db.prepare('SELECT COUNT(*) AS n FROM trainings').get().n;
  tx(() => {
    db.prepare('DELETE FROM trainings').run();
    const ins = db.prepare('INSERT INTO trainings (no, company, job, dept, rank, name, kind, org, course, days, hours, schedule_raw, start_date, end_date, month, cost, result, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const r of rows) ins.run(r.no, r.company, r.job, r.dept, r.rank, r.name, r.kind, r.org, r.course, r.days, r.hours, r.schedule_raw, r.start_date, r.end_date, r.month, r.cost, r.result, r.note);
  });
  res.json({ imported: rows.length, replaced: before, warnings });
});

// 월별·인원별 정리본 엑셀 내려받기
app.get('/api/trainings/export', auth, async (_req, res) => {
  const rows = db.prepare('SELECT * FROM trainings ORDER BY id').all();
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

app.get('/api/training-mail/settings', auth, adminOnly, (_req, res) => {
  const people = db.prepare(TRAINEES_SQL).all();
  res.json({ ...getTrainingMailSettings(), subject: MAIL_SUBJECT, defaultIntro: DEFAULT_INTRO, defaultOutro: DEFAULT_OUTRO, leadChoices: LEAD_CHOICES, smtp: mailConfigured(), people: people.length, withEmail: people.filter((p) => p.email).length });
});
app.put('/api/training-mail/settings', auth, adminOnly, (req, res) => {
  res.json(saveTrainingMailSettings(req.body || {}));
});

app.get('/api/training-mail/emails', auth, adminOnly, (_req, res) => res.json(db.prepare(TRAINEES_SQL).all()));
app.put('/api/training-mail/emails', auth, adminOnly, (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const bad = [];
  tx(() => {
    for (const it of items) {
      const company = String(it.company || '');
      const name = String(it.name || '');
      const email = String(it.email || '').trim();
      if (!name) continue;
      if (!email) db.prepare('DELETE FROM trainee_emails WHERE company = ? AND name = ?').run(company, name);
      else if (!isEmail(email)) bad.push(`${name}: ${email}`);
      else db.prepare('INSERT INTO trainee_emails (company, name, email) VALUES (?, ?, ?) ON CONFLICT(company, name) DO UPDATE SET email = excluded.email').run(company, name, email);
    }
  });
  if (bad.length) throw httpError(400, `메일 주소 형식이 올바르지 않아 저장하지 못한 항목이 있습니다.\n${bad.join('\n')}`);
  res.json({ ok: true });
});

// 메일 주소 입력용 템플릿: 교육 대상자 전원이 미리 들어 있어 "메일주소" 열만 채워서 올리면 된다
app.get('/api/training-mail/emails/template', auth, adminOnly, async (_req, res) => {
  const people = db.prepare(TRAINEES_SQL).all();
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
  const people = db.prepare(TRAINEES_SQL).all();
  const byName = new Map();
  for (const p of people) byName.set(p.name, [...(byName.get(p.name) || []), p]);
  const result = { updated: 0, notFound: [], ambiguous: [], invalid: [] };
  tx(() => {
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
        db.prepare('INSERT INTO trainee_emails (company, name, email) VALUES (?, ?, ?) ON CONFLICT(company, name) DO UPDATE SET email = excluded.email').run(cands[0].company, cands[0].name, email);
        result.updated++;
      }
    }
  });
  res.json(result);
});

// 오늘 발송 대상 + 앞으로 예정된 발송 일정 미리보기
app.get('/api/training-mail/preview', auth, adminOnly, (_req, res) => {
  const s = getTrainingMailSettings();
  res.json({ smtp: mailConfigured(), enabled: s.enabled, sendTime: s.sendTime, due: dueToday(s), upcoming: upcomingSends(s).slice(0, 200) });
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

app.get('/api/training-mail/log', auth, adminOnly, (_req, res) => {
  res.json(
    db.prepare(`SELECT l.id, l.lead, l.email, l.ok, l.error, l.sent_at, t.name, t.course, t.start_date
      FROM training_mail_log l LEFT JOIN trainings t ON t.id = l.training_id ORDER BY l.id DESC LIMIT 150`).all(),
  );
});

// ---------- 오류 처리 ----------
app.use((err, _req, res, _next) => {
  if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '파일이 너무 큽니다. (첨부파일은 10MB, 엑셀 업로드는 5MB 이하)' });
  console.error(err);
  res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

app.listen(PORT, () => {
  console.log(`업무 캘린더 실행 중: http://localhost:${PORT}`);
  if (!mailConfigured()) console.log('※ SMTP가 설정되지 않아 알람 메일은 발송되지 않습니다. (앱 상단 알림은 정상 동작) .env 파일을 확인하세요.');
  startScheduler();
});
