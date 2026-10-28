const $ = (s, r = document) => r.querySelector(s);
const DAYNAMES = ['일', '월', '화', '수', '목', '금', '토'];
const CATEGORIES = ['회의', '외근', '출장', '휴가', '교육', '기타'];
const ALARM_PRESETS = [
  [0, '일정 시작 시'], [10, '10분 전'], [30, '30분 전'], [60, '1시간 전'],
  [180, '3시간 전'], [1440, '1일 전'], [2880, '2일 전'], [10080, '1주일 전'],
];
const RESP_LABEL = { pending: '⏳ 미응답', yes: '✔ 참석', no: '✖ 불참', maybe: '？ 미정' };
const IMPORTANCE_LABEL = ['낮음', '보통', '높음'];
const NOTE_ICON = { done: '✅', invite: '✉️', assign: '👤', change: '✏️', cancel: '🚫', restore: '♻️', delete: '🗑️', reminder: '⏰', response: '💬', comment: '💭' };

// 팀원 색상: 가입 순서대로 서버가 배정한 컬러를 사용한다
const userColor = (id) => users.find((u) => u.id === id)?.color || '#4f46e5';
let me = null;
let users = [];
let cal = null;
const filt = { site: '', dept: '', member: '' };
const catShown = Object.fromEntries(CATEGORIES.map((c) => [c, true]));
const kindShown = { personal: true, team: true };
let current = null; // 열려 있는 일정 모달의 데이터
let afterStatusChange = null; // 종료/취소 변경 후 추가로 갱신할 화면(오늘의 일정 팝업 등)

// ---------- 유틸 ----------
const pad = (n) => String(n).padStart(2, '0');
const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localStr = (d) => `${dateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toDate = (v) => new Date(v.length === 10 ? v + 'T00:00' : v);
const userName = (id) => users.find((u) => u.id === id)?.name || '(알 수 없음)';
const sqlTime = (s) => new Date(s.replace(' ', 'T') + 'Z'); // 서버의 UTC 시각 -> 로컬
const fmtStamp = (s) => {
  const d = sqlTime(s);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 3500);
}

async function api(url, { method = 'GET', body } = {}) {
  // 서버 없는 버전(GitHub Pages)에서는 요청을 브라우저 안의 localapi.js 가 처리한다
  if (window.STATIC_MODE) return window.localApi(url, { method, body });
  const init = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/login') && !url.startsWith('/api/register') && url !== '/api/me') {
    showAuth();
    throw new Error('로그인이 필요합니다.');
  }
  if (!res.ok) {
    const err = new Error(data.error || (res.status === 404 ? '서버가 이 기능을 아직 지원하지 않습니다. 서버를 다시 시작했는지 확인하세요.' : '요청에 실패했습니다.'));
    err.code = data.code;
    throw err;
  }
  return data;
}

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}
const catBadge = (c) => el('span', { className: `cat cat-${c}`, textContent: c });

// ---------- 인증 ----------
let registerMode = false;
let pollTimer = null;
function showAuth() {
  clearInterval(pollTimer);
  $('#app-view').classList.add('hidden');
  $('#auth-view').classList.remove('hidden');
}
function setRegisterMode(on) {
  registerMode = on;
  document.querySelectorAll('.reg-only').forEach((x) => x.classList.toggle('hidden', !on));
  $('#auth-sub').textContent = on ? '계정을 만드세요 (첫 가입자는 관리자)' : '로그인하세요';
  $('#auth-submit').textContent = on ? '가입하기' : '로그인';
  $('#auth-toggle').textContent = on ? '이미 계정이 있나요? 로그인' : '계정이 없나요? 가입하기';
  $('#auth-error').textContent = '';
}
$('#auth-toggle').onclick = () => setRegisterMode(!registerMode);
$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    await api(registerMode ? '/api/register' : '/api/login', { method: 'POST', body: f });
    e.target.reset();
    await start();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
};
$('#btn-logout').onclick = async () => {
  await api('/api/logout', { method: 'POST' });
  try {
    sessionStorage.removeItem('moodAsked'); // 다음에 로그인하면 오늘의 기분을 다시 묻는다
  } catch {
    // 저장소를 못 써도 로그아웃은 계속한다
  }
  showAuth();
};

// ---------- 비밀번호 변경 / 팀원 관리 ----------
$('#btn-pw').onclick = () => {
  $('#pw-form').reset();
  $('#pw-error').textContent = '';
  $('#pw-dialog').showModal();
};
$('#pw-cancel').onclick = () => $('#pw-dialog').close();
$('#pw-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  if (f.password !== f.confirm) return ($('#pw-error').textContent = '새 비밀번호가 일치하지 않습니다.');
  try {
    await api('/api/me/password', { method: 'POST', body: { current: f.current, password: f.password } });
    $('#pw-dialog').close();
    toast('비밀번호가 변경되었습니다.');
  } catch (err) {
    $('#pw-error').textContent = err.message;
  }
};

// ---------- 테마 색상 ----------
const THEMES = ['lavender', 'mint', 'coral', 'sunny', 'sky', 'rose', 'ruby'];
function applyTheme(t) {
  if (!THEMES.includes(t)) t = 'lavender';
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('theme', t);
  } catch {
    // 저장이 막혀 있어도 이번 화면에는 적용된다
  }
  document.querySelectorAll('#theme-list button').forEach((b) => b.classList.toggle('on', b.dataset.theme === t));
}
$('#theme-list').onclick = (e) => {
  const b = e.target.closest('button');
  if (b) applyTheme(b.dataset.theme);
};
applyTheme(document.documentElement.dataset.theme);

// ---------- 오늘의 기분 → 색상 자동 적용 ----------
// 접속(로그인)할 때마다 한 번 묻고, 고른 기분에 맞는 색 테마를 적용한다. 같은 접속 중 새로고침에는 다시 묻지 않는다.
const MOODS = [
  { key: 'joy', emoji: '😄', label: '즐거움', sub: '따뜻한 코랄', theme: 'coral', a: '#f06454', b: '#ffb7a8' },
  { key: 'angry', emoji: '😡', label: '화남', sub: '강렬한 레드', theme: 'ruby', a: '#d6334a', b: '#f6a3ad' },
  { key: 'calm', emoji: '😌', label: '평온함', sub: '맑은 민트', theme: 'mint', a: '#0f9d8a', b: '#7fe0cf' },
  { key: 'tired', emoji: '😴', label: '피곤함', sub: '편안한 스카이', theme: 'sky', a: '#2f80ed', b: '#9fd0fb' },
  { key: 'power', emoji: '💪', label: '의욕이 넘침', sub: '활기찬 옐로', theme: 'sunny', a: '#e8850a', b: '#fcd98a' },
  { key: 'ok', emoji: '🙂', label: '보통', sub: '차분한 라벤더', theme: 'lavender', a: '#7a6cf0', b: '#c4b5fd' },
];
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 저장이 막혀 있어도 화면에는 적용된다 */ } },
};
const todayKey = () => dateStr(new Date());

function paintMoodChip() {
  const m = MOODS.find((x) => x.key === store.get('mood') && store.get('moodDate') === todayKey());
  $('#mood-chip').textContent = m ? `${m.emoji} 오늘의 기분: ${m.label} · 바꾸기` : '🎭 오늘의 기분 고르기';
}

function pickMood(m) {
  store.set('mood', m.key);
  store.set('moodDate', todayKey());
  applyTheme(m.theme);
  paintMoodChip();
  $('#mood-dialog').close();
  toast(`${m.emoji} ${m.label} — ${m.sub} 색으로 꾸몄어요.`);
}

function openMood() {
  if (document.querySelector('dialog[open]')) return;
  $('#mood-grid').replaceChildren(
    ...MOODS.map((m) => {
      const b = el('button', { type: 'button' }, el('span', { className: 'em', textContent: m.emoji }), el('b', { textContent: m.label }), el('small', { textContent: m.sub }));
      b.style.setProperty('--a', m.a);
      b.style.setProperty('--b', m.b);
      b.onclick = () => pickMood(m);
      return b;
    }),
  );
  $('#mood-dialog').showModal();
}

// 로그인 직후(또는 새 접속)에 한 번만 묻는다
function askMoodOnce() {
  let asked = false;
  try {
    asked = !!sessionStorage.getItem('moodAsked');
    sessionStorage.setItem('moodAsked', '1');
  } catch {
    asked = false;
  }
  paintMoodChip();
  if (!asked) openMood();
}
$('#mood-skip').onclick = () => $('#mood-dialog').close();
$('#mood-chip').onclick = openMood;
$('#mood-again').onclick = () => {
  $('#settings-dialog').close();
  openMood();
};

// ---------- 설정 (내 정보 보기 · 비밀번호 변경) ----------
$('#btn-settings').onclick = () => {
  $('#settings-who').textContent = [me.name, me.email].filter(Boolean).join(' · ');
  $('#settings-dialog').showModal();
};
$('#settings-close').onclick = () => $('#settings-dialog').close();

// ---------- 시작 ----------
function paintMe() {
  $('#me-name').textContent = me.name;
  $('#me-sub').textContent = me.email;
  $('#me-avatar').textContent = me.name.slice(0, 1);
  $('#me-avatar').style.background = userColor(me.id);
}

async function start() {
  try {
    me = await api('/api/me');
  } catch {
    return showAuth();
  }
  users = await api('/api/users');
  Object.assign(filt, { site: '', dept: '', member: '' });
  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  paintMe();
  $('#mail-warn').textContent = me.mailConfigured ? '' : '※ 이메일(SMTP) 설정이 없어 알람 메일은 발송되지 않습니다. (앱 알림은 정상 동작)';
  renderLegend();
  fillUserSelects();
  renderFilters();
  if (!cal) initCalendar();
  else refresh();
  await loadNotifications();
  clearInterval(pollTimer);
  // 30초마다 알림을 확인하고, 종료 시각이 지나 자동으로 종료된 일정이 체크되도록 화면도 갱신한다
  pollTimer = setInterval(() => {
    loadNotifications(true);
    if (!document.querySelector('dialog[open]')) refresh();
  }, 30000);
  // 로그인하면 오늘의 일정이 담긴 홈(대시보드)을 가장 먼저 보여준다
  dashWeek = 0;
  dashDay = midnight(new Date());
  setView('dash');
  openFromHash(); // 일정 링크(#event=...)로 들어왔으면 그 일정을 바로 연다
  askMoodOnce();
}

// 분류 색상 칩: 눌러서 분류별로 켜고 끈다
function renderLegend() {
  $('#cat-legend').replaceChildren(
    ...CATEGORIES.map((c) => {
      const b = el('button', { type: 'button', className: `cat cat-${c}${catShown[c] ? '' : ' off'}`, textContent: c, title: `${c} 일정 ${catShown[c] ? '숨기기' : '보기'}` });
      b.onclick = () => {
        catShown[c] = !catShown[c];
        renderLegend();
        refresh();
      };
      return b;
    }),
  );
}

function fillUserSelects() {
  document.querySelectorAll('select[data-users]').forEach((s) => {
    const keep = s.value;
    s.replaceChildren(s.options[0], ...users.map((u) => el('option', { value: u.id, textContent: u.name })));
    s.value = keep;
  });
  const as = $('#event-form').elements.assignee_id;
  as.replaceChildren(as.options[0], ...users.map((u) => el('option', { value: u.id, textContent: u.name })));
}

// ---------- 공장 / 팀 / 구성원 필터 ----------
const orgText = (u) => [u.dept, u.position].filter(Boolean).join(' ');
const usersInScope = () => users.filter((u) => (!filt.site || u.site === filt.site) && (!filt.dept || u.dept === filt.dept));
// 필터 조건에 맞는 등록자인지 (일정 표시/엑셀 내보내기 공통)
function userPasses(id) {
  const u = users.find((x) => x.id === id);
  if (!u) return false;
  return (!filt.site || u.site === filt.site) && (!filt.dept || u.dept === filt.dept) && (!filt.member || String(u.id) === String(filt.member));
}

// 혼자 쓰므로 공장·팀·구성원 필터는 없다 (일정 표시 조건은 userPasses 에서 항상 통과)
function renderFilters() {}

// ---------- 내부 알림 ----------
let lastUnread = null;
async function loadNotifications(poll = false) {
  let data;
  try {
    data = await api('/api/notifications');
  } catch {
    return;
  }
  const badge = $('#bell-badge');
  badge.textContent = data.unread > 99 ? '99+' : data.unread;
  badge.classList.toggle('hidden', !data.unread);
  document.title = (data.unread ? `(${data.unread}) ` : '') + '업무 캘린더';
  if (poll && lastUnread !== null && data.unread > lastUnread) {
    toast(`🔔 새 알림 ${data.unread - lastUnread}건이 도착했습니다.`);
    refresh(); // 초대·변경·취소 내용이 바로 반영되도록
  }
  lastUnread = data.unread;
  renderNotifications(data.items);
}

function ago(d) {
  const s = (Date.now() - d) / 1000;
  if (s < 60) return '방금 전';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderNotifications(items) {
  const ul = $('#notif-list');
  if (!items.length) return ul.replaceChildren(el('li', { className: 'notif-empty', textContent: '알림이 없습니다.' }));
  ul.replaceChildren(
    ...items.map((n) => {
      const li = el(
        'li', { className: n.read_at ? '' : 'unread' },
        el('span', { className: `ico t-${n.type}`, textContent: NOTE_ICON[n.type] || '🔔' }),
        el('span', { className: 'txt' }, el('b', { textContent: n.title }), el('span', { textContent: n.body }), el('time', { textContent: ago(sqlTime(n.created_at)) })),
      );
      if (!n.read_at) li.append(el('span', { className: 'dot' }));
      li.onclick = () => openNotification(n);
      return li;
    }),
  );
}

async function openNotification(n) {
  $('#notif-panel').classList.add('hidden');
  if (!n.read_at) {
    await api('/api/notifications/read', { method: 'POST', body: { ids: [n.id] } }).catch(() => {});
    loadNotifications();
  }
  if (!n.event_id || !n.ref_start) return;
  const d = toDate(n.ref_start);
  cal.gotoDate(d);
  selectDate(d);
  try {
    const day = dateStr(d);
    const items = await loadEvents(`${day}T00:00`, `${dateStr(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1))}T00:00`, true);
    const hit = items.find((e) => e.extendedProps.eventId === n.event_id);
    if (hit) openEvent(hit.extendedProps, hit.allDay);
    else toast('일정을 찾을 수 없습니다. (삭제되었거나 볼 수 없는 일정)', true);
  } catch (e) {
    toast(e.message, true);
  }
}

$('#btn-bell').onclick = (e) => {
  e.stopPropagation();
  $('#notif-panel').classList.toggle('hidden');
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('#notif-panel') && !e.target.closest('#btn-bell')) $('#notif-panel').classList.add('hidden');
});
$('#notif-readall').onclick = async () => {
  await api('/api/notifications/read', { method: 'POST', body: { all: true } });
  loadNotifications();
};
$('#notif-clear').onclick = async () => {
  await api('/api/notifications', { method: 'DELETE' });
  loadNotifications();
};

// ---------- 일정 불러오기 (캘린더·목록·검색이 함께 사용) ----------
// 분류별 파스텔 색 (배경 / 글자 / 왼쪽 막대)
const CAT_STYLE = {
  회의: { bg: '#dbeafe', fg: '#1e3a8a', bar: '#3b82f6' },
  외근: { bg: '#ffedd5', fg: '#7c2d12', bar: '#f97316' },
  출장: { bg: '#ccfbf1', fg: '#134e4a', bar: '#14b8a6' },
  휴가: { bg: '#dcfce7', fg: '#14532d', bar: '#22c55e' },
  교육: { bg: '#f3e8ff', fg: '#581c87', bar: '#a855f7' },
  기타: { bg: '#e5e7eb', fg: '#1f2937', bar: '#64748b' },
};
function decorate(r) {
  const x = r.extendedProps;
  x.rawTitle = r.title;
  const mark =
    (x.status === 'cancelled' ? '🚫 ' : x.status === 'done' ? '✅ ' : '') + (x.urgent ? '🔥 ' : '') + (x.importance === 2 ? '⭐ ' : '') +
    (x.recur ? '🔁 ' : '');
  const cs = CAT_STYLE[x.category] || CAT_STYLE['기타'];
  return { ...r, color: cs.bar, backgroundColor: cs.bg, borderColor: cs.bg, textColor: cs.fg, title: `${mark}${x.category === '기타' ? '' : `[${x.category}] `}${r.title}` };
}

// 사이드바 표시 필터 (긴급만 / 중요만 / 종료·취소 숨기기)
const flt = { urgent: false, important: false, closed: false };
for (const k of Object.keys(flt)) {
  $(`#flt-${k}`).onchange = (e) => {
    flt[k] = e.target.checked;
    refresh();
  };
}
const passFilters = (x) =>
  userPasses(x.ownerId) && kindShown[x.kind] && catShown[x.category] && (!flt.urgent || x.urgent) && (!flt.important || x.importance === 2) && (!flt.closed || x.status === 'active');

