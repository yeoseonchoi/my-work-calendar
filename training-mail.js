import { db } from './db.js';
import { sendMail, mailConfigured } from './mailer.js';
import { floatingNow, fmtDate, parse, DAY } from './recur.js';

// ───────── 설정 ─────────
export const LEAD_CHOICES = [30, 15, 14, 10, 7, 5, 3, 2, 1, 0]; // 화면에 보여줄 기본 선택지 (0 = 당일). 이 밖의 일수도 직접 입력할 수 있다.
// 메일 제목은 항상 이 문구로 고정한다
export const MAIL_SUBJECT = '교육참석요청의 건';
const OLD_INTRO = '안녕하세요, {{성명}}님.\n아래 교육이 예정되어 있어 참석을 요청드립니다.';
const OLD_OUTRO = '교육 참석이 어려운 경우 교육 담당 부서로 알려주시기 바랍니다.\n감사합니다.';
const PREV_INTRO = '안녕하세요, {{성명}}님.\n교육 담당 부서입니다.\n\n아래와 같이 교육이 예정되어 있으니 일정을 확인하시고 반드시 참석하시기 바랍니다. (총 {{교육건수}}건)';
export const DEFAULT_INTRO = '안녕하세요\n인사총무팀 입니다\n\n아래와 같이 교육이 예정되어 있으니 일정을 확인하시고 반드시 참석하시기 바랍니다. (총 {{교육건수}}건)';
export const DEFAULT_OUTRO = '※ 교육 참석은 필수입니다. 교육 일정에 맞추어 업무를 미리 조정하시고, 교육 시작 전에 장소와 준비물을 확인해 주시기 바랍니다.\n부득이하게 참석이 어려운 경우에는 교육 시작 전에 소속 부서장과 교육 담당 부서에 사전 연락하여 조치하시기 바랍니다.\n\n감사합니다.';
export const DEFAULTS = {
  enabled: false,
  sendTime: '09:00',
  leads: [30, 15, 7],
  cc: '',
  replyTo: '',
  intro: DEFAULT_INTRO,
  outro: DEFAULT_OUTRO,
  lastRun: '',
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (s) => EMAIL_RE.test(String(s || '').trim());

export async function getSettings() {
  const row = await db.prepare("SELECT value FROM app_settings WHERE key = 'training_mail'").get();
  let saved = {};
  try {
    saved = row ? JSON.parse(row.value) : {};
  } catch {
    saved = {};
  }
  const merged = { ...DEFAULTS, ...saved };
  delete merged.subject; // 제목은 고정
  if (merged.intro === OLD_INTRO || merged.intro === PREV_INTRO) merged.intro = DEFAULT_INTRO;
  if (merged.outro === OLD_OUTRO) merged.outro = DEFAULT_OUTRO;
  return merged;
}
async function writeSettings(s) {
  await db.prepare("INSERT INTO app_settings (key, value) VALUES ('training_mail', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(s));
}
export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur };
  delete next.subject;
  if ('enabled' in patch) next.enabled = !!patch.enabled;
  if ('sendTime' in patch) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.sendTime)) throw Object.assign(new Error('발송 시각 형식이 올바르지 않습니다. (예: 09:00)'), { status: 400 });
    next.sendTime = patch.sendTime;
  }
  if ('leads' in patch) {
    // 0~365일 사이의 정수라면 자유롭게 지정할 수 있다 (예: 30, 15, 7)
    const leads = [...new Set((patch.leads || []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 365))].sort((a, b) => b - a);
    if (leads.length > 12) throw Object.assign(new Error('발송 시점은 최대 12개까지 지정할 수 있습니다.'), { status: 400 });
    next.leads = leads;
  }
  for (const k of ['cc', 'replyTo']) if (k in patch) next[k] = String(patch[k] || '').trim().slice(0, 300);
  for (const k of ['intro', 'outro']) if (k in patch) next[k] = String(patch[k] ?? '').slice(0, 2000);
  for (const addr of [...String(next.cc).split(/[,;\s]+/), next.replyTo].filter(Boolean)) {
    if (!isEmail(addr)) throw Object.assign(new Error(`메일 주소 형식이 올바르지 않습니다: ${addr}`), { status: 400 });
  }
  await writeSettings(next);
  return next;
}
export async function markRun(day) {
  const s = await getSettings();
  await writeSettings({ ...s, lastRun: day });
}

