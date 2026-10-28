// 만료일 관리: 계약·보험·점검처럼 기한이 있는 항목의 만료 전 알림 (앱 상단 알림 + 메일)
import { db } from './db.js';
import { sendMail } from './mailer.js';
import { pushNote } from './notify.js';
import { floatingNow, fmtDate, parse, DAY } from './recur.js';

export const DEFAULT_ALERT_DAYS = [60, 30, 7];

export const parseAlertDays = (s) =>
  [...new Set(String(s ?? '').split(',').map((x) => x.trim()).filter((x) => x !== '').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 365))].sort((a, b) => b - a);

const dday = (days) => (days === 0 ? '오늘 만료' : days > 0 ? `D-${days}` : `D+${-days}`);

/**
 * 만료일이 가까운 항목에 알림을 한 번씩 보낸다.
 * 알림 일수(예: 60,30,7) 중 지금 해당하는 가장 가까운 단계로 1회만 보내고, 서버가 꺼져 있던 날은 다음 실행 때 따라잡는다.
 * 만료일을 갱신(날짜 변경)하면 발송 기록의 만료일이 달라져 다시 알림이 간다.
 */
export async function expirationTick(now = floatingNow()) {
  const today = parse(fmtDate(now));
  const items = await db.prepare('SELECT * FROM expirations').all();
  if (!items.length) return 0;
  const sent = await db.prepare('SELECT exp_id, lead, expire_date FROM expiration_alerts').all();
  const sentKey = new Set(sent.map((s) => `${s.exp_id}|${s.lead}|${s.expire_date}`));
  let count = 0;
  for (const it of items) {
    const days = Math.round((parse(it.expire_date) - today) / DAY);
    if (days < 0) continue; // 이미 지난 항목은 화면에서 "만료됨"으로만 보여 준다
    const leads = parseAlertDays(it.alert_days);
    const lead = [...leads].reverse().find((l) => days <= l); // 해당하는 가장 가까운 단계
    if (lead === undefined) continue;
    if (sentKey.has(`${it.id}|${lead}|${it.expire_date}`)) continue;
    // 더 먼 단계는 이미 지난 것으로 보고 함께 기록해 한꺼번에 여러 번 보내지 않는다
    for (const l of leads.filter((x) => x >= lead)) {
      await db.prepare('INSERT OR IGNORE INTO expiration_alerts (exp_id, lead, expire_date) VALUES (?, ?, ?)').run(it.id, l, it.expire_date);
    }
    await notifyExpiry(it, days);
    count++;
  }
  return count;
}

async function notifyExpiry(it, days) {
  // 받는 사람: 등록한 사람 + 관리자
  const admins = await db.prepare("SELECT id, email FROM users WHERE role = 'admin'").all();
  const creator = it.created_by ? await db.prepare('SELECT id, email FROM users WHERE id = ?').get(it.created_by) : null;
  const targets = new Map([...admins, creator].filter(Boolean).map((u) => [u.id, u.email]));
  const label = `${it.category ? `[${it.category}] ` : ''}${it.name}`;
  await pushNote([...targets.keys()], {
    type: 'expiry', title: `[만료 알림] ${label} ${dday(days)}`,
    body: `만료일 ${it.expire_date}${it.owner ? ' · 담당 ' + it.owner : ''}${it.memo ? ' · ' + it.memo : ''}`,
  });
  const text = [`[만료 알림] ${label}`, '', `만료일: ${it.expire_date} (${dday(days)})`, it.owner ? `담당: ${it.owner}` : null, it.memo ? `\n${it.memo}` : null]
    .filter((x) => x !== null)
    .join('\n');
  for (const addr of new Set(targets.values())) {
    try {
      await sendMail(addr, `[만료 알림] ${label} ${dday(days)}`, text);
    } catch (err) {
      console.error('만료 알림 메일 발송 실패:', addr, err.message);
    }
  }
}