async function loadEvents(startStr, endStr, ignoreFilter = false) {
  const rows = await api(`/api/events?start=${encodeURIComponent(startStr)}&end=${encodeURIComponent(endStr)}`);
  return rows.filter((r) => ignoreFilter || passFilters(r.extendedProps)).map(decorate);
}

function openEvent(x, allDay) {
  openDialog({
    id: x.eventId, occ: x.occ, title: x.rawTitle, category: x.category, kind: x.kind, visibility: x.visibility,
    edit_perm: x.editPerm, canManage: x.canManage, all_day: allDay, start: x.rawStart, end: x.rawEnd, location: x.location, memo: x.memo,
    attendees: x.attendees, responses: x.responses, myResponse: x.myResponse, alarms: x.alarms, recur: x.recur, attachments: x.attachments,
    lastEditor: x.lastEditor, lastEditedAt: x.lastEditedAt,
    assignee_id: x.assigneeId, status: x.status, urgent: x.urgent, importance: x.importance, commentCount: x.commentCount,
    canEdit: x.canEdit, ownerId: x.ownerId, ownerName: x.ownerName,
  });
}

function refresh() {
  cal.refetchEvents();
  renderList();
  renderDash();
}

// ---------- 목록 항목 (일별/주간/검색 공통) ----------
async function respond(eventId, response) {
  try {
    await api(`/api/events/${eventId}/respond`, { method: 'POST', body: { response } });
    toast(`${RESP_LABEL[response].slice(2)}(으)로 응답했습니다.`);
    refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

// 종료(완료) / 취소 상태 변경 (목록의 체크박스와 일정 창에서 공통 사용). 반환: 변경 여부
async function changeStatus(x, status) {
  const word = status === 'cancelled' ? '취소' : status === 'done' ? '종료' : x.status === 'done' ? '종료 해제' : '복원';
  let scope = 'all';
  if (x.recur) {
    scope = await askScope(word, { future: false });
    if (!scope) return false;
  } else if (status === 'cancelled' && !confirm('이 일정을 취소할까요? (취소해도 기록은 남고 나중에 복원할 수 있습니다)')) return false;
  try {
    await api(`/api/events/${x.eventId}/status`, { method: 'POST', body: { status, scope, occ: x.occ } });
    toast(`일정을 ${word}했습니다.`);
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

function agendaItem(e, { dateLabel = false } = {}) {
  const x = e.extendedProps;
  const s = toDate(e.start);
  const en = e.end ? toDate(e.end) : s;
  let when = e.allDay ? '종일' : `${pad(s.getHours())}:${pad(s.getMinutes())} ~ ${pad(en.getHours())}:${pad(en.getMinutes())}`;
  if (dateLabel) when = `${s.getMonth() + 1}/${s.getDate()} (${DAYNAMES[s.getDay()]})\n${when}`;
  const meta = el('span', { className: 'meta' });
  if (x.importance === 2) meta.prepend(el('span', { className: 'flag-star', textContent: '⭐ 중요' }));
  if (x.urgent) meta.prepend(el('span', { className: 'flag-urgent', textContent: '🔥 긴급' }));
  if (x.status === 'done') meta.prepend(el('span', { className: 'flag-done', textContent: '✅ 종료' }));
  if (x.status === 'cancelled') meta.prepend(el('span', { className: 'status-badge', textContent: '취소됨' }));
  if (x.location) meta.append(el('span', { textContent: `📍 ${x.location}` }));
  if (x.commentCount) meta.append(el('span', { textContent: `💬 ${x.commentCount}` }));
  if (x.attachments.length) meta.append(el('span', { textContent: `📎 ${x.attachments.length}` }));
  const what = el('span', { className: 'what' }, el('b', { textContent: e.title }), meta);
  if (x.myResponse !== null && x.status !== 'cancelled') {
    const row = el('span', { className: 'resp-row' });
    for (const [r, label] of [['yes', '✔ 참석'], ['no', '✖ 불참'], ['maybe', '？ 미정']]) {
      const b = el('button', { type: 'button', className: `resp ${r}${x.myResponse === r ? ' on' : ''}`, textContent: label });
      b.onclick = (ev) => {
        ev.stopPropagation();
        respond(x.eventId, r);
      };
      row.append(b);
    }
    what.append(row);
  }
  // 종료 / 취소 체크박스
  if (x.canEdit) {
    const mk = (label, target, on) => {
      const cb = el('input', { type: 'checkbox', checked: on });
      cb.onclick = (ev) => ev.stopPropagation();
      cb.onchange = async () => {
        const ok = await changeStatus(x, cb.checked ? target : 'active');
        refresh(); // 취소·실패 시에도 체크 상태를 서버 기준으로 되돌린다
        if (ok && typeof afterStatusChange === 'function') afterStatusChange();
      };
      const lab = el('label', {}, cb, label);
      lab.onclick = (ev) => ev.stopPropagation();
      return lab;
    };
    what.append(el('span', { className: 'ctl' }, mk('종료', 'done', x.status === 'done'), mk('취소', 'cancelled', x.status === 'cancelled')));
  }
  const whenEl = el('span', { className: 'when', textContent: when });
  whenEl.style.whiteSpace = 'pre-line';
  const li = el('li', { className: [x.status === 'cancelled' && 'cancelled', x.status === 'done' && 'done', x.urgent && x.status === 'active' && 'urgent'].filter(Boolean).join(' ') }, whenEl, what);
  li.append(el('span', { className: `cat cat-${x.category} pill`, textContent: x.category }));
  li.style.borderLeftColor = e.color;
  li.onclick = () => openEvent(x, e.allDay);
  return li;
}

// ---------- 일별 / 주간 일정 목록 ----------
const DOW = DAYNAMES;
let listMode = 'day';
let selected = new Date();
selected.setHours(0, 0, 0, 0);
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a, b) => dateStr(a) === dateStr(b);

function selectDate(d) {
  selected = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  markSelected();
  renderList();
}

function markSelected() {
  if (!cal) return;
  const s = dateStr(selected);
  document.querySelectorAll('#calendar .fc-daygrid-day').forEach((c) => c.classList.toggle('sel-day', c.dataset.date === s));
}

function listRange() {
  if (listMode === 'day') return [selected, addDays(selected, 1)];
  if (listMode === 'month') return [new Date(selected.getFullYear(), selected.getMonth(), 1), new Date(selected.getFullYear(), selected.getMonth() + 1, 1)];
  const start = addDays(selected, -selected.getDay()); // 일요일 시작 (캘린더와 동일)
  return [start, addDays(start, 7)];
}

let listSeq = 0;
async function renderList() {
  if (!cal) return;
  const seq = ++listSeq;
  const [from, to] = listRange();
  const last = addDays(to, -1);
  $('#list-title').textContent =
    listMode === 'day'
      ? `${from.getMonth() + 1}월 ${from.getDate()}일 (${DOW[from.getDay()]})`
      : listMode === 'month'
        ? `${from.getFullYear()}년 ${from.getMonth() + 1}월`
        : `${from.getMonth() + 1}/${from.getDate()} ~ ${last.getMonth() + 1}/${last.getDate()} 주간`;
  document.querySelectorAll('.list-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === listMode));

  let items;
  try {
    items = await loadEvents(localStr(from), localStr(to));
  } catch (e) {
    return;
  }
  if (seq !== listSeq) return; // 더 최신 요청이 있으면 무시

  const today = new Date();
  const body = $('#list-body');
  body.replaceChildren();
  for (let d = from; d < to; d = addDays(d, 1)) {
    const next = addDays(d, 1);
    const dayItems = items
      .filter((e) => toDate(e.start) < next && (e.end ? toDate(e.end) : toDate(e.start)) > d)
      .sort((a, b) => (b.allDay - a.allDay) || toDate(a.start) - toDate(b.start));
    if (listMode === 'month' && !dayItems.length) continue; // 월간은 일정이 있는 날만 보여준다
    if (listMode !== 'day') {
      const h = el('h4', { textContent: `${d.getMonth() + 1}/${d.getDate()} (${DOW[d.getDay()]})${sameDay(d, today) ? ' · 오늘' : ''}` });
      if (sameDay(d, today)) h.classList.add('today');
      if (sameDay(d, selected)) h.classList.add('picked');
      h.onclick = () => selectDate(d);
      body.append(h);
    }
    if (!dayItems.length) {
      body.append(el('p', { className: 'muted small empty', textContent: '일정 없음' }));
      continue;
    }
    const ul = el('ul', { className: 'agenda' });
    for (const e of dayItems) ul.append(agendaItem(e));
    body.append(ul);
  }
}

document.querySelectorAll('.list-mode button').forEach((b) => {
  b.onclick = () => {
    listMode = b.dataset.mode;
    renderList();
  };
});
const stepList = (dir) =>
  listMode === 'month'
    ? new Date(selected.getFullYear(), selected.getMonth() + dir, 1)
    : addDays(selected, (listMode === 'day' ? 1 : 7) * dir);
$('#list-prev').onclick = () => {
  const d = stepList(-1);
  selectDate(d);
  if (listMode === 'month') cal.gotoDate(d);
};
$('#list-next').onclick = () => {
  const d = stepList(1);
  selectDate(d);
  if (listMode === 'month') cal.gotoDate(d);
};
$('#list-today').onclick = () => {
  selectDate(new Date());
  cal.today();
};
function newOnSelected() {
  const s = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate(), 9);
  openDialog({ start: localStr(s), end: localStr(new Date(s.getTime() + 3600000)), all_day: false });
}
$('#list-add').onclick = newOnSelected;
$('#fab-new').onclick = newOnSelected;

// ---------- 정렬 (진행 중 > 긴급 > 중요 > 시간) ----------
const todayRank = (e) => {
  const x = e.extendedProps;
  const closed = x.status === 'active' ? 0 : x.status === 'done' ? 1 : 2;
  return [closed, x.urgent ? 0 : 1, -x.importance, e.allDay ? 0 : 1, toDate(e.start).getTime()];
};
const cmpRank = (a, b) => {
  const ra = todayRank(a);
  const rb = todayRank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
  return 0;
};

// ---------- 대시보드 ----------
const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
// 하루(day)에 걸치는 일정인지
const occursOn = (e, day) => {
  const s = toDate(e.start);
  const en = e.end ? toDate(e.end) : s;
  return s < addDays(day, 1) && (en > day || (+en === +s && s >= day));
};
const isMineEv = (x) => x.ownerId === me.id || x.attendees.includes(me.id) || x.assigneeId === me.id;
const timeText = (e) => {
  if (e.allDay) return '종일';
  const s = toDate(e.start);
  const en = e.end ? toDate(e.end) : s;
  return `${pad(s.getHours())}:${pad(s.getMinutes())} ~ ${pad(en.getHours())}:${pad(en.getMinutes())}`;
};
const mdw = (d) => `${d.getMonth() + 1}/${d.getDate()} (${DAYNAMES[d.getDay()]})`;

let dashWeek = 0; // 현재 주 기준 이동량
let dashDay = midnight(new Date());
let dashScope = 'mine';
let dashSeq = 0;
let dashItems = [];

function setView(v) {
  document.querySelectorAll('.mi[data-nav]').forEach((b) => b.classList.toggle('on', b.dataset.nav === v));
  $('#dash-view').classList.toggle('hidden', v !== 'dash');
  $('#cal-view').classList.toggle('hidden', v !== 'cal');
  $('#edu-view').classList.toggle('hidden', v !== 'edu');
  $('#exp-view').classList.toggle('hidden', v !== 'exp');
  $('#tpl-view').classList.toggle('hidden', v !== 'tpl');
  $('#board-view').classList.toggle('hidden', v !== 'board');
  if (v === 'board') loadBoard();
  if (v === 'dash') {
    renderDash();
  } else if (v === 'edu') {
    loadTrainings();
  } else if (v === 'exp') {
    loadExp();
  } else if (v === 'tpl') {
    loadTpl();
  } else if (cal) {
    setTimeout(() => {
      cal.updateSize();
      markSelected();
      renderList();
    });
  }
}
document.querySelectorAll('.mi[data-nav]').forEach((b) => (b.onclick = () => setView(b.dataset.nav)));

async function renderDash() {
  if (!me || $('#dash-view').classList.contains('hidden')) return;
  const seq = ++dashSeq;
  const today = midnight(new Date());
  const ws = addDays(addDays(today, -today.getDay()), dashWeek * 7);
  const we = addDays(ws, 7);
  const mStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const mEnd = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const from = new Date(Math.min(mStart, ws, today));
  const to = new Date(Math.max(mEnd, we, addDays(today, 15)));
  let items;
  try {
    items = await loadEvents(localStr(from), localStr(to), true);
  } catch {
    return;
  }
  if (seq !== dashSeq) return;
  dashItems = items;
  paintDash();
  renderDashEdu();
  renderDashExp();
  paintQuick();
}

// ---------- 만료일 관리 (계약·보험·점검 등) ----------
const EXP = { rows: [], cat: '', q: '' };
const EXP_CATS = ['계약', '보험', '점검', '검사', '인허가', '임대차', '기타'];
const daysTo = (s) => Math.round((midnight(toDate(s)) - midnight(new Date())) / 86400000);
const ddayText = (d) => (d === 0 ? '오늘 만료' : d > 0 ? `D-${d}` : `${-d}일 지남`);
const ddayCls = (d) => (d < 0 ? 'd-over' : d <= 7 ? 'd-hot' : d <= 30 ? 'd-warn' : 'd-ok');
const dchip = (d) => el('span', { className: `dchip ${ddayCls(d)}`, textContent: ddayText(d) });
let expEditing = null;

async function loadExp() {
  $('#exp-add').classList.toggle('hidden', me.role !== 'admin');
  try {
    EXP.rows = await api('/api/expirations');
  } catch (e) {
    return toast(e.message, true);
  }
  const cats = [...new Set([...EXP_CATS, ...EXP.rows.map((r) => r.category).filter(Boolean)])];
  $('#exp-cat').replaceChildren(el('option', { value: '', textContent: '전체 구분' }), ...cats.map((c) => el('option', { value: c, textContent: c })));
  $('#exp-cat').value = EXP.cat;
  renderExp();
}

function renderExp() {
  const q = EXP.q.trim().toLowerCase();
  const rows = EXP.rows.filter((r) => (!EXP.cat || r.category === EXP.cat) && (!q || `${r.name} ${r.owner} ${r.memo}`.toLowerCase().includes(q)));
  const over = rows.filter((r) => daysTo(r.expire_date) < 0).length;
  const soon = rows.filter((r) => { const d = daysTo(r.expire_date); return d >= 0 && d <= 30; }).length;
  const kpi = (cls, label, v, unit = '') => el('span', { className: `kpi ${cls}` }, label, el('b', { textContent: v }), unit);
  $('#exp-kpi').replaceChildren(kpi('k-today', '전체 ', rows.length, '건'), kpi('k-wait', '30일 내 만료 ', soon, '건'), kpi('k-urgent', '만료됨 ', over, '건'));
  const body = $('#exp-body');
  body.replaceChildren();
  if (!EXP.rows.length) {
    return body.append(el('div', { className: 'edu-empty' },
      el('b', { textContent: '등록된 만료 항목이 없습니다.' }),
      el('p', { className: 'muted', textContent: me.role === 'admin' ? '오른쪽 위 "+ 항목 추가"로 계약·보험·점검·검사처럼 기한이 있는 항목을 등록하면 만료 전에 알려 드립니다.' : '관리자가 항목을 등록하면 여기에 표시됩니다.' })));
  }
  if (!rows.length) return body.append(el('div', { className: 'edu-empty' }, el('b', { textContent: '조건에 맞는 항목이 없습니다.' })));
  const head = ['구분', '항목', '만료일', '남은 기간', '담당', '알림', '메모'];
  if (me.role === 'admin') head.push('');
  const tbl = el('table', { className: 'edu-table' }, el('thead', {}, el('tr', {}, ...head.map((h) => el('th', { textContent: h })))));
  const tb = el('tbody');
  for (const r of rows) {
    const d = daysTo(r.expire_date);
    const tr = el('tr', {},
      el('td', { className: 'nw', textContent: r.category }),
      el('td', {}, el('b', { textContent: r.name })),
      el('td', { className: 'nw', textContent: r.expire_date }),
      el('td', { className: 'nw' }, dchip(d)),
      el('td', { className: 'nw', textContent: r.owner }),
      el('td', { className: 'nw', textContent: `${r.alert_days.split(',').join('·')}일 전` }),
      el('td', { textContent: r.memo }),
    );
    if (me.role === 'admin') tr.append(el('td', { className: 'nw' }, el('button', { type: 'button', className: 'certbtn', textContent: '수정', onclick: () => openExp(r) })));
    tb.append(tr);
  }
  tbl.append(tb);
  body.append(el('div', { className: 'edu-table-wrap' }, tbl));
}

function openExp(row) {
  expEditing = row || null;
  const f = $('#exp-form');
  f.reset();
  const cats = row?.category && !EXP_CATS.includes(row.category) ? [...EXP_CATS, row.category] : EXP_CATS;
  $('#exp-category').replaceChildren(...cats.map((c) => el('option', { value: c, textContent: c })));
  $('#exp-dlg-title').textContent = row ? '만료 항목 수정' : '만료 항목 추가';
  $('#exp-error').textContent = '';
  $('#exp-del').classList.toggle('hidden', !row);
  const e = f.elements; // form.name 은 폼 자신의 이름이라 elements 로 접근한다
  if (row) {
    e.category.value = row.category || '기타';
    e.name.value = row.name;
    e.expire_date.value = row.expire_date;
    e.owner.value = row.owner;
    e.alert_days.value = row.alert_days;
    e.memo.value = row.memo;
  } else {
    e.alert_days.value = '60,30,7';
  }
  $('#exp-dialog').showModal();
}
$('#exp-add').onclick = () => openExp(null);
$('#exp-cancel').onclick = () => $('#exp-dialog').close();
$('#exp-cat').onchange = (e) => { EXP.cat = e.target.value; renderExp(); };
$('#exp-q').oninput = (e) => { EXP.q = e.target.value; renderExp(); };
$('#exp-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    await api(expEditing ? `/api/expirations/${expEditing.id}` : '/api/expirations', { method: expEditing ? 'PUT' : 'POST', body: f });
    $('#exp-dialog').close();
    toast('저장되었습니다.');
    loadExp();
  } catch (err) {
    $('#exp-error').textContent = err.message;
  }
};
$('#exp-del').onclick = async () => {
  if (!expEditing || !confirm(`"${expEditing.name}" 항목을 삭제할까요?`)) return;
  try {
    await api(`/api/expirations/${expEditing.id}`, { method: 'DELETE' });
    $('#exp-dialog').close();
    loadExp();
  } catch (err) {
    $('#exp-error').textContent = err.message;
  }
};

// 대시보드: 60일 안에 만료되는 항목 (이미 지난 항목 포함)
async function renderDashExp() {
  let rows;
  try {
    rows = await api('/api/expirations');
  } catch {
    return;
  }
  const ul = $('#dash-exp-list');
  const list = rows.map((r) => ({ r, d: daysTo(r.expire_date) })).filter((x) => x.d <= 60).sort((a, b) => a.d - b.d).slice(0, 7);
  ul.replaceChildren();
  if (!rows.length) ul.append(el('li', { className: 'empty-msg', textContent: '등록된 만료 항목이 없습니다. ⏰ 만료일 관리에서 계약·보험·점검을 등록해 보세요.' }));
  else if (!list.length) ul.append(el('li', { className: 'empty-msg', textContent: '60일 안에 만료되는 항목이 없습니다 👍' }));
  for (const { r, d } of list) {
    const li = el('li', {}, el('span', { className: 'tm' }, dchip(d)), el('span', { textContent: `${r.category ? `[${r.category}] ` : ''}${r.name}` }));
    li.onclick = () => setView('exp');
    ul.append(li);
  }
}
$('#exp-open').onclick = () => setView('exp');

// ---------- 업무 템플릿 ----------
const TPL = { rows: [] };
let tplEditing = null;
let tplApplying = null;
const offText = (o) => (o === 0 ? '기준일' : o < 0 ? `${-o}일 전` : `${o}일 후`);
const TPL_SAMPLES = [
  { name: '월말 마감', items: [{ title: '경비 증빙 취합', offset: -5 }, { title: '고지서 납부 확인', offset: -3 }, { title: '월 마감 보고', offset: 0, urgent: true }] },
  { name: '신규 입사자 준비', items: [{ title: 'PC·계정 준비', offset: -3 }, { title: '사원증·비품 준비', offset: -2 }, { title: '입사 서류 안내', offset: -1 }, { title: '입사 첫날 오리엔테이션', offset: 0, urgent: true }, { title: '4대보험 취득 신고', offset: 3 }] },
  { name: '퇴사 처리', items: [{ title: '퇴직 서류 안내', offset: -7 }, { title: '비품·계정 회수', offset: -1 }, { title: '4대보험 상실 신고', offset: 0, urgent: true }, { title: '퇴직금 정산', offset: 14 }] },
];

async function loadTpl() {
  try {
    TPL.rows = await api('/api/templates');
  } catch (e) {
    return toast(e.message, true);
  }
  renderTpl();
}

function renderTpl() {
  const box = $('#tpl-body');
  box.replaceChildren();
  if (!TPL.rows.length) {
    return box.append(el('div', { className: 'edu-empty' },
      el('b', { textContent: '저장된 템플릿이 없습니다.' }),
      el('p', { className: 'muted', textContent: '자주 하는 업무 절차를 템플릿으로 만들어 두면 기준일만 정해서 한 번에 일정으로 등록할 수 있습니다.' }),
      el('button', { type: 'button', className: 'btn', textContent: '예시 템플릿 불러오기 (월말 마감·입사·퇴사)', onclick: loadTplSamples })));
  }
  for (const t of TPL.rows) {
    box.append(el('article', { className: 'tpl-card' },
      el('h3', { textContent: t.name }),
      el('span', { className: 'muted small', textContent: `할 일 ${t.items.length}개` }),
      el('ol', {}, ...t.items.slice(0, 6).map((i) => el('li', { textContent: `${i.urgent ? '🔥 ' : ''}${i.title} (${offText(i.offset)})` }))),
      t.items.length > 6 ? el('span', { className: 'muted small', textContent: `외 ${t.items.length - 6}개` }) : '',
      el('div', { className: 'tpl-btns' },
        el('button', { type: 'button', className: 'btn primary', textContent: '적용', onclick: () => openTplApply(t) }),
        el('button', { type: 'button', className: 'btn', textContent: '수정', onclick: () => openTplEditor(t) }),
        el('button', { type: 'button', className: 'btn danger', textContent: '삭제', onclick: () => delTpl(t) }))));
  }
}

async function loadTplSamples() {
  try {
    for (const t of TPL_SAMPLES) await api('/api/templates', { method: 'POST', body: t });
    toast('예시 템플릿을 불러왔습니다.');
    loadTpl();
  } catch (err) {
    toast(err.message, true);
  }
}

async function delTpl(t) {
  if (!confirm(`"${t.name}" 템플릿을 삭제할까요?\n(이미 등록한 일정은 그대로 남습니다)`)) return;
  try {
    await api(`/api/templates/${t.id}`, { method: 'DELETE' });
    loadTpl();
  } catch (err) {
    toast(err.message, true);
  }
}

function tplRow(i = { title: '', offset: 0, urgent: false }) {
  const row = el('div', { className: 'tpl-row' },
    el('input', { className: 't-title', placeholder: '할 일', maxLength: 100, value: i.title }),
    el('input', { className: 't-off', type: 'number', title: '기준일로부터 N일 (음수 = 이전)', value: String(i.offset) }),
    el('label', {}, el('input', { className: 't-urg', type: 'checkbox', checked: !!i.urgent }), '긴급'),
    el('button', { type: 'button', className: 'icon', textContent: '✕', title: '이 줄 삭제', onclick: () => row.remove() }));
  return row;
}

function openTplEditor(t) {
  tplEditing = t || null;
  $('#tpl-form').reset();
  $('#tpl-dlg-title').textContent = t ? '템플릿 수정' : '새 템플릿';
  $('#tpl-error').textContent = '';
  $('#tpl-form').elements.name.value = t?.name || '';
  $('#tpl-rows').replaceChildren(...(t?.items?.length ? t.items : [undefined]).map((i) => tplRow(i)));
  $('#tpl-dialog').showModal();
}
$('#tpl-add').onclick = () => openTplEditor(null);
$('#tpl-row-add').onclick = () => $('#tpl-rows').append(tplRow());
$('#tpl-cancel').onclick = () => $('#tpl-dialog').close();
$('#tpl-form').onsubmit = async (e) => {
  e.preventDefault();
  const items = [...$('#tpl-rows').children]
    .map((r) => ({ title: r.querySelector('.t-title').value.trim(), offset: Number(r.querySelector('.t-off').value) || 0, urgent: r.querySelector('.t-urg').checked }))
    .filter((i) => i.title);
  try {
    await api(tplEditing ? `/api/templates/${tplEditing.id}` : '/api/templates', { method: tplEditing ? 'PUT' : 'POST', body: { name: e.target.elements.name.value, items } });
    $('#tpl-dialog').close();
    loadTpl();
  } catch (err) {
    $('#tpl-error').textContent = err.message;
  }
};

function paintTplApply() {
  const base = $('#tplapply-form').elements.base.value;
  const ul = $('#tplapply-list');
  ul.replaceChildren();
  if (!base || !tplApplying) return;
  for (const i of tplApplying.items) ul.append(el('li', {}, el('b', { textContent: mdw(addDays(toDate(base), i.offset)) }), ` ${i.urgent ? '🔥 ' : ''}${i.title}`));
}
function openTplApply(t) {
  tplApplying = t;
  const f = $('#tplapply-form');
  f.reset();
  f.elements.base.value = dateStr(new Date());
  $('#tplapply-title').textContent = `"${t.name}" 적용`;
  $('#tplapply-error').textContent = '';
  paintTplApply();
  $('#tplapply-dialog').showModal();
}
$('#tplapply-form').onchange = paintTplApply;
$('#tplapply-cancel').onclick = () => $('#tplapply-dialog').close();
$('#tplapply-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const kind = f.mode.value === 'team' ? 'team' : 'personal';
  const visibility = f.mode.value === 'personal-me' ? 'me' : 'team';
  const go = $('#tplapply-go');
  go.disabled = true;
  let ok = 0;
  try {
    for (const i of tplApplying.items) {
      const day = dateStr(addDays(toDate(f.base.value), i.offset));
      await api('/api/events', {
        method: 'POST',
        body: {
          title: `[${tplApplying.name}] ${i.title}`, category: '기타', urgent: !!i.urgent, importance: i.urgent ? 2 : 1,
          kind, visibility, edit_perm: kind === 'team' ? 'attendees' : 'owner',
          all_day: true, start: day, end: day, location: '', memo: '', attendees: [], alarms: [], recur: null, assignee_id: null,
        },
      });
      ok++;
    }
    $('#tplapply-dialog').close();
    toast(`일정 ${ok}개가 등록되었습니다. 전체 캘린더와 오늘의 할 일에서 체크할 수 있습니다.`);
    refresh();
  } catch (err) {
    $('#tplapply-error').textContent = `${ok}개 등록 후 오류가 났습니다: ${err.message}`;
  } finally {
    go.disabled = false;
  }
};

// ---------- 업무 보드 (진행 중 · 종료 · 취소) ----------
const BOARD = { month: new Date(new Date().getFullYear(), new Date().getMonth(), 1), scope: 'mine', urgent: false, items: [] };
const BOARD_COLS = [['active', '🟢 진행 중'], ['done', '✅ 종료'], ['cancelled', '🚫 취소']];
const cardKey = (e) => `${e.extendedProps.eventId}|${e.extendedProps.occ}`;

async function loadBoard() {
  const from = BOARD.month;
  const to = new Date(from.getFullYear(), from.getMonth() + 1, 1);
  $('#board-title').textContent = `${from.getFullYear()}년 ${from.getMonth() + 1}월`;
  try {
    BOARD.items = await loadEvents(localStr(from), localStr(to), true);
  } catch (e) {
    return toast(e.message, true);
  }
  renderBoard();
}

async function moveCard(card, status) {
  const x = card.extendedProps;
  if (x.status === status) return;
  if (!x.canEdit) return toast('이 일정을 바꿀 권한이 없습니다.', true);
  const ok = await changeStatus(x, status);
  await loadBoard();
  if (ok) refresh();
}

function renderBoard() {
  const body = $('#board-body');
  body.replaceChildren();
  const list = BOARD.items
    .filter((e) => (BOARD.scope === 'all' || isMineEv(e.extendedProps)) && (!BOARD.urgent || e.extendedProps.urgent))
    .sort((a, b) => toDate(a.start) - toDate(b.start));
  for (const [key, label] of BOARD_COLS) {
    const rows = list.filter((e) => e.extendedProps.status === key);
    const box = el('div', { className: 'kb-list' });
    if (!rows.length) box.append(el('div', { className: 'kb-empty', textContent: '해당하는 일정이 없습니다' }));
    for (const e of rows) {
      const x = e.extendedProps;
      const card = el('div', { className: 'kb-card', draggable: !!x.canEdit },
        el('b', { textContent: `${x.urgent ? '🔥 ' : ''}${x.importance === 2 ? '⭐ ' : ''}${x.rawTitle || e.title}` }),
        el('span', { className: 'm' }, `${mdw(toDate(e.start))} ${timeText(e)}`, el('span', { className: `cat cat-${x.category} pill`, textContent: x.category })),
        '');
      card.style.borderLeftColor = e.color;
      if (x.canEdit) {
        // 끌어다 놓기가 안 되는 화면(휴대폰 등)을 위한 버튼
        const [to, text] = key === 'active' ? ['done', '종료로 ▶'] : ['active', '◀ 진행 중으로'];
        card.append(el('button', { type: 'button', className: 'go', textContent: text, onclick: (ev) => { ev.stopPropagation(); moveCard(e, to); } }));
      }
      card.ondragstart = (ev) => {
        ev.dataTransfer.setData('text/plain', cardKey(e));
        ev.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      };
      card.ondragend = () => card.classList.remove('dragging');
      card.onclick = () => openEvent(x, e.allDay);
      box.append(card);
    }
    const col = el('section', { className: 'kb-col' }, el('h3', {}, label, el('span', { className: 'cnt', textContent: rows.length })), box);
    col.ondragover = (ev) => { ev.preventDefault(); col.classList.add('over'); };
    col.ondragleave = (ev) => { if (!col.contains(ev.relatedTarget)) col.classList.remove('over'); };
    col.ondrop = (ev) => {
      ev.preventDefault();
      col.classList.remove('over');
      const k = ev.dataTransfer.getData('text/plain');
      const card = BOARD.items.find((i) => cardKey(i) === k);
      if (card) moveCard(card, key);
    };
    body.append(col);
  }
}
$('#board-prev').onclick = () => { BOARD.month = new Date(BOARD.month.getFullYear(), BOARD.month.getMonth() - 1, 1); loadBoard(); };
$('#board-next').onclick = () => { BOARD.month = new Date(BOARD.month.getFullYear(), BOARD.month.getMonth() + 1, 1); loadBoard(); };
$('#board-now').onclick = () => { BOARD.month = new Date(new Date().getFullYear(), new Date().getMonth(), 1); loadBoard(); };
$('#board-urgent').onchange = (e) => { BOARD.urgent = e.target.checked; renderBoard(); };
// ---------- 일정 복제 · 직접 링크 ----------
$('#btn-copy').onclick = () => {
  const d = current;
  dlg.close();
  openDialog({
    title: `${d.title} (복사)`, category: d.category, kind: d.kind, visibility: d.visibility, edit_perm: d.edit_perm,
    all_day: d.all_day, start: d.start, end: d.end, location: d.location, memo: d.memo, assignee_id: d.assignee_id,
    urgent: d.urgent, importance: d.importance, attendees: d.attendees, alarms: d.alarms, recur: d.recur,
  });
  toast('일정을 복제했습니다. 날짜와 제목을 확인하고 저장하세요.');
};
$('#btn-link').onclick = async () => {
  const d = current;
  const day = (d.occ || d.start || '').slice(0, 10);
  const url = `${location.origin}${location.pathname}#event=${d.id}${day ? `&d=${day}` : ''}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('일정 링크를 복사했습니다. 로그인한 팀원에게 전달하면 바로 열립니다.');
  } catch {
    prompt('아래 링크를 복사(Ctrl+C)하세요.', url);
  }
};
// 주소에 #event=번호&d=날짜 가 있으면 그 일정을 바로 연다
function openFromHash() {
  const m = location.hash.match(/^#event=(\d+)(?:&d=(\d{4}-\d\d-\d\d))?/);
  if (!m || !me || !cal) return;
  history.replaceState(null, '', location.pathname + location.search);
  openNotification({ event_id: +m[1], ref_start: m[2] || dateStr(new Date()), read_at: 'x' });
}
window.addEventListener('hashchange', openFromHash);



// 교육·참석요청 메일 현황 (메일 정보는 관리자에게만 보인다)
let eduSeq = 0;
async function renderDashEdu() {
  const seq = ++eduSeq;
  const box = $('#dash-edu-body');
  const today = midnight(new Date());
  const ts = dateStr(today);
  const ws = dateStr(addDays(today, -today.getDay()));
  const we = dateStr(addDays(today, 7 - today.getDay()));
  let rows;
  try {
    rows = await api('/api/trainings');
  } catch {
    return;
  }
  let preview = null;
  let log = [];
  if (me.role === 'admin') {
    try {
      [preview, log] = await Promise.all([api('/api/training-mail/preview'), api('/api/training-mail/log')]);
    } catch {
      preview = null;
    }
  }
  if (seq !== eduSeq) return;
  const people = (list) => new Set(list.map((r) => `${r.company}|${r.name}`)).size;
  const todayRows = rows.filter((r) => r.start_date && r.start_date <= ts && (r.end_date || r.start_date) >= ts);
  const weekRows = rows.filter((r) => r.start_date && r.start_date >= ws && r.start_date < we);
  const monthRows = rows.filter((r) => r.start_date && r.start_date.slice(0, 7) === ts.slice(0, 7));
  const stat = (label, n, unit, warn) => el('div', { className: `es${warn ? ' warn' : ''}` }, el('b', { textContent: `${n}${unit}` }), label);
  const out = [stat('오늘 교육 대상', people(todayRows), '명'), stat('이번 주 시작 교육', weekRows.length, '건'), stat('이번 달 교육', monthRows.length, '건')];
  if (!rows.length) {
    box.replaceChildren(el('p', { className: 'note', textContent: '아직 교육계획이 없습니다. 📚 교육 현황에서 엑셀을 올려 주세요.' }));
    return;
  }
  if (preview) {
    const failed = log.filter((l) => !l.ok && l.sent_at >= dateStr(addDays(today, -7))).length;
    const noEmail = preview.due.filter((p) => !p.email).length;
    out.push(stat('오늘 보낼 메일', preview.due.length, '명'));
    out.push(stat('메일 주소 없는 대상', noEmail, '명', noEmail > 0));
    out.push(stat('최근 7일 발송 실패', failed, '건', failed > 0));
    if (!preview.smtp) out.push(el('p', { className: 'note', textContent: '⚠️ 메일(SMTP)이 설정되지 않아 발송되지 않습니다.' }));
    else if (!preview.enabled) out.push(el('p', { className: 'note', textContent: '자동 발송이 꺼져 있습니다.' }));
  } else {
    out.push(el('p', { className: 'note', textContent: '메일 발송 현황은 관리자에게만 표시됩니다.' }));
  }
  box.replaceChildren(...out);
}

// 바로가기: 이미 있는 화면·버튼으로 이동한다
function paintQuick() {
  const goEdu = (then) => () => {
    setView('edu');
    if (then) setTimeout(then, 300);
  };
  // 서버 없는 버전(STATIC_MODE)에는 교육 현황·엑셀 업로드가 없다
  const items = window.STATIC_MODE
    ? [
        ['➕ 새 일정', () => $('#todo-add').click()],
        ['📋 업무 템플릿', () => setView('tpl')],
        ['⏰ 만료일 관리', () => setView('exp')],
        ['🔍 일정 검색', () => $('#btn-search').click()],
      ]
    : [
        ['➕ 새 일정', () => $('#todo-add').click()],
        ['📚 교육 현황', goEdu()],
        ...(me.role === 'admin' ? [['✉️ 참석요청 메일', goEdu(() => $('#edu-mail').click())]] : []),
        ['📤 엑셀 업로드', () => $('#btn-import').click()],
        ['🔍 일정 검색', () => $('#btn-search').click()],
      ];
  const box = $('#quick-body');
  box.replaceChildren(...items.map(([label, fn]) => el('button', { type: 'button', textContent: label, onclick: fn })));
}

function paintDash() {
  const items = dashItems;
  const today = midnight(new Date());
  const scoped = (e) => dashScope === 'all' || isMineEv(e.extendedProps);

  // --- 머리말 / 요약 ---
  $('#dash-hello').textContent = `${me.name}님의 대시보드`;
  $('#dash-date').textContent = `${today.getFullYear()}년 ${today.getMonth() + 1}월 ${today.getDate()}일 (${DAYNAMES[today.getDay()]})`;
  const mineToday = items.filter((e) => occursOn(e, today) && isMineEv(e.extendedProps));
  const activeToday = mineToday.filter((e) => e.extendedProps.status === 'active');
  const horizon = addDays(today, 15);
  const kpi = (cls, label, n, unit = '건') => el('span', { className: `kpi ${cls}` }, label, el('b', { textContent: n }), unit);
  $('#dash-kpi').replaceChildren(
    kpi('k-today', '오늘 일정 ', activeToday.length),
    kpi('k-urgent', '🔥 긴급 ', activeToday.filter((e) => e.extendedProps.urgent).length),
    kpi('k-note', '🔔 새 알림 ', lastUnread || 0),
  );

  // --- 오늘의 할 일 ---
  const todo = items.filter((e) => occursOn(e, today) && scoped(e)).sort(cmpRank);
  const live = todo.filter((e) => e.extendedProps.status !== 'cancelled');
  $('#todo-count').textContent = `${live.filter((e) => e.extendedProps.status === 'done').length}/${live.length} 완료`;
  const ul = $('#todo-list');
  ul.replaceChildren();
  if (!todo.length) ul.append(el('li', { className: 'empty-msg', textContent: '오늘 일정이 없습니다 🎉' }));
  for (const e of todo) {
    const x = e.extendedProps;
    const cb = el('input', { type: 'checkbox', checked: x.status === 'done', disabled: !x.canEdit || x.status === 'cancelled', title: '종료(완료) 체크' });
    cb.onchange = async () => {
      await changeStatus(x, cb.checked ? 'done' : 'active');
      refresh();
    };
    const t = el('span', { className: 't' }, el('b', { textContent: e.title }), el('small', { textContent: `${timeText(e)}${x.location ? ' · 📍 ' + x.location : ''}` }));
    t.onclick = () => openEvent(x, e.allDay);
    ul.append(el('li', { className: [x.status !== 'active' && x.status, x.urgent && x.status === 'active' && 'urgent'].filter(Boolean).join(' ') }, cb, t));
  }

  // --- 이번 주 일정 ---
  const ws = addDays(addDays(today, -today.getDay()), dashWeek * 7);
  const strip = $('#week-strip');
  strip.replaceChildren();
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    const evs = items.filter((e) => occursOn(e, d) && scoped(e) && e.extendedProps.status === 'active');
    const dots = el('span', { className: 'dots' }, ...evs.slice(0, 3).map((e) => el('i', { className: e.extendedProps.urgent ? 'u' : '' })));
    const b = el('button', { type: 'button', className: ['wd', i === 0 && 'sun', i === 6 && 'sat', sameDay(d, today) && 'today', sameDay(d, dashDay) && 'picked'].filter(Boolean).join(' ') },
      el('span', { className: 'nm', textContent: DAYNAMES[i] }), el('span', { className: 'num', textContent: d.getDate() }), dots);
    b.onclick = () => {
      dashDay = d;
      paintDash();
    };
    strip.append(b);
  }
  const dayEvs = items.filter((e) => occursOn(e, dashDay) && scoped(e)).sort(cmpRank);
  $('#week-day-title').textContent = `${mdw(dashDay)} · ${dayEvs.filter((e) => e.extendedProps.status !== 'cancelled').length}건`;
  const wl = $('#week-list');
  wl.replaceChildren();
  if (!dayEvs.length) wl.append(el('li', { className: 'empty-msg', textContent: '일정이 없습니다.' }));
  for (const e of dayEvs.slice(0, 6)) {
    const li = el('li', { className: e.extendedProps.status !== 'active' ? 'closed' : '' }, el('span', { className: 'tm', textContent: timeText(e) }), el('span', { textContent: e.title }));
    li.onclick = () => openEvent(e.extendedProps, e.allDay);
    wl.append(li);
  }
  if (dayEvs.length > 6) wl.append(el('li', { className: 'muted small', textContent: `외 ${dayEvs.length - 6}건 (전체 캘린더에서 확인)` }));

  // --- 긴급·중요 일정 현황 ---
  const hot = items
    .filter((e) => (e.extendedProps.urgent || e.extendedProps.importance === 2) && (e.end ? toDate(e.end) : toDate(e.start)) >= today && toDate(e.start) < horizon)
    .sort((a, b) => toDate(a.start) - toDate(b.start))
    .slice(0, 10);
  const sl = $('#status-list');
  sl.replaceChildren();
  if (!hot.length) sl.append(el('li', { className: 'empty-msg', textContent: '앞으로 14일 안에 긴급·중요 일정이 없습니다.' }));
  for (const e of hot) {
    const x = e.extendedProps;
    const chips = el('span', { className: 'chips-col' });
    if (x.urgent) chips.append(el('span', { className: 'chip urgent', textContent: '🔥 긴급' }));
    const [cls, label] = x.status === 'cancelled' ? ['cancel', '취소'] : x.status === 'done' ? ['done', '종료'] : x.myResponse === 'pending' ? ['wait', '응답 대기'] : ['run', '진행 중'];
    chips.append(el('span', { className: `chip ${cls}`, textContent: label }));
    const li = el('li', {}, el('span', { className: 'nm' }, `${x.importance === 2 ? '⭐ ' : ''}${x.rawTitle}`, el('small', { textContent: `${mdw(toDate(e.start))} ${timeText(e)}` })), chips);
    li.onclick = () => openEvent(x, e.allDay);
    sl.append(li);
  }
}

$('#edu-open').onclick = () => setView('edu');
$('#week-prev').onclick = () => {
  dashWeek--;
  dashDay = addDays(dashDay, -7);
  renderDash();
};
$('#week-next').onclick = () => {
  dashWeek++;
  dashDay = addDays(dashDay, 7);
  renderDash();
};
$('#week-now').onclick = () => {
  dashWeek = 0;
  dashDay = midnight(new Date());
  renderDash();
};

// 대시보드의 "+ 새로 만들기": 눌러진 자리에서 바로 빠른 등록 창을 연다
function quickFrom(btn, day) {
  const r = btn.getBoundingClientRect();
  const s = new Date();
  s.setMinutes(0, 0, 0);
  s.setHours(sameDay(day, new Date()) ? Math.min(s.getHours() + 1, 22) : 9);
  openQuick({
    allDay: false, startDate: dateStr(day), endDate: dateStr(day),
    st: `${pad(s.getHours())}:00`, et: `${pad(s.getHours() + 1)}:00`, x: r.left, y: r.top - 120,
  });
}
$('#todo-add').onclick = (e) => quickFrom(e.currentTarget, midnight(new Date()));
$('#week-add').onclick = (e) => quickFrom(e.currentTarget, dashDay);

// ---------- 교육 현황 (교육계획을 월별·인원별로 정리) ----------
const EDU = { rows: [], view: 'month', co: '', dept: '', kind: '', res: '', q: '', open: new Set(), loaded: false };
const resKind = (r) => (r === '이수' ? 'done' : !r ? 'pending' : 'other');
const monthName = (m) => (m === 0 ? '미정' : `${m}월`);
const won = (n) => (n ? n.toLocaleString('ko-KR') : '0');
const RES_LABEL = { done: '이수', pending: '실적 미입력' };

async function loadTrainings() {
  $('#edu-import').classList.toggle('hidden', me.role !== 'admin');
  $('#edu-mail').classList.toggle('hidden', me.role !== 'admin');
  $('#edu-remind').classList.toggle('hidden', me.role !== 'admin');
  try {
    EDU.rows = await api('/api/trainings');
    EDU.loaded = true;
  } catch (e) {
    return toast(e.message, true);
  }
  fillEduFilters();
  renderEdu();
}

function eduFiltered() {
  const q = EDU.q.trim().toLowerCase();
  return EDU.rows.filter((r) =>
    (!EDU.co || r.company === EDU.co) && (!EDU.dept || r.dept === EDU.dept) && (!EDU.kind || r.kind === EDU.kind) && (!EDU.res || resKind(r.result) === EDU.res) &&
    (!q || r.name.toLowerCase().includes(q) || r.course.toLowerCase().includes(q) || r.org.toLowerCase().includes(q)),
  );
}

function fillEduFilters() {
  const cos = [...new Set(EDU.rows.map((r) => r.company).filter(Boolean))];
  const depts = [...new Set(EDU.rows.filter((r) => !EDU.co || r.company === EDU.co).map((r) => r.dept).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
  const fill = (sel, first, values, cur) => {
    sel.replaceChildren(el('option', { value: '', textContent: first }), ...values.map((v) => el('option', { value: v, textContent: v })));
    sel.value = values.includes(cur) ? cur : '';
    return sel.value;
  };
  EDU.co = fill($('#edu-co'), '전체 소속', cos, EDU.co);
  EDU.dept = fill($('#edu-dept'), '전체 부서', depts, EDU.dept);
}
for (const [id, key] of [['edu-co', 'co'], ['edu-dept', 'dept'], ['edu-kind', 'kind'], ['edu-res', 'res']]) {
  $(`#${id}`).onchange = (e) => {
    EDU[key] = e.target.value;
    if (key === 'co') fillEduFilters();
    renderEdu();
  };
}
let eduTimer = null;
$('#edu-q').oninput = (e) => {
  clearTimeout(eduTimer);
  eduTimer = setTimeout(() => {
    EDU.q = e.target.value;
    renderEdu();
  }, 200);
};
$('#edu-tabs').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  EDU.view = b.dataset.v;
  document.querySelectorAll('#edu-tabs button').forEach((x) => x.classList.toggle('on', x === b));
  renderEdu();
};