// ───────── 대상 계산 ─────────
const emailMap = async () => new Map((await db.prepare('SELECT company, name, email FROM trainee_emails').all()).map((e) => [`${e.company}|${e.name}`, e.email]));

const dayName = '일월화수목금토';
function dateRange(t) {
  const fmtMD = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}(${dayName[new Date(parse(d)).getUTCDay()]})`;
  if (!t.start_date) return t.schedule_raw || '일정 미정';
  return t.end_date && t.end_date !== t.start_date ? `${fmtMD(t.start_date)} ~ ${fmtMD(t.end_date)}` : fmtMD(t.start_date);
}

/**
 * 오늘 보내야 할 메일 대상: 교육 시작일이 (오늘 + lead일) 인 건, 실적이 비어 있는 건(이수·취소·퇴사 등 제외),
 * 같은 (교육, lead) 로 이미 성공 발송한 건은 제외. 사람별로 한 통에 묶는다.
 */
export async function dueToday(settings, today = fmtDate(floatingNow())) {
  settings ??= await getSettings();
  const todayMs = parse(today);
  const emails = await emailMap();
  const sent = db.prepare('SELECT 1 FROM training_mail_log WHERE training_id = ? AND lead = ? AND ok = 1');
  const rows = await db.prepare("SELECT * FROM trainings WHERE start_date IS NOT NULL AND result = '' ORDER BY start_date, name").all();
  const byPerson = new Map();
  for (const t of rows) {
    const days = Math.round((parse(t.start_date) - todayMs) / DAY);
    if (!settings.leads.includes(days)) continue;
    if (await sent.get(t.id, days)) continue;
    const key = `${t.company}|${t.name}`;
    if (!byPerson.has(key)) byPerson.set(key, { company: t.company, dept: t.dept, rank: t.rank, name: t.name, email: emails.get(key) || '', items: [] });
    byPerson.get(key).items.push({ id: t.id, lead: days, course: t.course, kind: t.kind, org: t.org, hours: t.hours, when: dateRange(t), start: t.start_date });
  }
  return [...byPerson.values()];
}

/** 앞으로 예정된 발송 일정 (교육 시작일 - lead). 미리보기용 */
export async function upcomingSends(settings, today = fmtDate(floatingNow()), horizonDays = 45) {
  settings ??= await getSettings();
  const todayMs = parse(today);
  const emails = await emailMap();
  const out = [];
  const rows = await db.prepare("SELECT * FROM trainings WHERE start_date IS NOT NULL AND result = '' ORDER BY start_date, name").all();
  for (const t of rows) {
    for (const lead of settings.leads) {
      const sendMs = parse(t.start_date) - lead * DAY;
      const off = Math.round((sendMs - todayMs) / DAY);
      if (off < 0 || off > horizonDays) continue;
      out.push({ date: fmtDate(sendMs), lead, name: t.name, dept: t.dept, course: t.course, when: dateRange(t), email: emails.get(`${t.company}|${t.name}`) || '' });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'ko'));
}

// ───────── 메일 만들기 ─────────
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fill = (tpl, vars) => String(tpl).replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));
const leadWord = (n) => (n === 0 ? '오늘' : n === 1 ? '내일' : `D-${n}`);

export function renderMail(person, settings) {
  const leads = [...new Set(person.items.map((i) => i.lead))];
  const vars = { 성명: person.name, 교육건수: person.items.length, D: leads.length === 1 ? (leads[0] === 0 ? '오늘 교육' : leads[0] === 1 ? '내일 교육' : `교육 ${leadWord(leads[0])}`) : '교육 일정 안내', 소속: person.company, 부서: person.dept };
  const subject = MAIL_SUBJECT;
  const intro = fill(settings.intro, vars);
  const outro = fill(settings.outro, vars);
  const text = [
    intro, '',
    ...person.items.map((i) => `• [${leadWord(i.lead)}] ${i.course}\n   일정: ${i.when}${i.org ? ` / 교육기관: ${i.org}` : ''}${i.hours ? ` / ${i.hours}시간` : ''}${i.kind ? ` / ${i.kind}교육` : ''}`),
    '', outro,
  ].join('\n');
  const html = `<div style="font-family:'Malgun Gothic',Arial,sans-serif;font-size:14px;color:#222;line-height:1.6">
