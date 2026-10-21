import { db } from './db.js';
import { expand, floatingNow, DAY } from './recur.js';
import { sendMail } from './mailer.js';
import { pushNote, addHistory } from './notify.js';
import { trainingMailTick } from './training-mail.js';

const MIN = 60000;

// 종료 시각이 지난 진행 중 일정을 자동으로 "종료"(체크)로 바꾼다.
// 회차마다 한 번만 처리하므로, 사용자가 다시 진행 중으로 되돌리면 그대로 존중한다.
// 서버가 꺼져 있던 동안의 일정까지 따라잡되, 오래된 일정을 한꺼번에 바꾸지 않도록 최근 2일만 본다.
function autoComplete(now) {
  const mark = db.prepare('INSERT OR IGNORE INTO auto_done (event_id, occ) VALUES (?, ?)');
  const events = db.prepare("SELECT * FROM events WHERE status = 'active' OR recur IS NOT NULL").all();
  for (const ev of events) {
    const exceptions = db.prepare('SELECT * FROM exceptions WHERE event_id = ?').all(ev.id);
    for (const occ of expand(ev, now - 2 * DAY, now, exceptions)) {
      if (occ.endMs > now || occ.ev.status !== 'active') continue;
      if (mark.run(ev.id, occ.key).changes === 0) continue;
      if (ev.recur) {
        const row = exceptions.find((x) => x.occ === occ.key);
        const ov = { ...(row?.override ? JSON.parse(row.override) : {}), status: 'done' };
        db.prepare('INSERT INTO exceptions (event_id, occ, deleted, override) VALUES (?, ?, 0, ?) ON CONFLICT(event_id, occ) DO UPDATE SET override = excluded.override').run(ev.id, occ.key, JSON.stringify(ov));
      } else {
        db.prepare("UPDATE events SET status = 'done' WHERE id = ?").run(ev.id);
      }
      addHistory(ev.id, null, 'done', `자동 종료 (종료 시각이 지남)${ev.recur ? ' · ' + occ.key.replace('T', ' ') : ''}`);
    }
  }
}

async function tick() {
  const now = floatingNow();
  autoComplete(now);
  await trainingMailTick(now).catch((err) => console.error('교육 메일 스케줄러 오류:', err));
  const rows = db
    .prepare('SELECT a.id AS alarm_id, a.minutes, a.event_id FROM alarms a')
    .all();
  if (!rows.length) return;

  const byEvent = new Map();
  for (const r of rows) {
    if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, []);
    byEvent.get(r.event_id).push(r);
  }

  for (const [eventId, alarms] of byEvent) {
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!ev) continue;
    const exceptions = db.prepare('SELECT * FROM exceptions WHERE event_id = ?').all(eventId);
    const maxMin = Math.max(...alarms.map((a) => a.minutes));
    // 아직 시작 전이면서 알람 시각이 지난 회차만 대상 (종료·취소된 일정은 제외)
    const occs = expand(ev, now, now + maxMin * MIN + 1, exceptions).filter((o) => o.startMs >= now && o.ev.status === 'active');
    for (const occ of occs) {
      for (const a of alarms) {
        if (occ.startMs - a.minutes * MIN > now) continue;
        const ins = db.prepare('INSERT OR IGNORE INTO alarm_sent (alarm_id, occ) VALUES (?, ?)').run(a.alarm_id, occ.key);
        if (ins.changes === 0) continue;
        await notify(ev, occ, a.minutes);
      }
    }
  }
}

const leadText = (minutes) =>
  minutes === 0 ? '지금' : minutes >= 1440 && minutes % 1440 === 0 ? `${minutes / 1440}일 후` : minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}시간 후` : `${minutes}분 후`;

async function notify(ev, occ, minutes) {
  const owner = db.prepare('SELECT name, email FROM users WHERE id = ?').get(ev.owner_id);
  // 불참으로 응답한 참석자에게는 보내지 않는다
  const people = db
    .prepare("SELECT u.id, u.email FROM attendees t JOIN users u ON u.id = t.user_id WHERE t.event_id = ? AND t.response != 'no'")
    .all(ev.id);
  const assignee = ev.assignee_id ? db.prepare('SELECT id, email FROM users WHERE id = ?').get(ev.assignee_id) : null;
  const ownerRow = db.prepare('SELECT id, email FROM users WHERE id = ?').get(ev.owner_id);
  const targets = new Map([ownerRow, ...people, assignee].filter(Boolean).map((u) => [u.id, u.email]));

  const e = occ.ev;
  const when = e.all_day ? `${e.start} (종일)` : `${e.start.replace('T', ' ')} ~ ${e.end.replace('T', ' ')}`;
  const lead = leadText(minutes);
  const flag = (e.urgent ? '[긴급] ' : '') + (e.importance === 2 ? '[중요] ' : '');
  const subject = minutes === 0 ? `[일정 알림] ${flag}${e.title} 시작` : `[일정 알림] ${flag}${e.title} (${lead} 시작)`;
  const text = [
    minutes === 0 ? '[일정 알림] 일정이 시작됩니다.' : `[일정 알림] ${lead} 시작합니다.`,
    '',
    `제목: ${e.title}`,
    `일시: ${when}`,
    e.location ? `장소: ${e.location}` : null,
    `등록자: ${owner.name}`,
    e.memo ? `\n${e.memo}` : null,
  ]
    .filter((x) => x !== null)
    .join('\n');

  // 앱 상단 알림 (SMTP 설정과 무관하게 동작)
  pushNote([...targets.keys()], {
    type: 'reminder', event_id: ev.id, ref_start: e.start,
    title: `[시작 전 알림] ${flag}${e.title}`, body: `${lead} 시작 · ${when}${e.location ? ' · ' + e.location : ''}`,
  });

  for (const addr of new Set(targets.values())) {
    try {
      await sendMail(addr, subject, text);
    } catch (err) {
      console.error('메일 발송 실패:', addr, err.message);
    }
  }
}

export function startScheduler() {
  const run = () => tick().catch((err) => console.error('스케줄러 오류:', err));
  setInterval(run, 30 * 1000);
  run();
}