const sumBy = (list, fn) => list.reduce((s, r) => s + fn(r), 0);
const peopleOf = (list) => new Set(list.map((r) => `${r.company}|${r.name}`)).size;
const dateText = (r) => {
  if (r.start_date) {
    const s = r.start_date.slice(5).replace('-', '/');
    return r.end_date && r.end_date !== r.start_date ? `${s}~${r.end_date.slice(r.end_date.slice(0, 7) === r.start_date.slice(0, 7) ? 8 : 5).replace('-', '/')}` : s;
  }
  return r.schedule_raw || '일정 미정';
};
const resChip = (r) => {
  const k = resKind(r.result);
  return el('span', { className: `rchip ${k}`, textContent: r.result || '미입력' });
};

// 이수 결과 입력 (관리자): 표에서 바로 고른다
const RES_CHOICES = ['', '이수', '취소', '퇴사', '휴직', '대체'];
function resSelect(r) {
  const opts = RES_CHOICES.includes(r.result) ? RES_CHOICES : [...RES_CHOICES, r.result];
  const s = el('select', { className: 'res-sel', title: '이수 결과 변경' }, ...opts.map((v) => el('option', { value: v, textContent: v || '미입력', selected: v === r.result })));
  s.onchange = async () => {
    try {
      await api(`/api/trainings/${r.id}/result`, { method: 'POST', body: { result: s.value } });
      r.result = s.value;
      renderEdu();
    } catch (err) {
      s.value = r.result;
      toast(err.message, true);
    }
  };
  return s;
}

