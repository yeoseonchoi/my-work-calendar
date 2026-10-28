// rrule 은 CommonJS 패키지라 기본 가져오기로 받는다. (createRequire 방식은 Vercel 의 파일 수집에서 빠질 수 있다)
import rrulePkg from 'rrule';
const { RRule } = rrulePkg;

const DAY = 86400000;
const WD = [RRule.SU, RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA];

// 타임존 없는 로컬 시각 문자열 <-> UTC로 간주한 Date (rrule은 UTC 기준으로 계산)
export function parse(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d))?/.exec(s);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
}
export const fmtTime = (ms) => new Date(ms).toISOString().slice(0, 16);
export const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);
export const fmt = (ms, allDay) => (allDay ? fmtDate(ms) : fmtTime(ms));

// 서버가 어느 시간대에서 돌든(Vercel 은 UTC) 같은 결과가 나오도록, 사용자 시간대(기본 한국 UTC+9)를 직접 더한다.
// 일정은 시간대 없는 '벽시계 시각'으로 저장되므로 이 값과 직접 비교한다. 다른 나라에서 쓰려면 APP_TZ_OFFSET_MIN(분) 환경변수로 바꾼다.
const TZ_OFFSET_MIN = Number.isFinite(Number(process.env.APP_TZ_OFFSET_MIN)) && process.env.APP_TZ_OFFSET_MIN !== '' ? Number(process.env.APP_TZ_OFFSET_MIN) : 540;
export function floatingNow() {
  return Date.now() + TZ_OFFSET_MIN * 60000;
}

// 이벤트(또는 회차 덮어쓴 값)의 시작/끝 (끝은 배타적, ms)
export function span(ev) {
  const s = parse(ev.start);
  const e = ev.all_day ? parse(ev.end) + DAY : parse(ev.end);
  return [s, Math.max(e, s + (ev.all_day ? DAY : 0))];
}

function buildRule(ev, recur) {
  const dtstart = new Date(parse(ev.start));
  const o = { dtstart, interval: Math.max(1, +recur.interval || 1) };
  const startDow = dtstart.getUTCDay();
  switch (recur.freq) {
    case 'daily':
      o.freq = RRule.DAILY;
      break;
    case 'weekly':
      o.freq = RRule.WEEKLY;
      o.byweekday = (recur.weekdays?.length ? recur.weekdays : [startDow]).map((d) => WD[d]);
      break;
    case 'monthly':
      o.freq = RRule.MONTHLY;
      if (recur.monthlyMode === 'nth') {
        const n = Math.ceil(dtstart.getUTCDate() / 7);
        o.byweekday = [WD[startDow].nth(n > 4 ? -1 : n)];
      } else {
        o.bymonthday = [dtstart.getUTCDate()];
      }
      break;
    case 'yearly':
      o.freq = RRule.YEARLY;
      break;
    default:
      return null;
  }
  if (recur.endType === 'until' && recur.until) o.until = new Date(parse(recur.until) + DAY - 1);
  else if (recur.endType === 'count' && recur.count) o.count = Math.max(1, +recur.count);
  return new RRule(o);
}

const OVERRIDABLE = ['title', 'start', 'end', 'all_day', 'location', 'memo', 'category', 'status', 'urgent', 'importance'];

/**
 * 기간 [from, to) 에 걸치는 회차 목록.
 * 반환: { key, ev(회차가 반영된 필드), startMs, endMs, isException }
 */
export function expand(ev, from, to, exceptions = []) {
  const exMap = new Map(exceptions.map((x) => [x.occ, x]));
  const [s, e] = span(ev);
  const dur = e - s;
  const out = [];
  const push = (key, fields, isException) => {
    const merged = { ...ev, ...fields };
    const [ms, me] = span(merged);
    if (ms < to && me > from) out.push({ key, ev: merged, startMs: ms, endMs: me, isException });
  };

  const recur = ev.recur ? JSON.parse(ev.recur) : null;
  const rule = recur && buildRule(ev, recur);
  if (!rule) {
    push(fmt(s, ev.all_day), {}, false);
    return out;
  }
  // 이동된 회차를 놓치지 않도록 앞뒤로 여유를 둔다
  const dates = rule.between(new Date(from - dur - 31 * DAY), new Date(to + 31 * DAY), true);
  for (const d of dates) {
    const key = fmt(d.getTime(), ev.all_day);
    const ex = exMap.get(key);
    if (ex?.deleted) continue;
    const occStart = d.getTime();
    const fields = { start: fmt(occStart, ev.all_day), end: fmt(occStart + dur - (ev.all_day ? DAY : 0), ev.all_day) };
    if (ex?.override) {
      const ov = JSON.parse(ex.override);
      for (const k of OVERRIDABLE) if (k in ov) fields[k] = ov[k];
    }
    push(key, fields, !!ex?.override);
  }
  return out;
}

export { DAY };
