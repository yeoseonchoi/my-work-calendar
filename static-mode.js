// 서버 없는 버전(GitHub Pages)의 화면 조정. app.js 뒤에 불러온다.
(function () {
  const $ = (s) => document.querySelector(s);
  const API = window.LocalApi;
  const GH = window.GhSync;
  document.body.classList.add('static');

  // 서버가 있어야 하는 화면 요소는 가린다
  const hide = (el) => el && (el.style.display = 'none');
  hide($('#attachment-list') && $('#attachment-list').closest('fieldset'));
  const sepData = [...document.querySelectorAll('.menu-sep')].find((x) => x.textContent.trim() === '데이터');
  if (sepData) sepData.textContent = '백업';
  const setLabel = (sel, text) => {
    const s = $(sel + ' span');
    if (s) s.textContent = text;
  };
  setLabel('#btn-export', '백업 내려받기');
  setLabel('#btn-import', '백업 불러오기');
  const legend = [...document.querySelectorAll('legend')].find((l) => l.textContent.includes('알람'));
  if (legend) legend.textContent = '알람 (브라우저 알림)';

  // ───────── 백업 (JSON 파일) ─────────
  const today = () => new Date().toISOString().slice(0, 10);
  function backupDownload() {
    const blob = new Blob([JSON.stringify(API.getData(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `업무캘린더_백업_${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('백업 파일을 내려받았습니다.');
  }
  function backupPick() {
    $('#static-restore-file').click();
  }
  $('#btn-export').onclick = backupDownload;
  $('#btn-import').onclick = backupPick;
  $('#static-backup').onclick = backupDownload;
  $('#static-restore').onclick = backupPick;
  $('#static-restore-file').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const obj = JSON.parse(await f.text());
      if (!confirm('지금 데이터가 백업 파일의 내용으로 바뀝니다. 계속할까요?')) return;
      API.replaceData(obj);
      toast('백업을 불러왔습니다. 화면을 새로 고칩니다.');
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      toast(err.message || '백업 파일을 읽을 수 없습니다.', true);
    }
  };

  // ───────── 이름 (처음 한 번) ─────────
  function nameDialog() {
    let d = $('#name-dialog');
    if (!d) {
      d = document.createElement('dialog');
      d.id = 'name-dialog';
      d.className = 'mood';
      d.innerHTML = `<form class="mood-box" method="dialog">
        <h3>처음 오셨네요 👋</h3>
        <p class="muted">인사말에 쓸 이름을 알려 주세요. 나중에 설정에서 바꿀 수 있어요.</p>
        <input id="name-input" maxlength="30" placeholder="예: 최여선" autocomplete="off" style="font-size:16px;padding:12px 14px;border-radius:12px;text-align:center">
        <button type="submit" class="btn primary" style="margin-top:10px">시작하기</button>
      </form>`;
      document.body.append(d);
      d.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        const v = d.querySelector('#name-input').value.trim();
        if (!v) return;
        API.setName(v);
        d.close();
        await reloadMe();
        if (window.openMood) window.openMood();
      };
      d.oncancel = (e) => e.preventDefault(); // 이름을 정하기 전에는 닫을 수 없다
    }
    d.showModal();
    d.querySelector('#name-input').focus();
  }
  async function reloadMe() {
    me = await api('/api/me');
    paintMe();
    refresh();
  }
  setTimeout(() => {
    if (API.hasName()) return;
    const md = $('#mood-dialog');
    if (md && md.open) md.close();
    nameDialog();
  }, 700);
  $('#static-name').addEventListener('change', async (e) => {
    const v = e.target.value.trim();
    if (!v) return;
    await api('/api/me/profile', { method: 'PUT', body: { name: v } });
    await reloadMe();
    toast('이름을 바꿨습니다.');
  });

  // ───────── GitHub 동기화 ─────────
  const STATE_TEXT = {
    off: 'GitHub 연결 안 됨 — 이 브라우저에만 저장됩니다.',
    pending: '변경 사항을 저장하려고 기다리는 중…',
    syncing: '동기화하는 중…',
  };
  function paintStatus() {
    const s = API.sync.state();
    let text = GH.isOn() ? '' : STATE_TEXT.off;
    if (GH.isOn()) {
      if (s.status === 'ok') text = `✅ ${new Date(s.at).toLocaleString('ko-KR')} 에 동기화되었습니다.`;
      else if (s.status === 'error') text = `⚠️ ${s.message}`;
      else text = STATE_TEXT[s.status] || '연결됨 — 아직 동기화 전입니다.';
    }
    $('#sync-status').textContent = text;
  }
  API.sync.onChange(paintStatus);

  function fillSettings() {
    $('#static-name').value = API.getData().name || '';
    const c = GH.config() || {};
    $('#sync-owner').value = c.owner || '';
    $('#sync-repo').value = c.repo || '';
    $('#sync-path').value = c.path || 'calendar-data.json';
    $('#sync-branch').value = c.branch || '';
    $('#sync-token').value = c.token ? '••••••••' : '';
    paintStatus();
  }
  $('#btn-settings').addEventListener('click', fillSettings);

  $('#sync-save').onclick = async () => {
    const prev = GH.config();
    let token = $('#sync-token').value.trim();
    if (token.startsWith('•')) token = prev ? prev.token : '';
    const cfg = { owner: $('#sync-owner').value, repo: $('#sync-repo').value, path: $('#sync-path').value || 'calendar-data.json', branch: $('#sync-branch').value, token };
    if (!cfg.owner.trim() || !cfg.repo.trim() || !cfg.token) return toast('저장소 주인, 저장소 이름, 토큰을 모두 입력하세요.', true);
    GH.setConfig(cfg);
    try {
      const isPublic = await GH.isPublic();
      if (isPublic && !confirm('⚠️ 이 저장소는 "공개(public)"입니다.\n일정·만료일 등 개인 데이터가 인터넷에 그대로 공개됩니다.\n\n그래도 이 저장소에 저장할까요? (비공개 저장소를 쓰시길 권합니다)')) {
        GH.setConfig(prev);
        fillSettings();
        return;
      }
      const changed = await API.sync.now({ firstLink: true });
      paintStatus();
      if (changed) {
        toast('저장소의 데이터를 불러왔습니다. 화면을 새로 고칩니다.');
        setTimeout(() => location.reload(), 900);
      } else toast('GitHub 저장소와 연결했습니다.');
    } catch (err) {
      GH.setConfig(prev);
      fillSettings();
      toast(err.message, true);
    }
  };
  $('#sync-now').onclick = async () => {
    if (!GH.isOn()) return toast('먼저 GitHub 저장소를 연결하세요.', true);
    const changed = await API.sync.now();
    paintStatus();
    if (changed) {
      toast('다른 기기의 변경 사항을 불러왔습니다.');
      refresh();
    } else if (API.sync.state().status === 'ok') toast('이미 최신입니다.');
  };
  $('#sync-off').onclick = () => {
    if (!GH.isOn()) return;
    if (!confirm('GitHub 연결을 해제할까요? (저장소의 파일은 지워지지 않고, 이 브라우저의 데이터도 그대로 남습니다)')) return;
    GH.setConfig(null);
    fillSettings();
    toast('연결을 해제했습니다.');
  };
  $('#static-notify').onclick = async () => {
    if (!('Notification' in window)) return toast('이 브라우저는 알림을 지원하지 않습니다.', true);
    const r = await Notification.requestPermission();
    toast(r === 'granted' ? '브라우저 알림을 켰습니다. 이 페이지가 열려 있는 동안 일정 알람이 울립니다.' : '알림이 허용되지 않았습니다. 브라우저 설정에서 허용해 주세요.', r !== 'granted');
  };

  // ───────── 주기 작업 ─────────
  // 페이지가 열려 있는 동안만 동작한다: 종료 일정 자동 체크 · 시작 전 알람 · 만료일 알림 (30초마다)
  setInterval(() => {
    if (API.tick() > 0) refresh();
  }, 30000);
  // 다른 기기에서 바꾼 내용을 가져온다 (2분마다, 그리고 이 탭으로 돌아왔을 때)
  async function pullIfIdle() {
    if (!GH.isOn() || API.sync.state().pending || document.querySelector('dialog[open]')) return;
    if (await API.sync.now()) refresh();
  }
  setInterval(pullIfIdle, 120000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pullIfIdle();
  });
  window.addEventListener('beforeunload', (e) => {
    if (GH.isOn() && API.sync.state().pending) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
})();