// 수료증 첨부 (관리자)
function certCell(r) {
  const td = el('td', { className: 'nw' });
  if (r.has_cert) {
    td.append(
      el('a', { className: 'certbtn', href: `/api/trainings/${r.id}/cert`, title: r.cert_name, textContent: '📎 받기' }), ' ',
      el('button', {
        type: 'button', className: 'certbtn', textContent: '✕', title: '수료증 삭제',
        onclick: async () => {
          if (!confirm('수료증 파일을 삭제할까요?')) return;
          try {
            await api(`/api/trainings/${r.id}/cert`, { method: 'DELETE' });
            await loadTrainings();
          } catch (err) {
            toast(err.message, true);
          }
        },
      }));
  } else {
    const inp = el('input', { type: 'file' });
    inp.onchange = async () => {
      if (!inp.files[0]) return;
      const fd = new FormData();
      fd.append('file', inp.files[0]);
      try {
        await api(`/api/trainings/${r.id}/cert`, { method: 'POST', body: fd });
        toast('수료증을 첨부했습니다.');
        await loadTrainings();
      } catch (err) {
        toast(err.message, true);
      }
    };
    td.append(el('button', { type: 'button', className: 'certbtn', textContent: '＋ 첨부', onclick: () => inp.click() }));
  }
  return td;
}

