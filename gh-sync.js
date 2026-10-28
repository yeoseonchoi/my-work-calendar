// GitHub 저장소 파일에 데이터를 저장·불러오는 부분 (서버 없는 버전용).
// 데이터는 "비공개(private) 저장소"의 JSON 파일에 저장하는 것을 전제로 한다. 토큰은 이 브라우저(localStorage)에만 보관된다.
(function () {
  const CFG_KEY = 'wc_sync_cfg';

  const config = () => {
    try {
      const c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
      return c && c.owner && c.repo && c.token ? c : null;
    } catch {
      return null;
    }
  };
  const setConfig = (c) => {
    try {
      if (!c) localStorage.removeItem(CFG_KEY);
      else localStorage.setItem(CFG_KEY, JSON.stringify({ owner: c.owner.trim(), repo: c.repo.trim(), path: (c.path || 'calendar-data.json').trim(), branch: (c.branch || '').trim(), token: c.token.trim() }));
    } catch {
      // 저장소를 쓸 수 없는 환경
    }
  };

  const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
  const unb64 = (s) => decodeURIComponent(escape(atob(s.replace(/\s/g, ''))));

  const url = (c) => `https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${c.path.split('/').map(encodeURIComponent).join('/')}`;
  const headers = (c, extra) => Object.assign({ Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, extra || {});

  async function check(res, what) {
    if (res.ok) return;
    let msg = '';
    try {
      msg = (await res.json()).message || '';
    } catch {
      // 본문이 없는 오류
    }
    const hint =
      res.status === 401 ? '토큰이 올바르지 않거나 만료되었습니다.'
      : res.status === 403 ? '권한이 없거나 요청 한도를 넘었습니다. 토큰에 "Contents: Read and write" 권한이 있는지 확인하세요.'
      : res.status === 404 ? '저장소를 찾을 수 없습니다. 이름과 토큰의 저장소 접근 권한을 확인하세요.'
      : '';
    const e = new Error(`${what} 실패 (${res.status}) ${hint || msg}`.trim());
    e.status = res.status;
    throw e;
  }

  // 반환: { found, data, sha }  (파일이 아직 없으면 found:false)
  async function pull() {
    const c = config();
    if (!c) throw new Error('GitHub 연결 정보가 없습니다.');
    const q = c.branch ? `?ref=${encodeURIComponent(c.branch)}` : '';
    const res = await fetch(url(c) + q, { headers: headers(c), cache: 'no-store' });
    if (res.status === 404) {
      // 저장소가 없는 건지 파일만 없는 건지 구분한다
      const repo = await fetch(`https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`, { headers: headers(c) });
      await check(repo, '저장소 확인');
      return { found: false, data: null, sha: null };
    }
    await check(res, '불러오기');
    const j = await res.json();
    let text;
    if (j.encoding === 'base64' && j.content) text = unb64(j.content);
    else {
      // 1MB 를 넘는 파일은 내용이 비어 오므로 원본으로 다시 받는다
      const raw = await fetch(url(c) + q, { headers: headers(c, { Accept: 'application/vnd.github.raw+json' }), cache: 'no-store' });
      await check(raw, '불러오기');
      text = await raw.text();
    }
    return { found: true, data: JSON.parse(text), sha: j.sha };
  }

  // 저장. sha 는 마지막으로 알고 있는 파일 버전 (새 파일이면 null). 반환: 새 sha
  async function push(data, sha) {
    const c = config();
    if (!c) throw new Error('GitHub 연결 정보가 없습니다.');
    const body = { message: `업무 캘린더 데이터 저장 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, content: b64(JSON.stringify(data)) };
    if (sha) body.sha = sha;
    if (c.branch) body.branch = c.branch;
    const res = await fetch(url(c), { method: 'PUT', headers: headers(c, { 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
    await check(res, '저장');
    return (await res.json()).content.sha;
  }

  // 저장소가 공개(public)인지 확인한다. 공개 저장소에 개인 일정을 올리면 누구나 볼 수 있으므로 경고하는 데 쓴다.
  async function isPublic() {
    const c = config();
    if (!c) return null;
    const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`, { headers: headers(c) });
    await check(res, '저장소 확인');
    const j = await res.json();
    return !j.private;
  }

  window.GhSync = { config, setConfig, pull, push, isPublic, isOn: () => !!config() };
})();
