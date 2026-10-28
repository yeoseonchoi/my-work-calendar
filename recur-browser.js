// 반복 일정 계산 (서버의 recur.js 를 브라우저용으로 옮긴 것). rrule 라이브러리(vendor/rrule/rrule.min.js)를 먼저 불러와야 한다.
(function () {
  const { RRule } = window.rrule;
  const DAY = 86400000;
  const WD = [RRule.SU, RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA];

  // 시간대 없는 '벽시계 시각' 문자열 <-> UTC 로 간주한 ms (rrule 은 UTC 기준으로 계산)
  function parse(s) {
    const m = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d))?/.exec(s);
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  }
  const fmtTime = (ms) => new Date(ms).toISOString().slice(0, 16);
  const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);
  const fmt = (ms, allDay) => (allDay ? fmtDate(ms) : fmtTime(ms));
  // 지금 이 기기의 '벽시계 시각' (일정과 직접 비교할 수 있다)
  const floatingNow = () => Date.now() - new Date().getTimezoneOffset() * 60000;

  function span(ev) {
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
        o.byweekday = (recur.weekdays && recur.weekdays.length ? recur.weekdays : [startDow]).map((d) => WD[d]);
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

  // 기간 [from, to) 에 걸치는 회차 목록. 반환: { key, ev(회차가 반영된 필드), startMs, endMs, isException }
  function expand(ev, from, to, exceptions) {
    exceptions = exceptions || [];
    const exMap = new Map(exceptions.map((x) => [x.occ, x]));
    const [s, e] = span(ev);
    const dur = e - s;
    const out = [];
    const push = (key, fields, isException) => {
      const merged = Object.assign({}, ev, fields);
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
      if (ex && ex.deleted) continue;
      const occStart = d.getTime();
      const fields = { start: fmt(occStart, ev.all_day), end: fmt(occStart + dur - (ev.all_day ? DAY : 0), ev.all_day) };
      if (ex && ex.override) {
        const ov = JSON.parse(ex.override);
        for (const k of OVERRIDABLE) if (k in ov) fields[k] = ov[k];
      }
      push(key, fields, !!(ex && ex.override));
    }
    return out;
  }

  window.Recur = { parse, fmt, fmtDate, fmtTime, span, expand, floatingNow, DAY };
})();