$('#edu-remind').onclick = async () => {
  try {
    const pv = await api('/api/training-mail/remind-preview');
    if (!pv.people.length) return toast('안내할 미이수자가 없습니다. (교육이 끝났는데 실적이 비어 있는 사람)');
    if (!pv.smtp) return toast('메일(SMTP)이 설정되어 있지 않아 발송할 수 없습니다.', true);
    const withMail = pv.people.filter((p) => p.email).length;
    const names = pv.people.slice(0, 8).map((p) => `${p.name}(${p.items.length}건)`).join(', ');
    if (!confirm(`교육이 끝났는데 이수 결과가 없는 ${pv.people.length}명 중 메일 주소가 있는 ${withMail}명에게 확인 요청 메일을 보냅니다.\n\n${names}${pv.people.length > 8 ? ' 외' : ''}\n\n보낼까요?`)) return;
    const r = await api('/api/training-mail/remind', { method: 'POST' });
    toast(`발송 ${r.sent}명(${r.items}건)${r.failed ? `, 실패 ${r.failed}명` : ''}${r.noEmail.length ? `, 메일 주소 없음 ${r.noEmail.length}명` : ''}`);
  } catch (err) {
    toast(err.message, true);
  }
};

function renderEdu() {
  const body = $('#edu-body');
  if (!EDU.rows.length) {
    $('#edu-kpi').replaceChildren();
    $('#edu-chart').replaceChildren();
    $('#edu-asof').textContent = '';
    body.replaceChildren(
      el('div', { className: 'edu-empty' },
        el('b', { textContent: '등록된 교육계획이 없습니다.' }),
        el('p', { className: 'muted', textContent: me.role === 'admin' ? '오른쪽 위 "교육계획 엑셀 업로드"로 "2026년 부서별 교육계획 대 실적" 파일을 올리면 월별·인원별로 자동 정리됩니다.' : '관리자가 교육계획 엑셀을 업로드하면 월별·인원별 현황이 표시됩니다.' })),
    );
    return;
  }
  const rows = eduFiltered();
  const done = rows.filter((r) => r.result === '이수').length;
  const other = rows.filter((r) => resKind(r.result) === 'other').length;
  const pending = rows.filter((r) => !r.result).length;
  $('#edu-asof').textContent = `전체 ${EDU.rows.length}건 중 ${rows.length}건 표시`;
  const kpi = (cls, label, v, unit = '') => el('span', { className: `kpi ${cls}` }, label, el('b', { textContent: v }), unit);
  $('#edu-kpi').replaceChildren(
    kpi('k-today', '교육 건수 ', rows.length, '건'),
    kpi('k-wait', '교육 인원 ', peopleOf(rows), '명'),
    kpi('k-note', '교육비 ', won(sumBy(rows, (r) => r.cost)), '원'),
    kpi('k-ok', '이수 ', done, '건'),
    kpi('k-ok', '이수율 ', rows.length - other > 0 ? Math.round((done / (rows.length - other)) * 100) : 0, '%'),
    kpi('k-urgent', '실적 미입력 ', pending, '건'),
    kpi('k-mute', '취소·퇴사·휴직·대체 ', other, '건'),
  );
  renderEduChart(rows);
  body.replaceChildren();
  if (!rows.length) return body.append(el('div', { className: 'edu-empty' }, el('b', { textContent: '조건에 맞는 교육이 없습니다.' })));
  EDU.view === 'month' ? renderEduMonths(rows) : renderEduPeople(rows);
}

