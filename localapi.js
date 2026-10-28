// 서버 없는 버전의 "브라우저 안의 서버".
// 화면(app.js)이 보내는 /api/... 요청을 이 파일이 받아서 브라우저의 데이터(localStorage)로 처리한다.
// GitHub 연결을 켜면 같은 데이터를 저장소의 JSON 파일에도 저장해 기기 간에 맞춘다.
(function () {
  const R = window.Recur;
  const DAY = R.DAY;
  const KEY = 'wc_data_v1';
  const CATEGORIES = ['회의', '외근', '출장', '휴가', '교육', '기타'];
  const ME = { id: 1, color: '#7a6cf0', email: '', role: 'admin', site: '', dept: '', position: '' };

  const httpError = (status, message) => Object.assign(new Error(message), { status });
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const nowStamp = () => new Date().toISOString().slice(0, 19).replace('T', ' '); // 서버와 같은 UTC 형식

  // ───────── 데이터 ─────────
  const emptyDb = () => ({
    v: 1, updatedAt: '', name: '', seq: { event: 0, comment: 0, history: 0, notif: 0, exp: 0, tpl: 0 },
    events: [], exceptions: [], comments: [], history: [], notifications: [], autoDone: {}, alarmSent: {},
    expirations: [], expAlerts: {}, templates: [],
  });
  const normalize = (d) => {
    const base = emptyDb();
    const out = Object.assign(base, d || {});
    out.seq = Object.assign(base.seq, (d && d.seq) || {});
    return out;
  };
  function loadLocal() {
    try {
      const s = localStorage.getItem(KEY);
      if (s) return normalize(JSON.parse(s));
    } catch {
      // 깨진 데이터는 무시하고 새로 시작한다
    }
    return emptyDb();
  }
  let DB = loadLocal();
  let pending = false; // 아직 GitHub 에 올리지 못한 변경이 있는지

  function saveLocal() {
    try {
      localStorage.setItem(KEY, JSON.stringify(DB));
    } catch (e) {
      if (window.toast) window.toast('이 브라우저에 데이터를 저장하지 못했습니다. (저장 공간이 없거나 시크릿 모드)', true);
    }
  }
  function save() {
    DB.updatedAt = new Date().toISOString();
    saveLocal();
    pending = true;
    schedulePush();
  }
  const nextId = (k) => ++DB.seq[k];

  // ───────── GitHub 동기화 ─────────
  const sync = { status: 'off', message: '', at: '', sha: null, remoteUpdatedAt: '' };
  const listeners = new Set();
  const setStatus = (status, message) => {
    sync.status = status;
    sync.message = message || '';
    if (status === 'ok') sync.at = new Date().toISOString();
    listeners.forEach((f) => f(sync));
  };
  let pushTimer = null;
  const schedulePush = () => {
    if (!window.GhSync.isOn()) return;
    clearTimeout(pushTimer);
    setStatus('pending', '저장 대기 중…');
    pushTimer = setTimeout(() => doPush(), 2500);
  };

  async function adoptRemote(remote, sha) {
    DB = normalize(remote);
    sync.sha = sha;
    sync.remoteUpdatedAt = DB.updatedAt;
    saveLocal();
    pending = false;
  }

  async function doPush(force) {
    if (!window.GhSync.isOn()) return;
    clearTimeout(pushTimer);
    setStatus('syncing', '저장하는 중…');
    try {
      sync.sha = await window.GhSync.push(DB, sync.sha);
      sync.remoteUpdatedAt = DB.updatedAt;
      pending = false;
      setStatus('ok', '저장됨');
    } catch (e) {
      if ((e.status === 409 || e.status === 422) && !force) {
        // 다른 기기가 먼저 저장해서 파일 버전이 달라진 경우
        try {
          const r = await window.GhSync.pull();
          if (r.found && r.data.updatedAt === sync.remoteUpdatedAt) {
            sync.sha = r.sha; // 내용은 같고 버전 표시만 달랐다
            return doPush(true);
          }
          const overwrite = confirm('다른 기기에서 먼저 저장된 데이터가 있습니다.\n\n[확인] 이 기기의 내용으로 덮어쓰기\n[취소] 다른 기기의 내용을 불러오기 (이 기기의 최근 변경은 사라집니다)');
          if (overwrite) {
            sync.sha = r.sha;
            return doPush(true);
          }
          await adoptRemote(r.data, r.sha);
          setStatus('ok', '다른 기기의 내용을 불러왔습니다');
          if (window.refresh) window.refresh();
          return;
        } catch (e2) {
          setStatus('error', e2.message);
          return;
        }
      }
      setStatus('error', e.message);
    }
  }

  // 시작할 때 / 주기적으로 저장소의 데이터와 맞춘다. 반환: 화면을 다시 그려야 하는지
  const meaningful = (d) => !!(d.events.length || d.expirations.length || d.templates.length);
  async function pullAndMerge(opts) {
    opts = opts || {};
    if (!window.GhSync.isOn()) return false;
    setStatus('syncing', '불러오는 중…');
    try {
      const r = await window.GhSync.pull();
      if (!r.found) {
        sync.sha = null;
        await doPush(); // 저장소에 아직 파일이 없으면 지금 데이터로 만든다
        return false;
      }
      sync.sha = r.sha;
      const remote = normalize(r.data);
      // 이 기기의 데이터가 비어 있으면 저장소의 내용을 따른다 (새 기기가 기존 데이터를 빈 데이터로 덮어쓰는 사고 방지)
      if (!meaningful(DB) && meaningful(remote)) {
        await adoptRemote(r.data, r.sha);
        setStatus('ok', '저장소의 데이터를 불러왔습니다');
        return true;
      }
      // 처음 연결하는데 양쪽에 모두 데이터가 있으면 어느 쪽을 쓸지 직접 고르게 한다
      if (opts.firstLink && meaningful(DB) && meaningful(remote) && remote.updatedAt !== DB.updatedAt) {
        const useRemote = confirm('이 기기와 GitHub 저장소에 모두 데이터가 있습니다.\n\n[확인] 저장소의 데이터를 불러오기 (이 기기의 내용은 사라집니다)\n[취소] 이 기기의 데이터로 저장소를 덮어쓰기');
        if (useRemote) {
          await adoptRemote(r.data, r.sha);
          setStatus('ok', '저장소의 데이터를 불러왔습니다');
          return true;
        }
        pending = true;
        await doPush(true);
        return false;
      }
      const remoteNewer = (r.data.updatedAt || '') > (DB.updatedAt || '');
      const localNewer = (DB.updatedAt || '') > (r.data.updatedAt || '');
      if (remoteNewer && !pending) {
        await adoptRemote(r.data, r.sha);
        setStatus('ok', '불러옴');
        return true;
      }
      if (localNewer || pending) {
        sync.remoteUpdatedAt = r.data.updatedAt || '';
        await doPush();
        return false;
      }
      sync.remoteUpdatedAt = r.data.updatedAt || '';
      setStatus('ok', '최신 상태');
      return false;
    } catch (e) {
      setStatus('error', e.message);
      return false;
    }
  }

  // ───────── 일정 보조 ─────────
  const masterKey = (ev) => R.fmt(R.parse(ev.start), ev.all_day);
  const exOf = (id) => DB.exceptions.filter((x) => x.event_id === id);
  function occurrenceValues(ev, occ) {
    const s = R.parse(occ);
    const o = R.expand(ev, s, s + 1, exOf(ev.id)).find((x) => x.key === occ);
    return o ? o.ev : ev;
  }
  const whenText = (e) => (e.all_day ? `${e.start}${e.end !== e.start ? ' ~ ' + e.end : ''} (종일)` : `${e.start.replace('T', ' ')} ~ ${e.end.replace('T', ' ')}`);
  const IMPORTANCE = ['낮음', '보통', '높음'];
  const STATUS_WORD = { cancelled: '취소', done: '종료', active: '복원' };

  function addHistory(eventId, byMe, action, detail) {
    DB.history.push({ id: nextId('history'), event_id: eventId, by: byMe ? ME.id : null, action, detail: detail || '', created_at: nowStamp() });
  }
  function pushNote(n) {
    DB.notifications.push({ id: nextId('notif'), type: n.type, event_id: n.event_id || null, ref_start: n.ref_start || null, title: n.title, body: n.body || '', created_at: nowStamp(), read_at: null });
    try {
      if ('Notification' in window && Notification.permission === 'granted') new Notification(n.title, { body: n.body || '' });
    } catch {
      // 브라우저 알림이 막힌 환경에서는 앱 안 알림만 사용한다
    }
  }

  function clean(b) {
    const title = String(b.title || '').trim();
    if (!title) throw httpError(400, '제목을 입력하세요.');
    const all_day = b.all_day ? 1 : 0;
    const re = all_day ? /^\d{4}-\d\d-\d\d$/ : /^\d{4}-\d\d-\d\dT\d\d:\d\d$/;
    if (!re.test(b.start || '') || !re.test(b.end || '')) throw httpError(400, '날짜/시간 형식이 올바르지 않습니다.');
    if (R.parse(b.end) < R.parse(b.start)) throw httpError(400, '종료가 시작보다 빠를 수 없습니다.');
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
    return {
      title, start: b.start, end: b.end, all_day,
      location: String(b.location || '').trim(), memo: String(b.memo || ''),
      category: CATEGORIES.includes(b.category) ? b.category : '기타',
      urgent: b.urgent ? 1 : 0, importance: [0, 1, 2].includes(+b.importance) ? +b.importance : 1,
      recur, alarms: [...new Set((b.alarms || []).map(Number).filter((m) => m >= 0 && m <= 60 * 24 * 30))],
    };
  }

  function insertEvent(f) {
    const ev = {
      id: nextId('event'), title: f.title, start: f.start, end: f.end, all_day: f.all_day, location: f.location, memo: f.memo,
      category: f.category, urgent: f.urgent, importance: f.importance, kind: 'personal', visibility: 'me', edit_perm: 'owner',
      recur: f.recur ? JSON.stringify(f.recur) : null, status: 'active', alarms: f.alarms.slice().sort((a, b) => a - b), created_at: nowStamp(),
    };
    DB.events.push(ev);
    return ev;
  }
  const findEvent = (id) => {
    const ev = DB.events.find((e) => e.id === +id);
    if (!ev) throw httpError(404, '일정을 찾을 수 없습니다.');
    return ev;
  };

  function lastEditOf(id) {
    for (let i = DB.history.length - 1; i >= 0; i--) {
      const h = DB.history[i];
      if (h.event_id === id && h.by && ['created', 'updated', 'cancelled', 'done', 'restored'].includes(h.action)) return h;
    }
    return null;
  }

  function toEvent(ev, occ) {
    const e = occ.ev;
    const last = lastEditOf(ev.id);
    return {
      id: `${ev.id}|${occ.key}`,
      title: e.title, start: e.start,
      end: e.all_day ? R.fmtDate(occ.endMs) : R.fmtTime(occ.endMs),
      allDay: !!e.all_day, color: ME.color,
      extendedProps: {
        eventId: ev.id, occ: occ.key, ownerId: ME.id, ownerName: DB.name || '나', assigneeId: null, assigneeName: '',
        status: e.status || 'active', urgent: !!e.urgent, importance: e.importance == null ? 1 : e.importance,
        category: e.category, location: e.location, memo: e.memo, kind: 'personal', visibility: 'me', editPerm: 'owner',
        recur: ev.recur ? JSON.parse(ev.recur) : null, isException: occ.isException, rawStart: e.start, rawEnd: e.end,
        attendees: [], responses: {}, myResponse: null, alarms: ev.alarms.slice(), attachments: [],
        commentCount: DB.comments.filter((c) => c.event_id === ev.id).length,
        lastEditor: last ? DB.name || '나' : '', lastEditedAt: last ? last.created_at : '',
        canEdit: true, canManage: true,
      },
    };
  }

  function occurrences(from, to) {
    const out = [];
    for (const ev of DB.events) for (const occ of R.expand(ev, from, to, exOf(ev.id))) out.push({ ev, occ });
    return out;
  }
  const parseRange = (q) => [R.parse(String(q.get('start')).slice(0, 19)), R.parse(String(q.get('end')).slice(0, 19))];

  function diffEvent(old, f) {
    const out = [];
    const chg = (label, a, b) => a !== b && out.push(`${label}: ${a || '(없음)'} → ${b || '(없음)'}`);
    chg('제목', old.title, f.title);
    chg('시작', old.start.replace('T', ' '), f.start.replace('T', ' '));
    chg('종료', old.end.replace('T', ' '), f.end.replace('T', ' '));
    if (!!old.all_day !== !!f.all_day) out.push(`종일: ${old.all_day ? '예' : '아니오'} → ${f.all_day ? '예' : '아니오'}`);
    chg('장소', old.location, f.location);
    chg('분류', old.category, f.category);
    if (!!old.urgent !== !!f.urgent) out.push(`긴급: ${old.urgent ? '예' : '아니오'} → ${f.urgent ? '예' : '아니오'}`);
    chg('중요도', IMPORTANCE[old.importance == null ? 1 : old.importance], IMPORTANCE[f.importance]);
    if (old.memo !== f.memo) out.push('상세 내용 변경');
    return out;
  }

  function upsertException(eventId, occ, deleted, override) {
    const cur = DB.exceptions.find((x) => x.event_id === eventId && x.occ === occ);
    if (cur) {
      cur.deleted = deleted ? 1 : 0;
      cur.override = override ? JSON.stringify(override) : null;
    } else DB.exceptions.push({ event_id: eventId, occ, deleted: deleted ? 1 : 0, override: override ? JSON.stringify(override) : null });
  }
  function truncateSeries(ev, occ) {
    const recur = JSON.parse(ev.recur);
    recur.endType = 'until';
    recur.until = R.fmtDate(R.parse(occ) - DAY);
    recur.count = null;
    ev.recur = JSON.stringify(recur);
    DB.exceptions = DB.exceptions.filter((x) => !(x.event_id === ev.id && x.occ >= occ));
  }
  function removeEvent(id) {
    DB.events = DB.events.filter((e) => e.id !== id);
    DB.exceptions = DB.exceptions.filter((x) => x.event_id !== id);
    DB.comments = DB.comments.filter((c) => c.event_id !== id);
    DB.history = DB.history.filter((h) => h.event_id !== id);
    DB.notifications = DB.notifications.filter((n) => n.event_id !== id);
    for (const k of Object.keys(DB.autoDone)) if (k.startsWith(id + '|')) delete DB.autoDone[k];
    for (const k of Object.keys(DB.alarmSent)) if (k.startsWith(id + '|')) delete DB.alarmSent[k];
  }

  // ───────── 만료일 / 템플릿 ─────────
  const DEFAULT_ALERT_DAYS = [60, 30, 7];
  const parseAlertDays = (s) =>
    [...new Set(String(s == null ? '' : s).split(',').map((x) => x.trim()).filter((x) => x !== '').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 365))].sort((a, b) => b - a);
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
  function cleanTemplate(b) {
    const name = String(b.name || '').trim().slice(0, 40);
    if (!name) throw httpError(400, '템플릿 이름을 입력하세요.');
    const items = (Array.isArray(b.items) ? b.items : [])
      .map((i) => ({ title: String(i.title || '').trim().slice(0, 100), offset: Math.max(-365, Math.min(365, Math.round(+i.offset || 0))), urgent: !!i.urgent }))
      .filter((i) => i.title)
      .slice(0, 40);
    if (!items.length) throw httpError(400, '할 일을 한 개 이상 입력하세요.');
    return { name, items };
  }

  // ───────── 주기 작업 (페이지가 열려 있는 동안 30초마다) ─────────
  const leadText = (m) => (m === 0 ? '지금' : m >= 1440 && m % 1440 === 0 ? `${m / 1440}일 후` : m >= 60 && m % 60 === 0 ? `${m / 60}시간 후` : `${m}분 후`);
  const MIN = 60000;

  // 종료 시각이 지난 진행 중 일정을 자동으로 "종료"로 바꾼다 (회차마다 1회, 최근 2일만)
  function autoComplete(now) {
    let n = 0;
    for (const ev of DB.events.slice()) {
      if (ev.status !== 'active' && !ev.recur) continue;
      for (const occ of R.expand(ev, now - 2 * DAY, now, exOf(ev.id))) {
        if (occ.endMs > now || occ.ev.status !== 'active') continue;
        const k = `${ev.id}|${occ.key}`;
        if (DB.autoDone[k]) continue;
        DB.autoDone[k] = 1;
        if (ev.recur) {
          const row = DB.exceptions.find((x) => x.event_id === ev.id && x.occ === occ.key);
          const ov = Object.assign({}, row && row.override ? JSON.parse(row.override) : {}, { status: 'done' });
          upsertException(ev.id, occ.key, false, ov);
        } else ev.status = 'done';
        addHistory(ev.id, false, 'done', `자동 종료 (종료 시각이 지남)${ev.recur ? ' · ' + occ.key.replace('T', ' ') : ''}`);
        n++;
      }
    }
    return n;
  }

  // 시작 전 알람: 알람 시각이 지났고 아직 시작 전인 회차에 한 번만
  function sendAlarms(now) {
    let n = 0;
    for (const ev of DB.events) {
      if (!ev.alarms.length) continue;
      const maxMin = Math.max.apply(null, ev.alarms);
      const occs = R.expand(ev, now, now + maxMin * MIN + 1, exOf(ev.id)).filter((o) => o.startMs >= now && o.ev.status === 'active');
      for (const occ of occs) {
        for (const m of ev.alarms) {
          if (occ.startMs - m * MIN > now) continue;
          const k = `${ev.id}|${m}|${occ.key}`;
          if (DB.alarmSent[k]) continue;
          DB.alarmSent[k] = 1;
          const e = occ.ev;
          const flag = (e.urgent ? '[긴급] ' : '') + (e.importance === 2 ? '[중요] ' : '');
          pushNote({ type: 'reminder', event_id: ev.id, ref_start: e.start, title: `[시작 전 알림] ${flag}${e.title}`, body: `${leadText(m)} 시작 · ${whenText(e)}${e.location ? ' · ' + e.location : ''}` });
          n++;
        }
      }
    }
    return n;
  }

  // 만료일이 가까운 항목 알림: 해당하는 가장 가까운 단계로 1회만 (날짜를 갱신하면 다시 알림)
  function expirationTick(now) {
    const today = R.parse(R.fmtDate(now));
    let n = 0;
    for (const it of DB.expirations) {
      const days = Math.round((R.parse(it.expire_date) - today) / DAY);
      if (days < 0) continue;
      const leads = parseAlertDays(it.alert_days);
      const lead = leads.slice().reverse().find((l) => days <= l);
      if (lead === undefined) continue;
      if (DB.expAlerts[`${it.id}|${lead}|${it.expire_date}`]) continue;
      for (const l of leads.filter((x) => x >= lead)) DB.expAlerts[`${it.id}|${l}|${it.expire_date}`] = 1;
      const label = `${it.category ? `[${it.category}] ` : ''}${it.name}`;
      const dd = days === 0 ? '오늘 만료' : `D-${days}`;
      pushNote({ type: 'expiry', title: `[만료 알림] ${label} ${dd}`, body: `만료일 ${it.expire_date}${it.owner ? ' · 담당 ' + it.owner : ''}${it.memo ? ' · ' + it.memo : ''}` });
      n++;
    }
    return n;
  }

  function tick() {
    const now = R.floatingNow();
    const changed = autoComplete(now) + sendAlarms(now) + expirationTick(now);
    if (changed) save();
    return changed;
  }

  // ───────── 요청 처리 ─────────
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:id/g, '(\\d+)') + '$'), fn });

  route('GET', '/api/me', () => Object.assign({}, ME, { name: DB.name || '나', mailConfigured: false }));
  route('GET', '/api/users', () => [Object.assign({}, ME, { name: DB.name || '나' })]);
  route('PUT', '/api/me/profile', ({ body }) => {
    const name = String((body && body.name) || '').trim().slice(0, 30);
    if (name) {
      DB.name = name;
      save();
    }
    return { ok: true };
  });

  route('GET', '/api/events', ({ query }) => {
    if (!query.get('start') || !query.get('end')) throw httpError(400, 'start, end 필요');
    const [from, to] = parseRange(query);
    return occurrences(from, to).map(({ ev, occ }) => toEvent(ev, occ));
  });

  route('GET', '/api/search', ({ query }) => {
    const q = String(query.get('q') || '').trim().toLowerCase();
    const now = R.floatingNow();
    const from = /^\d{4}-\d\d-\d\d/.test(query.get('from') || '') ? R.parse(query.get('from')) : now - 30 * DAY;
    const to = /^\d{4}-\d\d-\d\d/.test(query.get('to') || '') ? R.parse(query.get('to')) + DAY : now + 180 * DAY;
    const category = CATEGORIES.includes(query.get('category')) ? query.get('category') : null;
    const status = ['active', 'done', 'cancelled'].includes(query.get('status')) ? query.get('status') : null;
    const urgentOnly = query.get('urgent') === '1';
    const importance = ['0', '1', '2'].includes(query.get('importance')) ? +query.get('importance') : null;
    const items = occurrences(from, to)
      .filter(({ occ }) => {
        const e = occ.ev;
        if (status && (e.status || 'active') !== status) return false;
        if (urgentOnly && !e.urgent) return false;
        if (importance !== null && e.importance !== importance) return false;
        if (category && e.category !== category) return false;
        if (q && ![e.title, e.location, e.memo].join('\n').toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => a.occ.startMs - b.occ.startMs);
    return { total: items.length, items: items.slice(0, 300).map(({ ev, occ }) => toEvent(ev, occ)) };
  });

  route('POST', '/api/events', ({ body }) => {
    const f = clean(body || {});
    const ev = insertEvent(f);
    addHistory(ev.id, true, 'created', `일정 등록: ${f.title} (${whenText(f)})`);
    save();
    return { id: ev.id };
  });

  route('PUT', '/api/events/:id', ({ params, body }) => {
    const ev = findEvent(params[0]);
    const f = clean(body || {});
    let scope = body.scope || 'all';
    const occ = body.occ || masterKey(ev);
    if (!ev.recur) scope = 'all';
    if (scope === 'future' && occ === masterKey(ev)) scope = 'all';
    const oldOcc = occurrenceValues(ev, occ);
    const changes = diffEvent(oldOcc, f);
    if (scope !== 'one' && (ev.recur || null) !== (f.recur ? JSON.stringify(f.recur) : null)) changes.push('반복 규칙 변경');
    let id = ev.id;
    if (scope === 'one') {
      const cur = DB.exceptions.find((x) => x.event_id === ev.id && x.occ === occ);
      const ov = { title: f.title, start: f.start, end: f.end, all_day: f.all_day, location: f.location, memo: f.memo, category: f.category, urgent: f.urgent, importance: f.importance };
      upsertException(ev.id, occ, false, Object.assign({}, cur && cur.override ? JSON.parse(cur.override) : {}, ov));
      ev.alarms = f.alarms.slice().sort((a, b) => a - b);
    } else if (scope === 'future') {
      truncateSeries(ev, occ);
      id = insertEvent(f).id;
    } else {
      let { start, end } = f;
      const oldStart = ev.start;
      if (ev.recur) {
        // 회차에서 바꾼 만큼 시리즈 전체를 이동
        const delta = R.parse(f.start) - R.parse(occ);
        const dur = R.span({ start: f.start, end: f.end, all_day: f.all_day });
        const s = R.parse(ev.start) + delta;
        start = R.fmt(s, f.all_day);
        end = R.fmt(s + (dur[1] - dur[0]) - (f.all_day ? DAY : 0), f.all_day);
      }
      Object.assign(ev, { title: f.title, start, end, all_day: f.all_day, location: f.location, memo: f.memo, category: f.category, urgent: f.urgent, importance: f.importance, recur: f.recur ? JSON.stringify(f.recur) : null, alarms: f.alarms.slice().sort((a, b) => a - b) });
      // 반복 일정의 시작 시각이 바뀌면 개별 회차 수정은 모두 초기화한다 (서버 버전과 동일)
      if (ev.recur && start !== oldStart) DB.exceptions = DB.exceptions.filter((x) => x.event_id !== ev.id);
    }
    const prefix = scope === 'one' ? `[이 일정만 · ${occ.replace('T', ' ')}] ` : scope === 'future' ? `[이후 일정 · ${occ.replace('T', ' ')}] ` : '';
    if (changes.length) addHistory(id, true, 'updated', prefix + changes.join('\n'));
    save();
    return { id };
  });

  route('POST', '/api/events/:id/status', ({ params, body }) => {
    const ev = findEvent(params[0]);
    const status = ['cancelled', 'done'].includes(body.status) ? body.status : 'active';
    let scope = body.scope === 'one' ? 'one' : 'all';
    const occ = body.occ || masterKey(ev);
    if (!ev.recur) scope = 'all';
    const cur = occurrenceValues(ev, occ);
    const word = status === 'active' ? (cur.status === 'done' ? '종료 해제' : '복원') : STATUS_WORD[status];
    if (scope === 'one') {
      const row = DB.exceptions.find((x) => x.event_id === ev.id && x.occ === occ);
      upsertException(ev.id, occ, false, Object.assign({}, row && row.override ? JSON.parse(row.override) : {}, { status }));
    } else {
      ev.status = status;
      // 개별 회차의 취소/복원 설정은 전체 설정을 따르도록 정리
      for (const x of DB.exceptions) {
        if (x.event_id !== ev.id || !x.override) continue;
        const ov = JSON.parse(x.override);
        if ('status' in ov) {
          delete ov.status;
          x.override = JSON.stringify(ov);
        }
      }
    }
    addHistory(ev.id, true, status === 'active' ? 'restored' : status, `${scope === 'one' ? `이 일정만 (${occ.replace('T', ' ')}) ` : ev.recur ? '모든 일정 ' : ''}${word}`);
    save();
    return { ok: true };
  });

  route('DELETE', '/api/events/:id', ({ params, query }) => {
    const ev = findEvent(params[0]);
    let scope = String(query.get('scope') || 'all');
    const occ = String(query.get('occ') || masterKey(ev));
    if (!ev.recur) scope = 'all';
    if (scope === 'future' && occ === masterKey(ev)) scope = 'all';
    if (scope === 'one') {
      upsertException(ev.id, occ, true, null);
      addHistory(ev.id, true, 'updated', `이 일정만 삭제 (${occ.replace('T', ' ')})`);
    } else if (scope === 'future') {
      truncateSeries(ev, occ);
      addHistory(ev.id, true, 'updated', `이후 일정 삭제 (${occ.replace('T', ' ')} 부터)`);
    } else removeEvent(ev.id);
    save();
    return { ok: true };
  });

  // 선택한 시간에 다른 일정이 있는지 알려준다
  route('POST', '/api/conflicts', ({ body }) => {
    const b = body || {};
    const all_day = !!b.all_day;
    const re = all_day ? /^\d{4}-\d\d-\d\d$/ : /^\d{4}-\d\d-\d\dT\d\d:\d\d$/;
    if (!re.test(b.start || '') || !re.test(b.end || '') || R.parse(b.end) < R.parse(b.start)) return [];
    const [s, e] = R.span({ start: b.start, end: b.end, all_day });
    const exclude = +b.exclude_id || null;
    const out = [];
    for (const ev of DB.events) {
      if (ev.id === exclude) continue;
      for (const occ of R.expand(ev, s, e, exOf(ev.id))) {
        if (occ.ev.status === 'cancelled') continue;
        out.push({ who: [DB.name || '나'], title: occ.ev.title, start: occ.ev.start, end: occ.ev.end, all_day: !!occ.ev.all_day });
      }
    }
    return out.slice(0, 20);
  });

  route('GET', '/api/events/:id/comments', ({ params }) => {
    const ev = findEvent(params[0]);
    return DB.comments.filter((c) => c.event_id === ev.id).map((c) => ({ id: c.id, body: c.body, created_at: c.created_at, user_id: ME.id, name: DB.name || '나', canDelete: true }));
  });
  route('POST', '/api/events/:id/comments', ({ params, body }) => {
    const ev = findEvent(params[0]);
    const text = String((body && body.body) || '').trim().slice(0, 2000);
    if (!text) throw httpError(400, '댓글 내용을 입력하세요.');
    DB.comments.push({ id: nextId('comment'), event_id: ev.id, body: text, created_at: nowStamp() });
    addHistory(ev.id, true, 'comment', `댓글 작성: ${text.length > 80 ? text.slice(0, 80) + '…' : text}`);
    save();
    return { ok: true };
  });
  route('DELETE', '/api/comments/:id', ({ params }) => {
    const c = DB.comments.find((x) => x.id === +params[0]);
    if (!c) throw httpError(404, '댓글을 찾을 수 없습니다.');
    DB.comments = DB.comments.filter((x) => x.id !== c.id);
    addHistory(c.event_id, true, 'comment', `댓글 삭제: ${c.body.length > 60 ? c.body.slice(0, 60) + '…' : c.body}`);
    save();
    return { ok: true };
  });
  route('GET', '/api/events/:id/history', ({ params }) => {
    const ev = findEvent(params[0]);
    return DB.history
      .filter((h) => h.event_id === ev.id)
      .slice()
      .reverse()
      .slice(0, 100)
      .map((h) => ({ id: h.id, action: h.action, detail: h.detail, created_at: h.created_at, name: h.by ? DB.name || '나' : null }));
  });

  route('GET', '/api/notifications', () => {
    const items = DB.notifications.slice().reverse().slice(0, 50);
    return { unread: DB.notifications.filter((n) => !n.read_at).length, items };
  });
  route('POST', '/api/notifications/read', ({ body }) => {
    const stamp = nowStamp();
    if (body && body.all) DB.notifications.forEach((n) => { if (!n.read_at) n.read_at = stamp; });
    else for (const id of ((body && body.ids) || []).map(Number)) {
      const n = DB.notifications.find((x) => x.id === id);
      if (n && !n.read_at) n.read_at = stamp;
    }
    save();
    return { ok: true };
  });
  route('DELETE', '/api/notifications', () => {
    DB.notifications = DB.notifications.filter((n) => !n.read_at);
    save();
    return { ok: true };
  });

  route('GET', '/api/expirations', () =>
    DB.expirations.slice().sort((a, b) => a.expire_date.localeCompare(b.expire_date) || a.name.localeCompare(b.name, 'ko')).map(({ id, category, name, expire_date, owner, memo, alert_days }) => ({ id, category, name, expire_date, owner, memo, alert_days })));
  route('POST', '/api/expirations', ({ body }) => {
    const f = cleanExpiration(body || {});
    const row = Object.assign({ id: nextId('exp') }, f);
    DB.expirations.push(row);
    save();
    return { id: row.id };
  });
  route('PUT', '/api/expirations/:id', ({ params, body }) => {
    const row = DB.expirations.find((x) => x.id === +params[0]);
    if (!row) throw httpError(404, '항목을 찾을 수 없습니다.');
    Object.assign(row, cleanExpiration(body || {}));
    save();
    return { ok: true };
  });
  route('DELETE', '/api/expirations/:id', ({ params }) => {
    DB.expirations = DB.expirations.filter((x) => x.id !== +params[0]);
    save();
    return { ok: true };
  });

  route('GET', '/api/templates', () => DB.templates.map((t) => ({ id: t.id, name: t.name, items: t.items })));
  route('POST', '/api/templates', ({ body }) => {
    const row = Object.assign({ id: nextId('tpl') }, cleanTemplate(body || {}));
    DB.templates.push(row);
    save();
    return { id: row.id };
  });
  route('PUT', '/api/templates/:id', ({ params, body }) => {
    const row = DB.templates.find((x) => x.id === +params[0]);
    if (!row) throw httpError(404, '템플릿을 찾을 수 없습니다.');
    Object.assign(row, cleanTemplate(body || {}));
    save();
    return { ok: true };
  });
  route('DELETE', '/api/templates/:id', ({ params }) => {
    DB.templates = DB.templates.filter((x) => x.id !== +params[0]);
    save();
    return { ok: true };
  });

  // 서버 없는 버전에는 없는 기능: 교육 현황은 빈 목록으로 답하고, 나머지는 안내 문구를 돌려준다
  route('GET', '/api/trainings', () => []);

  // ───────── 진입점 ─────────
  let readyResolve;
  const ready = new Promise((r) => (readyResolve = r));
  (async () => {
    try {
      await pullAndMerge();
    } catch {
      // 연결에 실패해도 이 브라우저의 데이터로 계속 쓴다
    }
    tick();
    readyResolve();
  })();

  async function localApi(url, opts) {
    await ready;
    const { method = 'GET', body } = opts || {};
    if (typeof FormData !== 'undefined' && body instanceof FormData) throw httpError(400, '파일 첨부와 엑셀 업로드는 서버 없는 버전에서 지원하지 않습니다.');
    const u = new URL(url, 'http://local');
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(u.pathname);
      if (m) return clone(await r.fn({ params: m.slice(1), query: u.searchParams, body: clone(body) }));
    }
    throw httpError(404, '서버 없는 버전에서는 지원하지 않는 기능입니다.');
  }

  window.localApi = localApi;
  window.LocalApi = {
    tick,
    getData: () => clone(DB),
    // 백업 파일 가져오기: 형식을 확인하고 통째로 교체한다
    replaceData(obj) {
      if (!obj || typeof obj !== 'object' || !Array.isArray(obj.events)) throw new Error('업무 캘린더 백업 파일이 아닙니다.');
      DB = normalize(obj);
      save();
    },
    hasName: () => !!DB.name,
    setName(n) {
      DB.name = String(n || '').trim().slice(0, 30) || DB.name;
      save();
    },
    sync: {
      state: () => Object.assign({}, sync, { pending }),
      onChange: (f) => { listeners.add(f); return () => listeners.delete(f); },
      now: (opts) => pullAndMerge(opts),
      pushNow: () => doPush(),
    },
  };
})();