<p>${esc(intro).replace(/\n/g, '<br>')}</p>
<table style="border-collapse:collapse;width:100%;max-width:640px;font-size:13px">
<tr style="background:#eef2fb"><th style="padding:7px 9px;text-align:left;border:1px solid #d5dcee">시점</th><th style="padding:7px 9px;text-align:left;border:1px solid #d5dcee">교육과목</th><th style="padding:7px 9px;text-align:left;border:1px solid #d5dcee">일정</th><th style="padding:7px 9px;text-align:left;border:1px solid #d5dcee">교육기관</th><th style="padding:7px 9px;text-align:left;border:1px solid #d5dcee">시간</th></tr>
${person.items.map((i) => `<tr><td style="padding:7px 9px;border:1px solid #d5dcee">${esc(leadWord(i.lead))}</td><td style="padding:7px 9px;border:1px solid #d5dcee"><b>${esc(i.course)}</b>${i.kind ? ` <span style="color:#667">(${esc(i.kind)})</span>` : ''}</td><td style="padding:7px 9px;border:1px solid #d5dcee">${esc(i.when)}</td><td style="padding:7px 9px;border:1px solid #d5dcee">${esc(i.org)}</td><td style="padding:7px 9px;border:1px solid #d5dcee">${i.hours ? i.hours + 'h' : ''}</td></tr>`).join('\n')}
</table>
<p>${esc(outro).replace(/\n/g, '<br>')}</p></div>`;
  return { subject, text, html };
}

// ───────── 발송 ─────────
/** 오늘 대상에게 메일 발송. 이메일이 없는 사람은 건너뛰고 목록으로 알려준다. */
export async function runDue({ settings: given, today = fmtDate(floatingNow()) } = {}) {
  const settings = given ?? (await getSettings());
  if (!mailConfigured()) return { error: 'smtp', sent: 0, items: 0, failed: 0, noEmail: [] };
  const due = await dueToday(settings, today);
  const log = db.prepare('INSERT INTO training_mail_log (training_id, lead, email, ok, error) VALUES (?, ?, ?, ?, ?)');
  let sent = 0;
  let items = 0;
  let failed = 0;
  const noEmail = [];
  for (const p of due) {
    if (!p.email) {
      noEmail.push(p.name);
      continue;
    }
    const { subject, text, html } = renderMail(p, settings);
    try {
      await sendMail(p.email, subject, text, { html, cc: settings.cc, replyTo: settings.replyTo });
      for (const it of p.items) await log.run(it.id, it.lead, p.email, 1, '');
      sent++;
      items += p.items.length;
    } catch (err) {
      for (const it of p.items) await log.run(it.id, it.lead, p.email, 0, String(err.message).slice(0, 300));
      failed++;
      console.error('교육 메일 발송 실패:', p.email, err.message);
    }
  }
  return { sent, items, failed, noEmail };
}

/** 스케줄러가 주기적으로 호출: 설정한 시각이 지났고 오늘 아직 안 보냈으면 한 번 발송 */
export async function trainingMailTick(now = floatingNow()) {
  const s = await getSettings();
  if (!s.enabled) return;
  const today = fmtDate(now);
  if (s.lastRun === today) return;
  if (new Date(now).toISOString().slice(11, 16) < s.sendTime) return;
  if (!mailConfigured()) return; // SMTP 설정 후 같은 날 다시 시도된다
  const r = await runDue({ settings: s, today });
  await markRun(today);
  if (r.sent || r.failed || r.noEmail.length) console.log(`[교육 메일] 발송 ${r.sent}명(${r.items}건), 실패 ${r.failed}, 메일 미등록 ${r.noEmail.length}`);
}

export async function sendTestMail(to, given) {
  const settings = given ?? (await getSettings());
  const sample = {
    name: '홍길동', company: '대신금속', dept: '교육 담당', rank: '', email: to,
    items: [{ id: 0, lead: 7, course: '(예시) 제조현장 원가절감 및 개선 실무', kind: '원가', org: '한국품질재단', hours: 14, when: '12/10(수) ~ 12/11(목)', start: '' }],
  };
  const { subject, text, html } = renderMail(sample, settings);
  return await sendMail(to, `[테스트] ${subject}`, text, { html });
}