// 월별 건수 막대 (눌러서 해당 월로 이동)
function renderEduChart(rows) {
  const now = new Date();
  const months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0];
  const counts = months.map((m) => rows.filter((r) => r.month === m).length);
  const max = Math.max(1, ...counts);
  const box = $('#edu-chart');
  box.replaceChildren(
    ...months.map((m, i) => {
      const cur = m === now.getMonth() + 1;
      const bar = el('i');
      bar.style.height = `${Math.round((counts[i] / max) * 100)}%`;
      const b = el('button', { type: 'button', className: `ecol${cur ? ' cur' : ''}${counts[i] ? '' : ' zero'}`, title: `${monthName(m)} ${counts[i]}건` },
        el('span', { className: 'n', textContent: counts[i] || '' }), el('span', { className: 'bar' }, bar), el('span', { className: 'm', textContent: m === 0 ? '미정' : `${m}월` }));
      b.onclick = () => {
        if (EDU.view !== 'month') $('#edu-tabs [data-v=month]').click();
        EDU.open.add(m);
        renderEdu();
        document.getElementById(`edu-m-${m}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      return b;
    }),
  );
}

function eduTable(list, { showMonth = false } = {}) {
  const head = ['일정', '소속 · 부서', '성명(직급)', '구분', '교육과목', '교육기관', '시간', '교육비', '실적'];
  if (showMonth) head.unshift('월');
  if (me.role === 'admin') head.push('수료증');
  const tbl = el('table', { className: 'edu-table' }, el('thead', {}, el('tr', {}, ...head.map((h) => el('th', { textContent: h })))));
  const tb = el('tbody');
  for (const r of list) {
    const tr = el('tr', { className: resKind(r.result) });
    if (showMonth) tr.append(el('td', { textContent: monthName(r.month) }));
    tr.append(
      el('td', { className: 'nw', textContent: dateText(r), title: r.note || r.schedule_raw }),
      el('td', { textContent: `${r.company} · ${r.dept}` }),
      el('td', { className: 'nw' }, el('b', { textContent: r.name }), r.rank ? ` (${r.rank})` : ''),
      el('td', {}, r.kind ? el('span', { className: `kpill k-${r.kind}`, textContent: r.kind }) : ''),
      el('td', { className: 'course', textContent: r.course }),
      el('td', { textContent: r.org }),
      el('td', { className: 'num', textContent: r.hours ? `${r.hours}h` : '' }),
      el('td', { className: 'num', textContent: r.cost ? won(r.cost) : '-' }),
      el('td', {}, me.role === 'admin' ? resSelect(r) : resChip(r)),
    );
    if (me.role === 'admin') tr.append(certCell(r));
    if (r.note) tr.firstElementChild.append(el('small', { className: 'warnline', textContent: ` ⚠ ${r.note}` }));
    tb.append(tr);
  }
  tbl.append(tb);
  return el('div', { className: 'edu-table-wrap' }, tbl);
}

// 월별: 월마다 접고 펼 수 있는 구역 + 요약
function renderEduMonths(rows) {
  const body = $('#edu-body');
  const now = new Date();
  const months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0];
  if (!EDU.opened) {
    EDU.opened = true;
    EDU.open.add(now.getMonth() + 1); // 처음에는 이번 달만 펼친다
  }
  const bar = el('div', { className: 'edu-actions' },
    el('button', { type: 'button', className: 'btn', textContent: '모두 펼치기', onclick: () => { months.forEach((m) => EDU.open.add(m)); renderEdu(); } }),
    el('button', { type: 'button', className: 'btn', textContent: '모두 접기', onclick: () => { EDU.open.clear(); renderEdu(); } }));
  body.append(bar);
  for (const m of months) {
    const list = rows.filter((r) => r.month === m);
    if (!list.length) continue;
    const done = list.filter((r) => r.result === '이수').length;
    const pending = list.filter((r) => !r.result).length;
    const past = m !== 0 && m < now.getMonth() + 1; // 이미 지난 달인데 실적이 비어 있으면 알려준다
    const det = el('details', { className: 'edu-month', id: `edu-m-${m}`, open: EDU.open.has(m) });
    det.ontoggle = () => (det.open ? EDU.open.add(m) : EDU.open.delete(m));
    det.append(
      el('summary', {},
        el('b', { className: 'mname', textContent: monthName(m) }),
        el('span', { className: 'ms' }, `${list.length}건`),
        el('span', { className: 'ms' }, `${peopleOf(list)}명`),
        el('span', { className: 'ms' }, `${won(sumBy(list, (r) => r.cost))}원`),
        el('span', { className: 'ms ok' }, `이수 ${done}`),
        past && pending ? el('span', { className: 'ms warn', textContent: `⚠ 지난 달 실적 미입력 ${pending}건` }) : '',
        m === now.getMonth() + 1 ? el('span', { className: 'ms cur', textContent: '이번 달' }) : ''),
      eduTable(list),
    );
    body.append(det);
  }
}

// 인원별: 사람별 요약 + 월별 건수 + 펼치면 교육 목록
function renderEduPeople(rows) {
  const body = $('#edu-body');
  const people = new Map();
  for (const r of rows) {
    const k = `${r.company}|${r.name}`;
    if (!people.has(k)) people.set(k, { company: r.company, name: r.name, dept: r.dept, rank: r.rank, list: [] });
    people.get(k).list.push(r);
  }
  const list = [...people.values()].sort((a, b) => a.company.localeCompare(b.company, 'ko') || a.dept.localeCompare(b.dept, 'ko') || a.name.localeCompare(b.name, 'ko'));
  const months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0];
  const tbl = el('table', { className: 'edu-table people' });
  tbl.append(el('thead', {}, el('tr', {}, ...['소속', '부서', '직급', '성명', '건수', '시간', '교육비', '이수', ...months.map(monthName)].map((h, i) => el('th', { className: i >= 8 ? 'mth' : '', textContent: h })))));
  const tb = el('tbody');
  for (const p of list) {
    const tr = el('tr', { className: 'prow' },
      el('td', { textContent: p.company }), el('td', { textContent: p.dept }), el('td', { textContent: p.rank }),
      el('td', {}, el('b', { textContent: p.name })),
      el('td', { className: 'num', textContent: p.list.length }),
      el('td', { className: 'num', textContent: sumBy(p.list, (r) => r.hours) }),
      el('td', { className: 'num', textContent: won(sumBy(p.list, (r) => r.cost)) }),
      el('td', { className: 'num', textContent: p.list.filter((r) => r.result === '이수').length }),
      ...months.map((m) => {
        const n = p.list.filter((r) => r.month === m).length;
        const td = el('td', { className: `mc${n ? ' has' : ''}${n > 1 ? ' multi' : ''}`, textContent: n || '' });
        return td;
      }),
    );
    const detail = el('tr', { className: 'pdetail hidden' }, el('td', { colSpan: 21 }, eduTable([...p.list].sort((a, b) => (a.month || 99) - (b.month || 99)), { showMonth: true })));
    tr.onclick = () => detail.classList.toggle('hidden');
    tb.append(tr, detail);
  }
  tbl.append(tb);
  body.append(el('p', { className: 'muted small', textContent: '사람을 누르면 그 사람의 교육 목록이 펼쳐집니다.' }), el('div', { className: 'edu-table-wrap' }, tbl));
}

// 엑셀 업로드 (관리자) / 정리본 내보내기
$('#edu-export').onclick = () => {
  if (!EDU.rows.length) return toast('내보낼 교육 현황이 없습니다. 먼저 교육계획 엑셀을 업로드하세요.', true);
  location.href = '/api/trainings/export';
};
$('#edu-import').onclick = () => $('#edu-file').click();
$('#edu-file').onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importTrainingFile(file);
};
async function importTrainingFile(file) {
  if (EDU.rows.length && !confirm(`현재 교육 현황 ${EDU.rows.length}건을 "${file.name}" 내용으로 교체합니다. 계속할까요?`)) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await api('/api/trainings/import', { method: 'POST', body: fd });
    toast(`교육 ${res.imported}건을 불러왔습니다.${res.warnings.length ? ` (확인 필요 ${res.warnings.length}건)` : ''}`);
    if (res.warnings.length) alert('아래 행은 일정 형식을 읽지 못해 월 기준으로만 반영했습니다.\n\n' + res.warnings.join('\n'));
    EDU.opened = false;
    EDU.open.clear();
    await loadTrainings();
  } catch (err) {
    toast(err.message, true);
  }
};

// ---------- 교육 참석 요청 메일 (주기 설정 · 메일 주소 · 발송 이력) ----------
const tmd = $('#tmail-dialog');
const TM = { settings: null, people: [], tab: 'set' };

$('#edu-mail').onclick = async () => {
  tmd.showModal();
  await loadTmSettings();
  showTmTab('set');
};
$('#tmail-close').onclick = () => tmd.close();

function showTmTab(t) {
  TM.tab = t;
  document.querySelectorAll('.tm-tab').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  for (const k of ['set', 'addr', 'hist']) $(`#tm-${k}`).classList.toggle('hidden', k !== t);
  if (t === 'addr') loadTmAddr();
  if (t === 'hist') loadTmHist();
}
document.querySelectorAll('.tm-tab').forEach((b) => (b.onclick = () => showTmTab(b.dataset.t)));

async function loadTmSettings() {
  try {
    const s = await api('/api/training-mail/settings');
    TM.settings = s;
    const f = $('#tm-set');
    f.elements.enabled.checked = s.enabled;
    f.elements.sendTime.value = s.sendTime;
    f.elements.cc.value = s.cc;
    f.elements.replyTo.value = s.replyTo;
    f.elements.intro.value = s.intro;
    f.elements.outro.value = s.outro;
    $('#tm-leads').replaceChildren(
      ...s.leadChoices.map((n) => el('label', {}, el('input', { type: 'checkbox', name: 'lead', value: n, checked: s.leads.includes(n) }), n === 0 ? '교육 당일' : `${n}일 전`)),
    );
    f.elements.leadsCustom.value = s.leads.filter((n) => !s.leadChoices.includes(n)).join(', ');
    const warn = $('#tm-smtp');
    const msgs = [];
    if (!s.smtp) msgs.push('⚠ 이메일(SMTP) 설정이 없어 메일이 실제로 발송되지 않습니다. 서버 폴더의 .env 파일에 SMTP 정보를 입력하고 서버를 다시 시작하세요.');
    if (s.people && s.withEmail < s.people) msgs.push(`메일 주소가 등록된 사람은 ${s.withEmail}/${s.people}명입니다. ② 메일 주소 탭에서 등록하세요.`);
    warn.textContent = msgs.join('\n');
    warn.style.whiteSpace = 'pre-line';
    warn.classList.toggle('hidden', !msgs.length);
  } catch (e) {
    toast(e.message, true);
  }
}

$('#tm-set').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    await api('/api/training-mail/settings', {
      method: 'PUT',
      body: {
        enabled: f.enabled.checked, sendTime: f.sendTime.value, cc: f.cc.value, replyTo: f.replyTo.value, intro: f.intro.value, outro: f.outro.value,
        leads: [
          ...[...e.target.querySelectorAll('[name=lead]:checked')].map((x) => +x.value),
          ...f.leadsCustom.value.split(/[,\s]+/).filter(Boolean).map(Number),
        ],
      },
    });
    toast(f.enabled.checked ? '저장했습니다. 설정한 주기에 맞춰 자동 발송됩니다.' : '저장했습니다. (자동 발송은 꺼져 있습니다)');
    loadTmSettings();
  } catch (err) {
    toast(err.message, true);
  }
};
$('#tm-default-text').onclick = () => {
  const f = $('#tm-set').elements;
  f.intro.value = TM.settings.defaultIntro;
  f.outro.value = TM.settings.defaultOutro;
  toast('기본 문구로 채웠습니다. 저장을 눌러야 적용됩니다.');
};
$('#tm-test').onclick = async () => {
  const to = $('#tm-test-to').value.trim();
  if (!to) return toast('테스트 메일을 받을 주소를 입력하세요.', true);
  try {
    await api('/api/training-mail/test', { method: 'POST', body: { to } });
    toast(`${to} 로 테스트 메일을 보냈습니다.`);
  } catch (err) {
    toast(err.message, true);
  }
};

// ----- 메일 주소 -----
async function loadTmAddr() {
  try {
    TM.people = await api('/api/training-mail/emails');
  } catch (e) {
    return toast(e.message, true);
  }
  renderTmAddr();
}
function renderTmAddr() {
  const q = $('#tm-addr-q').value.trim().toLowerCase();
  const onlyMissing = $('#tm-addr-missing').checked;
  const have = TM.people.filter((p) => p.email).length;
  $('#tm-addr-sum').textContent = `교육 대상자 ${TM.people.length}명 중 메일 주소 등록 ${have}명 · 미등록 ${TM.people.length - have}명`;
  const tbl = $('#tm-addr-table');
  tbl.replaceChildren(el('thead', {}, el('tr', {}, ...['소속', '부서', '성명(직급)', '교육 건수', '메일 주소'].map((h) => el('th', { textContent: h })))));
  const tb = el('tbody');
  for (const p of TM.people) {
    if (onlyMissing && p.email) continue;
    if (q && !`${p.name} ${p.dept}`.toLowerCase().includes(q)) continue;
    const input = el('input', { type: 'email', value: p.email || '', placeholder: '이름@회사.com' });
    input.oninput = () => {
      p._new = input.value.trim();
      input.classList.toggle('changed', p._new !== (p.email || ''));
    };
    tb.append(el('tr', { className: p.email ? '' : 'dup' }, el('td', { textContent: p.company }), el('td', { textContent: p.dept }), el('td', {}, el('b', { textContent: p.name }), p.rank ? ` (${p.rank})` : ''), el('td', { textContent: p.n }), el('td', {}, input)));
  }
  tbl.append(tb);
}
$('#tm-addr-q').oninput = renderTmAddr;
$('#tm-addr-missing').onchange = renderTmAddr;
$('#tm-addr-save').onclick = async () => {
  const items = TM.people.filter((p) => p._new !== undefined && p._new !== (p.email || '')).map((p) => ({ company: p.company, name: p.name, email: p._new }));
  if (!items.length) return toast('변경된 내용이 없습니다.');
  try {
    await api('/api/training-mail/emails', { method: 'PUT', body: { items } });
    toast(`${items.length}명의 메일 주소를 저장했습니다.`);
    await loadTmAddr();
    loadTmSettings();
  } catch (err) {
    toast(err.message, true);
  }
};
$('#tm-addr-upload').onclick = () => $('#tm-addr-file').click();
$('#tm-addr-file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await api('/api/training-mail/emails/import', { method: 'POST', body: fd });
    toast(`메일 주소 ${r.updated}명을 반영했습니다.`);
    const problems = [...r.invalid.map((x) => `형식 오류 — ${x}`), ...r.notFound.map((x) => `교육 대상자에 없음 — ${x}`), ...r.ambiguous.map((x) => `동명이인(소속 열로 구분 필요) — ${x}`)];
    if (problems.length) alert('아래 항목은 반영하지 못했습니다.\n\n' + problems.slice(0, 40).join('\n') + (problems.length > 40 ? `\n… 외 ${problems.length - 40}건` : ''));
    await loadTmAddr();
    loadTmSettings();
  } catch (err) {
    toast(err.message, true);
  }
};

// ----- 발송 예정 / 이력 -----
function simpleTable(tbl, heads, rows, empty) {
  tbl.replaceChildren(el('thead', {}, el('tr', {}, ...heads.map((h) => el('th', { textContent: h })))));
  const tb = el('tbody');
  if (!rows.length) tb.append(el('tr', {}, el('td', { colSpan: heads.length, className: 'muted', textContent: empty })));
  for (const r of rows) tb.append(el('tr', { className: r.cls || '' }, ...r.cells.map((c) => (c instanceof Node ? c : el('td', { textContent: c })))));
  tbl.append(tb);
}
const leadWordC = (n) => (n === 0 ? '당일' : `D-${n}`);
async function loadTmHist() {
  try {
    const [pv, log] = await Promise.all([api('/api/training-mail/preview'), api('/api/training-mail/log')]);
    $('#tm-due-note').textContent = `${pv.enabled ? '자동 발송 켜짐' : '자동 발송 꺼짐'} · 발송 시각 ${pv.sendTime}${pv.smtp ? '' : ' · SMTP 미설정'}`;
    simpleTable($('#tm-due-table'), ['성명', '소속·부서', '메일', '발송 교육'], pv.due.map((p) => ({
      cls: p.email ? '' : 'bad',
      cells: [p.name, `${p.company} · ${p.dept}`, p.email || el('td', { className: 'err', textContent: '⚠ 메일 미등록' }), p.items.map((i) => `${i.course} (${leadWordC(i.lead)}, ${i.when})`).join(' / ')],
    })), '오늘 발송할 대상이 없습니다.');
    simpleTable($('#tm-up-table'), ['발송 예정일', '시점', '성명', '교육과목', '교육 일정', '메일'], pv.upcoming.map((u) => ({
      cells: [u.date, leadWordC(u.lead), `${u.name} (${u.dept})`, u.course, u.when, u.email || el('td', { className: 'err', textContent: '미등록' })],
    })), '예정된 발송이 없습니다. (발송 시점 설정과 교육 일정을 확인하세요)');
    simpleTable($('#tm-log-table'), ['발송 시각', '성명', '교육과목', '시점', '받는 사람', '결과'], log.map((l) => ({
      cells: [fmtStamp(l.sent_at), l.name || '', l.course || '', leadWordC(l.lead), l.email, el('td', { className: l.ok ? 'ok' : 'ng', textContent: l.ok ? '✔ 발송' : `✖ 실패 ${l.error}` })],
    })), '아직 발송 이력이 없습니다.');
  } catch (e) {
    toast(e.message, true);
  }
}
$('#tm-send-now').onclick = async () => {
  if (!confirm('오늘 발송 대상 중 아직 보내지 않은 메일을 지금 보냅니다. 계속할까요?')) return;
  try {
    const r = await api('/api/training-mail/send-now', { method: 'POST' });
    toast(`발송 ${r.sent}명(${r.items}건)${r.failed ? ` · 실패 ${r.failed}` : ''}${r.noEmail.length ? ` · 메일 미등록 ${r.noEmail.length}명 제외` : ''}`, !!r.failed);
    loadTmHist();
  } catch (err) {
    toast(err.message, true);
  }
};

// ---------- 캘린더 ----------
function initCalendar() {
  cal = new FullCalendar.Calendar($('#calendar'), {
    locale: 'ko',
    initialView: 'dayGridMonth',
    height: '100%',
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'dayGridMonth,timeGridWeek,timeGridDay,listMonth,multiMonthYear',
    },
    buttonText: { today: '오늘', dayGridMonth: '월', timeGridWeek: '주', timeGridDay: '일', listMonth: '목록', multiMonthYear: '년' },
    selectable: true,
    editable: true,
    eventDisplay: 'block', // 시간이 있는 일정도 분류 색 블록으로 표시
    dayCellContent: (a) => a.dayNumberText.replace('일', ''), // "27일" → "27" (좁은 화면에서 줄바꿈 방지)
    nowIndicator: true,
    navLinks: true,
    dayMaxEvents: true,
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    events: (info, ok, fail) => {
      loadEvents(info.startStr, info.endStr)
        .then(ok)
        .catch((e) => {
          toast(e.message, true);
          fail(e);
        });
    },
    eventClassNames: ({ event }) => {
      const x = event.extendedProps;
      return [x.status === 'cancelled' && 'ev-cancelled', x.status === 'done' && 'ev-done', x.urgent && x.status === 'active' && 'ev-urgent'].filter(Boolean);
    },
    // 일정 칸: [시간] 제목
    eventContent: (arg) => {
      if (arg.view.type.startsWith('list')) return undefined;
      const wrap = el('div', { className: 'evc' }, el('b', { textContent: `${arg.timeText ? arg.timeText + ' ' : ''}${arg.event.title}` }));
      return { domNodes: [wrap] };
    },
    eventDidMount: ({ el: node, event }) => {
      node.style.borderLeft = `3px solid ${event.extendedProps.status === 'cancelled' ? '#9ca3af' : event.color || '#64748b'}`;
      const x = event.extendedProps;
      node.title = [event.title, x.location && `장소 ${x.location}`].filter(Boolean).join('\n');
    },
    // 날짜를 클릭하거나 여러 날/시간대를 드래그하면 그 자리에서 바로 일정을 등록할 수 있다
    select: (info) => {
      const { start, end, allDay, jsEvent } = info;
      const oneDay = allDay && end - start <= 86400000;
      cal.unselect();
      if (oneDay) selectDate(start);
      openQuick({
        allDay: allDay && !oneDay,
        startDate: dateStr(start),
        endDate: allDay ? dateStr(new Date(end.getTime() - 86400000)) : dateStr(end),
        st: allDay ? '09:00' : `${pad(start.getHours())}:${pad(start.getMinutes())}`,
        et: allDay ? '10:00' : `${pad(end.getHours())}:${pad(end.getMinutes())}`,
        x: jsEvent?.clientX, y: jsEvent?.clientY,
      });
    },
    eventClick: (info) => {
      info.jsEvent.preventDefault();
      openEvent(info.event.extendedProps, info.event.allDay);
    },
    eventDrop: onMove,
    eventResize: onMove,
    datesSet: () => setTimeout(markSelected),
    eventsSet: () => setTimeout(markSelected),
  });
  cal.render();
  renderList();
}

