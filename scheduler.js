// 주기 작업: 종료된 일정 자동 체크, 시작 전 알람(앱 알림 + 메일), 교육 참석 요청 메일
//  - Vercel 배포: /api/cron/tick 을 5분마다 호출해 runScheduledJobs() 를 실행한다 (서버가 상시 떠 있지 않음)
//  - 로컬 실행(npm start): startScheduler() 가 30초마다 같은 함수를 실행한다
import { db } from './db.js';
import { expand, floatingNow, DAY } from './recur.js';
import { sendMail } from './mailer.js';
import { pushNote, addHistory } from './notify.js';
import { trainingMailTick } from './training-mail.js';
import { expirationTick } from './expirations.js';

const MIN = 60000;

const groupBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[key])) m.set(r[key], []);
    m.get(r[key]).push(r);
  }
  return m;
};

// 종료 시각이 지난 진행 중 일정을 자동으로 "종료"(체크)로 바꾼다.
// 회차마다 한 번만 처리하므로, 사용자가 다시 진행 중으로 되돌리면 그대로 존중한다.
// 오래 멈춰 있던 뒤에도 따라잡되, 오래된 일정을 한꺼번에 바꾸지 않도록 최근 2일만 본다.
async function autoComplete(now) {
  const [events, allExceptions] = await Promise.all([
    db.prepare("SELECT * FROM events WHERE status = 'active' OR recur IS NOT NULL").all(),
    db.prepare('SELECT * FROM exceptions').all(),
  ]);
  const exByEvent = groupBy(allExceptions, 'event_id');
  const mark = db.prepare('INSERT OR IGNORE INTO auto_done (event_id, occ) VALUES (?, ?)');
  let count = 0;
  for (const ev of events) {
    const exceptions = exByEvent.get(ev.id) || [];
    for (const occ of expand(ev, now - 2 * DAY, now, exceptions)) {
      if (occ.endMs > now || occ.ev.status !== 'active') continue;
      if ((await mark.run(ev.id, occ.key)).changes === 0) continue;
      if (ev.recur) {
        const row = exceptions.find((x) => x.occ === occ.key);
        const ov = { ...(row?.override ? JSON.parse(row.override) : {}), status: 'done' };
        await db.prepare('INSERT INTO exceptions (event_id, occ, deleted, override) VALUES (?, ?, 0, ?) ON CONFLICT(event_id, occ) DO UPDATE SET override = excluded.override').run(ev.id, occ.key, JSON.stringify(ov));
      } else {
        await db.prepare("UPDATE events SET status = 'done' WHERE id = ?").run(ev.id);
      }
      await addHistory(ev.id, null, 'done', `자동 종료 (종료 시각이 지남)${ev.recur ? ' · ' + occ.key.replace('T', ' ') : ''}`);
      count++;
    }
  }
  return count;
}

// 시작 전 알람: 알람 시각이 지났고 아직 시작 전인 회차에 대해 한 번만 보낸다
async function sendAlarms(now) {
  const rows = await db.prepare('SELECT a.id AS alarm_id, a.minutes, a.event_id FROM alarms a').all();
  if (!rows.length) return 0;
  const byEvent = groupBy(rows, 'event_id');
  const [events, allExceptions] = await Promise.all([db.prepare('SELECT * FROM events').all(), db.prepare('SELECT * FROM exceptions').all()]);
  const evMap = new Map(events.map((e) => [e.id, e]));
  const exByEvent = groupBy(allExceptions, 'event_id');
  let sent = 0;
  for (const [eventId, alarms] of byEvent) {
    const ev = evMap.get(eventId);
    if (!ev) continue;
    const maxMin = Math.max(...alarms.map((a) => a.minutes));
    // 아직 시작 전이면서 알람 시각이 지난 회차만 대상 (종료·취소된 일정은 제외)
    const occs = expand(ev, now, now + maxMin * MIN + 1, exByEvent.get(eventId) || []).filter((o) => o.startMs >= now && o.ev.status === 'active');
    for (const occ of occs) {
      for (const a of alarms) {
        if (occ.startMs - a.minutes * MIN > now) continue;
        const ins = await db.prepare('INSERT OR IGNORE INTO alarm_sent (alarm_id, occ) VALUES (?, ?)').run(a.alarm_id, occ.key);
        if (ins.changes === 0) continue;
        await notify(ev, occ, a.minutes);
        sent++;
      }
    }
  }
  return sent;
}

const leadText = (minutes) =>
  minutes === 0 ? '지금' : minutes >= 1440 && minutes % 1440 === 0 ? `${minutes / 1440}일 후` : minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}시간 후` : `${minutes}분 후`;

async function notify(ev, occ, minutes) {
  const owner = await db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(ev.owner_id);
  // 불참으로 응답한 참석자에게는 보내지 않는다
  const people = await db
    .prepare("SELECT u.id, u.email FROM attendees t JOIN users u ON u.id = t.user_id WHERE t.event_id = ? AND t.response != 'no'")
    .all(ev.id);
  const assignee = ev.assignee_id ? await db.prepare('SELECT id, email FROM users WHERE id = ?').get(ev.assignee_id) : null;
  const targets = new Map([owner, ...people, assignee].filter(Boolean).map((u) => [u.id, u.email]));

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
  await pushNote([...targets.keys()], {
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

/** 주기 작업 한 번 실행. 각 작업은 서로 독립적이라 하나가 실패해도 나머지는 계속한다. */
export async function runScheduledJobs() {
  const now = floatingNow();
  const result = { at: new Date(now).toISOString().slice(0, 16), autoDone: 0, alarms: 0, errors: [] };
  const step = async (name, fn) => {
    try {
      return await fn();
    } catch (err) {
      console.error(`[${name}] 오류:`, err);
      result.errors.push(`${name}: ${err.message}`);
      return 0;
    }
  };
  result.autoDone = await step('자동 종료', () => autoComplete(now));
  await step('교육 메일', () => trainingMailTick(now));
  await step('만료일 알림', () => expirationTick(now));
  result.alarms = await step('시작 전 알람', () => sendAlarms(now));
  return result;
}

/** 로컬 실행 전용: 서버가 계속 켜져 있을 때 30초마다 주기 작업을 실행한다 */
export function startScheduler() {
  const run = () => runScheduledJobs().catch((err) => console.error('스케줄러 오류:', err));
  setInterval(run, 30 * 1000);
  run();
}