async function onMove(info) {
  const ev = info.event;
  const x = ev.extendedProps;
  if (!x.canEdit) {
    info.revert();
    return toast('이 일정을 수정할 권한이 없습니다.', true);
  }
  let scope = 'all';
  if (x.recur) {
    scope = await askScope('일정 이동');
    if (!scope) return info.revert();
  }
  const allDay = ev.allDay;
  const start = allDay ? dateStr(ev.start) : localStr(ev.start);
  const end = allDay
    ? dateStr(ev.end ? new Date(ev.end.getTime() - 86400000) : ev.start)
    : localStr(ev.end || new Date(ev.start.getTime() + 3600000));
  try {
    await api(`/api/events/${x.eventId}`, {
      method: 'PUT',
      body: {
        title: x.rawTitle, category: x.category, urgent: x.urgent, importance: x.importance, kind: x.kind, visibility: x.visibility, edit_perm: x.editPerm, assignee_id: x.assigneeId,
        all_day: allDay, start, end, location: x.location, memo: x.memo, recur: x.recur, attendees: x.attendees, alarms: x.alarms, scope, occ: x.occ,
      },
    });
    refresh();
  } catch (e) {
    info.revert();
    toast(e.message, true);
  }
}

$('#btn-new').onclick = () => {
  const s = new Date();
  s.setMinutes(0, 0, 0);
  s.setHours(s.getHours() + 1);
  openDialog({ start: localStr(s), end: localStr(new Date(s.getTime() + 3600000)), all_day: false });
};
$('#btn-export').onclick = () => {
  const v = cal.view;
  const q = new URLSearchParams({ start: localStr(v.currentStart), end: localStr(v.currentEnd), users: users.filter((u) => userPasses(u.id)).map((u) => u.id).join(',') });
  location.href = '/api/export?' + q;
};

// ---------- 엑셀 업로드 ----------
const idlg = $('#import-dialog');
let importRows = [];
$('#btn-import').onclick = () => {
  $('#import-file').value = '';
  $('#import-summary').classList.add('hidden');
  $('#import-table-wrap').classList.add('hidden');
  $('#import-rows').replaceChildren();
  $('#import-count').textContent = '';
  $('#import-go').disabled = true;
  importRows = [];
  idlg.showModal();
};
$('#import-close').onclick = $('#import-cancel').onclick = () => idlg.close();

function updateImportCount() {
  const n = [...document.querySelectorAll('#import-rows input[type=checkbox]:checked')].length;
  $('#import-count').textContent = importRows.length ? `선택 ${n}건` : '';
  $('#import-go').disabled = n === 0;
  $('#import-go').textContent = n ? `선택한 ${n}건 등록` : '선택한 일정 등록';
}

$('#import-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const data = await api('/api/import/preview', { method: 'POST', body: fd });
    importRows = data.rows;
    const bad = data.total - data.ok;
    const sum = $('#import-summary');
    sum.textContent = `총 ${data.total}행 · 등록 가능 ${data.ok}건${bad ? ` · 오류 ${bad}건(등록되지 않음)` : ''}${importRows.some((r) => r.dup) ? ' · 중복 의심 일정은 기본으로 선택 해제됩니다' : ''}`;
    sum.classList.remove('hidden');
    const tb = $('#import-rows');
    tb.replaceChildren();
    for (const r of importRows) {
      const p = r.preview;
      const ok = !r.errors.length;
      const cb = el('input', { type: 'checkbox', checked: ok && !r.dup, disabled: !ok });
      cb.onchange = updateImportCount;
      const when = p.start ? (p.all_day ? `${p.start}${p.end !== p.start ? ' ~ ' + p.end : ''} (종일)` : `${p.start.replace('T', ' ')} ~ ${p.end.slice(p.end.slice(0, 10) === p.start.slice(0, 10) ? 11 : 0).replace('T', ' ')}`) : '';
      const who = [p.assignee && `담당 ${p.assignee}`, p.attendees.length && `참석 ${p.attendees.join(', ')}`, p.recur && `반복 ${p.recur}`].filter(Boolean).join(' · ');
      const status = el('td');
      if (!ok) r.errors.forEach((m) => status.append(el('div', { className: 'err', textContent: `⚠ ${m}` })));
      else status.append(el('div', { className: r.dup ? 'warn' : 'okc', textContent: r.dup ? '중복 의심 (같은 제목·시작)' : '✔ 등록 가능' }));
      r.warnings.forEach((m) => status.append(el('div', { className: 'warn', textContent: m })));
      tb.append(
        el('tr', { className: !ok ? 'bad' : r.dup ? 'dup' : '' },
          el('td', {}, cb), el('td', { textContent: r.row }),
          el('td', { textContent: `${p.urgent ? '🔥 ' : ''}${p.importance === 2 ? '⭐ ' : ''}${p.title}` }),
          el('td', { textContent: when }),
          el('td', { textContent: `${p.kind === 'team' ? '팀' : '개인'} · ${p.category}` }),
          el('td', { textContent: who }), status),
      );
    }
    $('#import-table-wrap').classList.remove('hidden');
    $('#import-all').checked = true;
    updateImportCount();
  } catch (err) {
    e.target.value = '';
    if (err.code === 'training_file') {
      // 교육계획 파일을 일정 업로드에 올린 경우: 교육 현황으로 바로 불러오도록 안내
      if (me.role !== 'admin') return toast('교육계획 파일입니다. 관리자가 📚 교육 현황 메뉴에서 업로드해야 합니다.', true);
      if (confirm('이 파일은 일정이 아니라 교육계획 파일입니다.\n📚 교육 현황으로 불러올까요?')) {
        idlg.close();
        setView('edu');
        return importTrainingFile(file);
      }
      return;
    }
    toast(err.message, true);
  }
};
$('#import-all').onchange = (e) => {
  document.querySelectorAll('#import-rows input[type=checkbox]:not(:disabled)').forEach((c) => (c.checked = e.target.checked));
  updateImportCount();
};
$('#import-go').onclick = async () => {
  const boxes = [...document.querySelectorAll('#import-rows input[type=checkbox]')];
  const rows = importRows.filter((r, i) => boxes[i]?.checked && !r.errors.length).map((r) => r.body);
  if (!rows.length) return;
  $('#import-go').disabled = true;
  try {
    const res = await api('/api/import/commit', { method: 'POST', body: { rows } });
    if (res.failed.length) toast(`${res.created}건 등록, ${res.failed.length}건 실패: ${res.failed[0].error}`, true);
    else toast(`${res.created}건의 일정을 등록했습니다.`);
    idlg.close();
    refresh();
  } catch (err) {
    toast(err.message, true);
    $('#import-go').disabled = false;
  }
};

// ---------- 빠른 일정 등록 ----------
const quick = $('#quick-add');
const Q = (n) => quick.elements[n];
let quickCtx = null;

function openQuick(c) {
  quickCtx = c;
  quick.reset();
  Q('all_day').checked = c.allDay;
  Q('st').value = c.st;
  Q('et').value = c.et;
  syncQuick();
  quick.classList.remove('hidden');
  // 클릭한 위치 근처에 띄우되 화면 밖으로 나가지 않게 조정
  const w = quick.offsetWidth;
  const h = quick.offsetHeight;
  const x = Math.min(Math.max(8, (c.x ?? innerWidth / 2 - w / 2) + 10), innerWidth - w - 8);
  const y = Math.min(Math.max(8, (c.y ?? innerHeight / 3) + 10), innerHeight - h - 8);
  quick.style.left = x + 'px';
  quick.style.top = y + 'px';
  Q('title').focus();
}
function closeQuick() {
  quick.classList.add('hidden');
  quickCtx = null;
}
function syncQuick() {
  const c = quickCtx;
  const range = c.startDate === c.endDate || !Q('all_day').checked ? c.startDate : `${c.startDate} ~ ${c.endDate}`;
  const d = toDate(c.startDate);
  $('#quick-date').textContent = `${range} (${DAYNAMES[d.getDay()]})`;
  quick.querySelector('.quick-times').classList.toggle('hidden', Q('all_day').checked);
}
Q('all_day').onchange = syncQuick;
$('#quick-close').onclick = closeQuick;
document.addEventListener('keydown', (e) => e.key === 'Escape' && quickCtx && closeQuick());
document.addEventListener('mousedown', (e) => {
  if (quickCtx && !e.target.closest('#quick-add') && !e.target.closest('#calendar') && !e.target.closest('dialog')) closeQuick();
});

function quickValues() {
  const c = quickCtx;
  const all_day = Q('all_day').checked;
  const mode = Q('mode').value;
  const kind = mode === 'team' ? 'team' : 'personal';
  const visibility = mode === 'personal-me' ? 'me' : 'team';
  return {
    title: Q('title').value.trim(), category: '기타', urgent: Q('urgent').checked, importance: Q('important').checked ? 2 : 1,
    kind, visibility, edit_perm: kind === 'team' ? 'attendees' : 'owner',
    all_day,
    start: all_day ? c.startDate : `${c.startDate}T${Q('st').value}`,
    end: all_day ? c.endDate : `${c.endDate}T${Q('et').value}`,
    location: '', memo: '', attendees: [], alarms: [10], recur: null, assignee_id: null,
  };
}

quick.onsubmit = async (e) => {
  e.preventDefault();
  const body = quickValues();
  if (!body.title) return Q('title').focus();
  if (!body.all_day && body.end <= body.start) {
    // 종료가 시작보다 이르거나 같으면 1시간 뒤로 맞춘다
    body.end = localStr(new Date(toDate(body.start).getTime() + 3600000));
  }
  try {
    await api('/api/events', { method: 'POST', body });
    closeQuick();
    refresh();
    toast('일정이 등록되었습니다.');
  } catch (err) {
    toast(err.message, true);
  }
};

// 입력하던 내용을 그대로 가지고 상세 등록 창으로 이동
$('#quick-detail').onclick = () => {
  const b = quickValues();
  closeQuick();
  openDialog({ ...b, kind: b.kind, visibility: b.visibility });
  F('title').value = b.title;
};

// ---------- 검색 / 필터 ----------
const sdlg = $('#search-dialog');
$('#btn-search').onclick = () => {
  fillUserSelects();
  sdlg.showModal();
  $('#search-form').elements.q.focus();
};
$('#search-close').onclick = () => sdlg.close();
$('#search-reset').onclick = () => {
  $('#search-results').replaceChildren();
  $('#search-count').textContent = '';
};
$('#search-form').onsubmit = async (e) => {
  e.preventDefault();
  const q = new URLSearchParams();
  for (const [k, v] of new FormData(e.target)) if (v) q.set(k, v);
  try {
    const { total, items } = await api('/api/search?' + q);
    $('#search-count').textContent = total ? `${total}건${total > items.length ? ` (처음 ${items.length}건만 표시)` : ''}` : '조건에 맞는 일정이 없습니다.';
    const ul = el('ul', { className: 'agenda' });
    for (const r of items) ul.append(agendaItem(decorate(r), { dateLabel: true }));
    $('#search-results').replaceChildren(ul);
  } catch (err) {
    toast(err.message, true);
  }
};

// ---------- 반복 범위 선택 ----------
function askScope(action, { future = true } = {}) {
  return new Promise((resolve) => {
    const dlg = $('#scope-dialog');
    $('#scope-title').textContent = `반복 일정 ${action}`;
    $('#scope-future').classList.toggle('hidden', !future);
    const done = (v) => {
      dlg.close();
      dlg.querySelectorAll('button').forEach((b) => (b.onclick = null));
      resolve(v);
    };
    dlg.querySelectorAll('button').forEach((b) => (b.onclick = () => done(b.dataset.scope)));
    dlg.oncancel = () => done('');
    dlg.showModal();
  });
}

// ---------- 일정 모달 ----------
const dlg = $('#event-dialog');
const form = $('#event-form');
const F = (name) => form.elements[name];

function setDateInputs(allDay, start, end) {
  F('start').type = F('end').type = allDay ? 'date' : 'datetime-local';
  F('start').value = allDay ? start.slice(0, 10) : start;
  F('end').value = allDay ? end.slice(0, 10) : end;
}

function syncRecur() {
  const freq = F('freq').value;
  const on = !!freq;
  $('#interval-wrap').classList.toggle('hidden', !on);
  $('#recur-end').classList.toggle('hidden', !on);
  $('#weekdays').classList.toggle('hidden', freq !== 'weekly');
  $('#monthly-mode').classList.toggle('hidden', freq !== 'monthly');
  $('#interval-unit').textContent = { daily: '일', weekly: '주', monthly: '개월', yearly: '년' }[freq] || '';
  $('#until-wrap').classList.toggle('hidden', !on || F('endType').value !== 'until');
  $('#count-wrap').classList.toggle('hidden', !on || F('endType').value !== 'count');
  if (freq === 'weekly' && !form.querySelectorAll('[name=wd]:checked').length && F('start').value) {
    const box = form.querySelector(`[name=wd][value="${toDate(F('start').value).getDay()}"]`);
    if (box) box.checked = true;
  }
}
F('freq').onchange = syncRecur;
F('endType').onchange = syncRecur;

F('all_day').onchange = () => {
  const s = F('start').value;
  const e = F('end').value;
  if (F('all_day').checked) setDateInputs(true, s, e);
  else setDateInputs(false, s.slice(0, 10) + 'T09:00', e.slice(0, 10) + 'T10:00');
  scheduleConflicts();
};

// 시작을 바꾸면 기존 길이를 유지하도록 종료도 함께 이동
let prevStart = null;
F('start').onfocus = () => (prevStart = F('start').value);
F('start').onchange = () => {
  if (prevStart && F('start').value && F('end').value) {
    const diff = toDate(F('end').value) - toDate(prevStart);
    const ns = toDate(F('start').value);
    const ne = new Date(ns.getTime() + Math.max(0, diff));
    F('end').value = F('all_day').checked ? dateStr(ne) : localStr(ne);
  }
  prevStart = F('start').value;
  syncRecur();
  scheduleConflicts();
};
F('end').onchange = scheduleConflicts;
F('assignee_id').onchange = scheduleConflicts;

// 일정 종류에 따라 공개 범위/수정 권한 선택지를 제한하고 기본값을 맞춘다
function syncKind(applyDefaults) {
  const team = F('kind').value === 'team';
  const vis = F('visibility');
  const perm = F('edit_perm');
  if (applyDefaults) {
    vis.value = team ? 'team' : 'me';
    perm.value = team ? 'attendees' : 'owner';
  }
  vis.querySelector('[value=me]').disabled = team;
  if (team && vis.value === 'me') vis.value = 'attendees';
  perm.querySelector('[value=team]').disabled = vis.value !== 'team';
  if (perm.value === 'team' && vis.value !== 'team') perm.value = 'attendees';
  if (!team) perm.value = 'owner';
  $('#perm-hint').textContent = team
    ? '팀 일정: 팀원과 함께하는 일정입니다. 수정 권한을 "등록자 + 참석자·담당자"로 두면 참석자도 내용을 고칠 수 있습니다. (삭제·공개/권한 변경은 등록자만 가능)'
    : '개인 일정: 내 업무 일정입니다. 수정·삭제는 등록자(와 관리자)만 할 수 있습니다.';
}
F('kind').onchange = () => syncKind(true);
F('visibility').onchange = () => syncKind(false);

// ----- 일정 겹침 안내 -----
let conflictTimer = null;
function scheduleConflicts() {
  clearTimeout(conflictTimer);
  conflictTimer = setTimeout(checkConflicts, 400);
}
async function checkConflicts() {
  const box = $('#conflict-box');
  if (!dlg.open || !current || (current.id && !current.canEdit)) return box.classList.add('hidden');
  const b = collect();
  try {
    const list = await api('/api/conflicts', {
      method: 'POST',
      body: { start: b.start, end: b.end, all_day: b.all_day, attendees: b.attendees, assignee_id: b.assignee_id, exclude_id: current.id || null },
    });
    if (!list.length) return box.classList.add('hidden');
    box.replaceChildren(
      el('b', { textContent: '⚠ 같은 시간에 겹치는 일정이 있습니다 (안내)' }),
      ...list.map((c) => el('span', { textContent: `${c.who.join(', ')} · ${c.title} (${c.all_day ? c.start + ' 종일' : c.start.replace('T', ' ') + ' ~ ' + c.end.slice(11)})` })),
    );
    box.classList.remove('hidden');
  } catch {
    box.classList.add('hidden');
  }
}

// ----- 참석 현황 / 내 응답 -----
function renderAttendance(d) {
  const box = $('#attendance');
  const ids = d.attendees || [];
  box.classList.toggle('hidden', !d.id || !ids.length);
  box.replaceChildren(...ids.map((id) => el('span', { className: `att ${d.responses?.[id] || 'pending'}`, textContent: `${userName(id)} ${RESP_LABEL[d.responses?.[id] || 'pending']}` })));
  const mine = $('#my-response');
  const show = !!d.id && d.myResponse !== null && d.myResponse !== undefined && d.status !== 'cancelled';
  mine.classList.toggle('hidden', !show);
  mine.querySelectorAll('.resp').forEach((b) => b.classList.toggle('on', b.dataset.r === d.myResponse));
}
$('#my-response').onclick = async (e) => {
  const b = e.target.closest('.resp');
  if (!b || !current?.id) return;
  try {
    await api(`/api/events/${current.id}/respond`, { method: 'POST', body: { response: b.dataset.r } });
    current.myResponse = b.dataset.r;
    current.responses = { ...current.responses, [me.id]: b.dataset.r };
    renderAttendance(current);
    refresh();
    toast('응답이 저장되었습니다.');
  } catch (err) {
    toast(err.message, true);
  }
};

// ----- 댓글 / 이력 -----
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
  $('#tab-comments').classList.toggle('hidden', name !== 'comments');
  $('#tab-history').classList.toggle('hidden', name !== 'history');
  if (name === 'history') loadHistory();
}
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));

async function loadComments() {
  if (!current?.id) return;
  const id = current.id;
  const list = await api(`/api/events/${id}/comments`);
  if (current?.id !== id) return;
  $('#comment-count').textContent = list.length ? `(${list.length})` : '';
  $('#comment-list').replaceChildren(
    ...(list.length ? list : []).map((c) => {
      const li = el('li', {}, el('div', { className: 'who' }, el('b', { textContent: c.name }), el('span', { textContent: ago(sqlTime(c.created_at)) })), el('div', { className: 'body', textContent: c.body }));
      if (c.canDelete) {
        const del = el('button', { type: 'button', className: 'icon', textContent: '✕', title: '댓글 삭제' });
        del.onclick = async () => {
          if (!confirm('댓글을 삭제할까요?')) return;
          await api(`/api/comments/${c.id}`, { method: 'DELETE' }).catch((e) => toast(e.message, true));
          loadComments();
          refresh();
        };
        li.querySelector('.who').append(el('span', { className: 'spacer' }), del);
      }
      return li;
    }),
  );
  if (!list.length) $('#comment-list').replaceChildren(el('li', { className: 'muted', textContent: '아직 댓글이 없습니다.' }));
}
async function loadHistory() {
  if (!current?.id) return;
  const id = current.id;
  const list = await api(`/api/events/${id}/history`);
  if (current?.id !== id) return;
  const label = { created: '등록', updated: '변경', cancelled: '취소', done: '종료', restored: '복원', response: '응답', comment: '댓글' };
  $('#tab-history').replaceChildren(
    ...(list.length
      ? list.map((h) =>
          el('li', { className: h.action }, el('div', { className: 'h', textContent: `${sqlTime(h.created_at).toLocaleString('ko-KR', { hour12: false })} · ${h.name || '시스템'} · ${label[h.action] || h.action}` }), el('div', { className: 'd', textContent: h.detail })),
        )
      : [el('li', { className: 'muted', textContent: '이력이 없습니다.' })]),
  );
}
async function sendComment() {
  const input = $('#comment-input');
  const body = input.value.trim();
  if (!body || !current?.id) return;
  try {
    await api(`/api/events/${current.id}/comments`, { method: 'POST', body: { body } });
    input.value = '';
    loadComments();
    refresh();
  } catch (e) {
    toast(e.message, true);
  }
}
$('#comment-send').onclick = sendComment;
$('#comment-input').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendComment();
  }
};

function openDialog(d) {
  current = d;
  form.reset();
  const editing = !!d.id;
  const canEdit = !editing || d.canEdit;
  const canManage = !editing || d.canManage;
  $('#dlg-title').textContent = editing ? (canEdit ? '일정 수정' : '일정 보기') : '새 일정';
  F('title').value = d.title || '';
  F('category').value = d.category || '기타';
  F('kind').value = d.kind || 'personal';
  F('visibility').value = d.visibility || (F('kind').value === 'team' ? 'team' : 'me');
  F('edit_perm').value = d.edit_perm || (F('kind').value === 'team' ? 'attendees' : 'owner');
  syncKind(false);
  F('all_day').checked = !!d.all_day;
  setDateInputs(!!d.all_day, d.start, d.end);
  F('location').value = d.location || '';
  F('memo').value = d.memo || '';
  F('assignee_id').value = d.assignee_id ? String(d.assignee_id) : '';
  F('urgent').checked = !!d.urgent;
  F('importance').value = String(d.importance ?? 1);
  const banner = $('#cancel-banner');
  banner.classList.toggle('hidden', !d.status || d.status === 'active');
  banner.classList.toggle('done', d.status === 'done');
  banner.textContent = d.status === 'cancelled' ? '🚫 취소된 일정입니다. 위의 "일정 취소" 체크를 해제하면 복원됩니다.' : '✅ 종료(완료)된 일정입니다. 위의 "일정 종료" 체크를 해제하면 다시 진행 중이 됩니다.';
  $('#status-row').classList.toggle('hidden', !editing || !canEdit);
  $('#chk-done').checked = d.status === 'done';
  $('#chk-cancel').checked = d.status === 'cancelled';

  // 참석자 (등록자 제외)
  const ownerId = editing ? d.ownerId : me.id;
  const att = $('#attendee-list');
  att.replaceChildren(
    ...users
      .filter((u) => u.id !== ownerId)
      .map((u) => {
        const cb = el('input', { type: 'checkbox', name: 'at', value: u.id, checked: (d.attendees || []).includes(u.id) });
        cb.onchange = scheduleConflicts;
        return el('label', {}, cb, u.name);
      }),
  );
  if (users.length < 2) att.textContent = '다른 팀원이 없습니다.';
  renderAttendance(d);

  // 알람
  const alarms = new Set(d.alarms || (editing ? [] : [10]));
  const presets = [...ALARM_PRESETS];
  for (const m of alarms) if (!presets.some((p) => p[0] === m)) presets.push([m, `${m}분 전`]);
  $('#alarm-list').replaceChildren(
    ...presets.map(([m, label]) => el('label', {}, el('input', { type: 'checkbox', name: 'al', value: m, checked: alarms.has(m) }), label)),
  );

  // 반복
  $('#weekdays').replaceChildren(...DAYNAMES.map((n, i) => el('label', {}, el('input', { type: 'checkbox', name: 'wd', value: i }), n)));
  const r = d.recur;
  F('freq').value = r?.freq || '';
  F('interval').value = r?.interval || 1;
  (r?.weekdays || []).forEach((w) => {
    const b = form.querySelector(`[name=wd][value="${w}"]`);
    if (b) b.checked = true;
  });
  form.querySelectorAll('[name=monthlyMode]').forEach((x) => (x.checked = x.value === (r?.monthlyMode || 'date')));
  F('endType').value = r?.endType || 'never';
  F('until').value = r?.until || '';
  F('count').value = r?.count || 10;
  syncRecur();

  // 첨부파일
  const list = $('#attachment-list');
  list.replaceChildren(
    ...(d.attachments || []).map((a) => {
      const who = [fmtSize(a.size), a.uploader && `올린 사람 ${a.uploader}`, a.uploadedAt && fmtStamp(a.uploadedAt)].filter(Boolean).join(' · ');
      const li = el('li', {}, el('a', { href: `/api/attachments/${a.id}`, textContent: `📎 ${a.filename}` }), el('span', { className: 'muted small', textContent: who }));
      if (canEdit) {
        const del = el('button', { type: 'button', className: 'icon', textContent: '✕', title: '파일 삭제' });
        del.onclick = async () => {
          if (!confirm(`"${a.filename}" 파일을 삭제할까요?`)) return;
          try {
            await api(`/api/attachments/${a.id}`, { method: 'DELETE' });
            li.remove();
            d.attachments = d.attachments.filter((x) => x.id !== a.id);
            refresh();
          } catch (e) {
            toast(e.message, true);
          }
        };
        li.append(del);
      }
      return li;
    }),
  );
  $('#file-input').value = '';
  $('#file-input').classList.toggle('hidden', !canEdit);
  $('#owner-info').textContent = editing
    ? `등록자: ${d.ownerName}${d.lastEditor ? ` · 최근 변경: ${d.lastEditor}${d.lastEditedAt ? ' (' + fmtStamp(d.lastEditedAt) + ')' : ''}` : ''}`
    : '';

  // 버튼 / 입력 잠금
  $('#btn-delete').classList.toggle('hidden', !editing || !canManage);
  $('#btn-copy').classList.toggle('hidden', !editing);
  $('#btn-link').classList.toggle('hidden', !editing);
  $('#btn-save').classList.toggle('hidden', !canEdit);
  form.querySelectorAll('input, select, textarea').forEach((x) => {
    if (!x.closest('#collab') && !x.closest('#status-row')) x.disabled = !canEdit;
  });
  // 종류·공개 범위·수정 권한은 등록자(관리자)만 변경 가능, 개인 일정의 수정 권한은 항상 '등록자만'
  for (const n of ['kind', 'visibility', 'edit_perm']) F(n).disabled = !canEdit || !canManage;
  if (F('kind').value === 'personal') F('edit_perm').disabled = true;

  // 댓글 / 이력
  $('#collab').classList.toggle('hidden', !editing);
  $('#comment-count').textContent = d.commentCount ? `(${d.commentCount})` : '';
  $('#conflict-box').classList.add('hidden');
  if (editing) {
    showTab('comments');
    $('#comment-input').value = '';
    loadComments().catch(() => {});
  }
  dlg.showModal();
  if (!editing) F('title').focus();
  scheduleConflicts();
}

const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB');

function collect() {
  const freq = F('freq').value;
  return {
    title: F('title').value,
    category: F('category').value,
    urgent: F('urgent').checked,
    importance: +F('importance').value,
    kind: F('kind').value,
    visibility: F('visibility').value,
    edit_perm: F('edit_perm').value,
    assignee_id: F('assignee_id').value || null,
    all_day: F('all_day').checked,
    start: F('start').value,
    end: F('end').value,
    location: F('location').value,
    memo: F('memo').value,
    attendees: [...form.querySelectorAll('[name=at]:checked')].map((x) => +x.value),
    alarms: [...form.querySelectorAll('[name=al]:checked')].map((x) => +x.value),
    recur: freq
      ? {
          freq,
          interval: +F('interval').value || 1,
          weekdays: [...form.querySelectorAll('[name=wd]:checked')].map((x) => +x.value),
          monthlyMode: form.querySelector('[name=monthlyMode]:checked').value,
          endType: F('endType').value,
          until: F('until').value || null,
          count: +F('count').value || null,
        }
      : null,
  };
}

const closeDialog = () => dlg.close();
$('#dlg-close').onclick = closeDialog;
$('#btn-cancel').onclick = closeDialog;

form.onsubmit = async (e) => {
  e.preventDefault();
  const d = current;
  const body = collect();
  try {
    let id;
    if (d.id) {
      let scope = 'all';
      if (d.recur) {
        scope = await askScope('수정');
        if (!scope) return;
      }
      ({ id } = await api(`/api/events/${d.id}`, { method: 'PUT', body: { ...body, scope, occ: d.occ } }));
    } else {
      ({ id } = await api('/api/events', { method: 'POST', body }));
    }
    const files = $('#file-input').files;
    if (files.length) {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      await api(`/api/events/${id}/attachments`, { method: 'POST', body: fd });
    }
    closeDialog();
    refresh();
    toast('저장되었습니다.');
  } catch (err) {
    toast(err.message, true);
  }
};

// 일정 창의 종료/취소 체크박스: 체크하면 바로 상태가 바뀌고, 둘은 동시에 선택되지 않는다
async function dialogStatus(status) {
  const d = current;
  const ok = await changeStatus({ eventId: d.id, occ: d.occ, recur: d.recur, status: d.status }, status);
  if (ok) {
    closeDialog();
    refresh();
    afterStatusChange?.();
  } else {
    $('#chk-done').checked = d.status === 'done';
    $('#chk-cancel').checked = d.status === 'cancelled';
  }
}
$('#chk-done').onchange = (e) => dialogStatus(e.target.checked ? 'done' : 'active');
$('#chk-cancel').onchange = (e) => dialogStatus(e.target.checked ? 'cancelled' : 'active');

$('#btn-delete').onclick = async () => {
  const d = current;
  let scope = 'all';
  if (d.recur) {
    scope = await askScope('삭제');
    if (!scope) return;
  } else if (!confirm('이 일정을 완전히 삭제할까요? (취소와 달리 복원할 수 없습니다)')) return;
  try {
    await api(`/api/events/${d.id}?scope=${scope}&occ=${encodeURIComponent(d.occ)}`, { method: 'DELETE' });
    closeDialog();
    refresh();
    toast('삭제되었습니다.');
  } catch (err) {
    toast(err.message, true);
  }
};

start();
