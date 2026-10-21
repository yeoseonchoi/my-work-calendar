import ExcelJS from 'exceljs';

// ───────── 교육계획 엑셀 읽기 ─────────
// 헤더 이름 -> 필드. 공백·괄호 내용은 무시한다.
const ALIASES = {
  no: ['no.', 'no', '번호'],
  company: ['소속', '회사'],
  job: ['직종'],
  dept: ['부서'],
  rank: ['직급'],
  name: ['성명', '이름'],
  kind: ['필수교육구분', '교육구분', '구분'],
  org: ['교육기관'],
  course: ['교육과목', '과정명', '교육명'],
  days: ['기간'],
  hours: ['시간'],
  schedule: ['일정'],
  month: ['월'],
  cost: ['교육비'],
  result: ['실적'],
};
const norm = (s) => String(s ?? '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, '');

function cellValue(c) {
  let v = c?.value;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) v = v.result;
    else if ('richText' in v) v = v.richText.map((r) => r.text).join('');
    else if ('text' in v) v = v.text;
    else v = null; // 결과값이 없는 수식 등
  }
  return v ?? '';
}
const text = (v) => (v instanceof Date ? '' : String(v ?? '').trim());
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? '').replace(/[,\s원]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const p2 = (n) => String(n).padStart(2, '0');
function validDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 일정 문자열 해석. 예) "26.02.23~24." / "26.08.31~09.03" / "26.04.9~10" / "26.09-14~16" / "26.03" / "미정"
 * 반환: { month(0=미정), start, end, note }
 */
export function parseSchedule(raw, monthCol) {
  const colMonth = Number(String(monthCol ?? '').trim());
  const fallbackMonth = Number.isInteger(colMonth) && colMonth >= 1 && colMonth <= 12 ? colMonth : 0;
  const s0 = String(raw ?? '').trim();
  if (!s0 || s0 === '미정') return { month: fallbackMonth, start: null, end: null, note: s0 === '미정' || !s0 ? '일정 미정' : '' };
  const s = s0.replace(/\s+/g, '').replace(/-/g, '.');
  let m;
  // 시작 "yy.m.d" + (끝 없음 | "~d" | "~m.d")
  if ((m = /^(\d{2})\.(\d{1,2})\.(\d{1,2})(~(?:(\d{1,2})\.(\d{1,2})|(\d{1,2}))?)?\.?$/.exec(s))) {
    const y = 2000 + +m[1], mo = +m[2], d = +m[3];
    const eMo = m[5] ? +m[5] : mo;
    const eD = m[6] ? +m[6] : m[7] ? +m[7] : d;
    if (validDate(y, mo, d) && validDate(y, eMo, eD)) {
      return { month: mo, start: `${y}-${p2(mo)}-${p2(d)}`, end: `${y}-${p2(eMo)}-${p2(eD)}`, note: m[4] && !m[6] && !m[7] ? '종료일 미기재 (시작일만 반영)' : '' };
    }
  }
  if ((m = /^(\d{2})\.(\d{1,2})\.(\d{1,2})\.(\d{1,2})\.?$/.exec(s))) {
    // "26.03.10-11" 처럼 '-' 로 기간을 쓴 경우
    const y = 2000 + +m[1], mo = +m[2];
    if (validDate(y, mo, +m[3]) && validDate(y, mo, +m[4])) return { month: mo, start: `${y}-${p2(mo)}-${p2(+m[3])}`, end: `${y}-${p2(mo)}-${p2(+m[4])}`, note: '' };
  }
  if ((m = /^(\d{2})\.(\d{1,2})\.?$/.exec(s))) {
    const mo = +m[2];
    if (mo >= 1 && mo <= 12) return { month: mo, start: null, end: null, note: '월만 확정 (일자 미정)' };
  }
  return { month: fallbackMonth, start: null, end: null, note: `일정 형식 확인 필요: "${s0}"` };
}

/** 교육계획 엑셀(개인별 교육계획 시트)을 읽어 행 목록으로 바꾼다. */
export async function parseTrainingWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  // 헤더(교육과목+성명)가 있는 시트를 찾는다
  let ws = null;
  let headerRow = 0;
  const cols = {};
  for (const sheet of [wb.getWorksheet('개인별 교육계획'), ...wb.worksheets].filter(Boolean)) {
    for (let r = 1; r <= Math.min(sheet.rowCount, 15); r++) {
      const found = {};
      sheet.getRow(r).eachCell((c, i) => {
        const h = norm(cellValue(c));
        for (const [f, names] of Object.entries(ALIASES)) if (names.map(norm).includes(h) && !(f in found)) found[f] = i;
      });
      if (found.course && found.name) {
        ws = sheet;
        headerRow = r;
        Object.assign(cols, found);
        break;
      }
    }
    if (ws) break;
  }
  if (!ws) throw Object.assign(new Error('교육계획 시트를 찾을 수 없습니다. ("교육과목", "성명" 열이 있는 시트가 필요합니다)'), { status: 400 });

  const rows = [];
  const warnings = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const g = (f) => (cols[f] ? cellValue(row.getCell(cols[f])) : '');
    const name = text(g('name'));
    const course = text(g('course'));
    if (!name && !course) continue;
    if (!name || !course) {
      warnings.push(`${r}행: ${!name ? '성명' : '교육과목'}이 비어 있어 제외했습니다.`);
      continue;
    }
    const sch = parseSchedule(g('schedule'), g('month'));
    if (sch.note.startsWith('일정 형식')) warnings.push(`${r}행 (${name}): ${sch.note}`);
    rows.push({
      no: text(g('no')),
      company: text(g('company')),
      job: text(g('job')),
      dept: text(g('dept')),
      rank: text(g('rank')),
      name,
      kind: text(g('kind')),
      org: text(g('org')),
      course,
      days: num(g('days')),
      hours: num(g('hours')),
      schedule_raw: text(g('schedule')),
      start_date: sch.start,
      end_date: sch.end,
      month: sch.month,
      cost: num(g('cost')),
      result: text(g('result')),
      note: sch.note,
    });
  }
  return { rows, warnings };
}

// ───────── 월별·인원별 정리본 엑셀 만들기 ─────────
const FONT = 'Malgun Gothic';
const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
const SUB_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF0FB' } };
const THIN = { style: 'thin', color: { argb: 'FFD0D7E5' } };
const BORDER = { top: THIN, bottom: THIN, left: THIN, right: THIN };

function styleHeader(row) {
  row.eachCell((c) => {
    c.font = { name: FONT, bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    c.fill = HEAD_FILL;
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = BORDER;
  });
  row.height = 24;
}
function styleBody(ws, fromRow, toRow, fmts = {}) {
  for (let r = fromRow; r <= toRow; r++) {
    ws.getRow(r).eachCell({ includeEmpty: true }, (c, i) => {
      c.font = { ...(c.font || {}), name: FONT, size: 10 };
      c.border = BORDER;
      if (fmts[i]) c.numFmt = fmts[i];
    });
  }
}
const monthLabel = (m) => (m === 0 ? '미정' : `${m}월`);
const isDone = (r) => r.result === '이수';
const isBlank = (r) => !r.result;

/** rows: DB trainings 행 배열 */
export function buildTrainingReport(rows, sourceName = '') {
  const wb = new ExcelJS.Workbook();
  wb.creator = '업무 캘린더';
  wb.created = new Date();
  // 시트 순서를 먼저 정해 둔다 (월별 요약 → 인원별 요약 → 월별·인원별 현황 → 월별 상세 → 데이터)
  const ms = wb.addWorksheet('월별 요약');
  const ps = wb.addWorksheet('인원별 요약');
  const mx = wb.addWorksheet('월별·인원별 현황');
  const dt = wb.addWorksheet('월별 상세');
  const ds = wb.addWorksheet('데이터');

  const sorted = [...rows].sort((a, b) => (a.month || 99) - (b.month || 99) || String(a.start_date || '9').localeCompare(String(b.start_date || '9')) || a.dept.localeCompare(b.dept, 'ko') || a.name.localeCompare(b.name, 'ko'));
  const N = rows.length + 1; // 데이터 시트 마지막 행 번호

  // ===== 데이터 (원본 정리본: 모든 요약의 근거) =====
  ds.columns = [
    ['No', 6], ['소속', 11], ['직종', 8], ['부서', 16], ['직급', 8], ['성명', 9], ['구분', 7], ['교육기관', 18], ['교육과목', 40], ['기간(일)', 8], ['시간', 7],
    ['일정(원문)', 16], ['시작일', 11], ['종료일', 11], ['월', 6], ['교육비(원)', 12], ['실적', 12], ['인원키', 16], ['비고', 28],
  ].map(([header, width]) => ({ header, width }));
  const dataRows = [...rows].sort((a, b) => Number(a.no) - Number(b.no) || a.id - b.id);
  dataRows.forEach((r, i) => {
    const row = i + 2;
    ds.addRow([
      Number(r.no) || r.no, r.company, r.job, r.dept, r.rank, r.name, r.kind, r.org, r.course, r.days || null, r.hours || null,
      r.schedule_raw, r.start_date, r.end_date, r.month === 0 ? '미정' : r.month, r.cost, r.result || null,
      { formula: `B${row}&"|"&F${row}`, result: `${r.company}|${r.name}` }, r.note || null,
    ]);
  });
  styleHeader(ds.getRow(1));
  styleBody(ds, 2, N, { 16: '#,##0' });
  ds.views = [{ state: 'frozen', ySplit: 1 }];
  ds.autoFilter = { from: 'A1', to: `S${N}` };
  const D = (col) => `'데이터'!$${col}$2:$${col}$${N}`;

  // ===== 월별 요약 =====
  ms.columns = [['월', 9], ['교육 건수', 11], ['교육 인원(중복 제외)', 16], ['교육비(원)', 14], ['이수', 9], ['취소·퇴사·휴직·대체', 18], ['실적 미입력', 12], ['이수율', 9]].map(([header, width]) => ({ header, width }));
  const months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0];
  months.forEach((m, i) => {
    const r = i + 2;
    const list = rows.filter((x) => x.month === m);
    const cnt = list.length;
    const people = new Set(list.map((x) => `${x.company}|${x.name}`)).size;
    const cost = list.reduce((s, x) => s + x.cost, 0);
    const done = list.filter(isDone).length;
    const blank = list.filter(isBlank).length;
    const other = cnt - done - blank;
    const key = m === 0 ? '"미정"' : `A${r}`;
    ms.addRow([
      m === 0 ? '미정' : m,
      { formula: `COUNTIFS(${D('O')},${key})`, result: cnt },
      { formula: `SUMPRODUCT((${D('O')}=${key})/COUNTIFS(${D('O')},${D('O')},${D('R')},${D('R')}))`, result: people },
      { formula: `SUMIFS(${D('P')},${D('O')},${key})`, result: cost },
      { formula: `COUNTIFS(${D('O')},${key},${D('Q')},"이수")`, result: done },
      { formula: `B${r}-E${r}-G${r}`, result: other },
      { formula: `COUNTIFS(${D('O')},${key},${D('Q')},"")`, result: blank },
      { formula: `IF(B${r}-F${r}=0,0,E${r}/(B${r}-F${r}))`, result: cnt - other === 0 ? 0 : done / (cnt - other) },
    ]);
    if (m !== 0) ms.getCell(`A${r}`).numFmt = '0"월"';
  });
  const tr = months.length + 2;
  const all = rows;
  const doneAll = all.filter(isDone).length;
  const blankAll = all.filter(isBlank).length;
  const otherAll = all.length - doneAll - blankAll;
  ms.addRow([
    '합계',
    { formula: `SUM(B2:B${tr - 1})`, result: all.length },
    { formula: `SUMPRODUCT(1/COUNTIFS(${D('R')},${D('R')}))`, result: new Set(all.map((x) => `${x.company}|${x.name}`)).size },
    { formula: `SUM(D2:D${tr - 1})`, result: all.reduce((s, x) => s + x.cost, 0) },
    { formula: `SUM(E2:E${tr - 1})`, result: doneAll },
    { formula: `SUM(F2:F${tr - 1})`, result: otherAll },
    { formula: `SUM(G2:G${tr - 1})`, result: blankAll },
    { formula: `IF(B${tr}-F${tr}=0,0,E${tr}/(B${tr}-F${tr}))`, result: all.length - otherAll === 0 ? 0 : doneAll / (all.length - otherAll) },
  ]);
  styleHeader(ms.getRow(1));
  styleBody(ms, 2, tr, { 2: '#,##0', 3: '#,##0', 4: '#,##0', 5: '#,##0', 6: '#,##0', 7: '#,##0', 8: '0.0%' });
  ms.getRow(tr).eachCell((c) => { c.font = { name: FONT, bold: true, size: 10 }; c.fill = SUB_FILL; });
  ms.getColumn(1).alignment = { horizontal: 'center' };
  ms.views = [{ state: 'frozen', ySplit: 1 }];
  ms.getCell(`A${tr + 2}`).value = '※ 이수율 = 이수 ÷ (교육 건수 − 취소·퇴사·휴직·대체). "실적 미입력"은 원본 실적 칸이 비어 있는 건(미실시 예정 포함)입니다.';
  ms.getCell(`A${tr + 3}`).value = `※ 월은 원본 "월" 열 기준이며, 일정이 "미정"인 건은 마지막 줄에 따로 집계했습니다.${sourceName ? ' 원본: ' + sourceName : ''}`;
  for (const rr of [tr + 2, tr + 3]) ms.getCell(`A${rr}`).font = { name: FONT, size: 9, color: { argb: 'FF666666' } };

  // ===== 인원별 요약 (건수 매트릭스) =====
  const persons = new Map();
  for (const r of [...rows].sort((a, b) => a.company.localeCompare(b.company, 'ko') || a.dept.localeCompare(b.dept, 'ko') || a.name.localeCompare(b.name, 'ko'))) {
    const k = `${r.company}|${r.name}`;
    if (!persons.has(k)) persons.set(k, { company: r.company, name: r.name, dept: r.dept, rank: r.rank, depts: new Set(), ranks: new Set(), list: [] });
    const p = persons.get(k);
    p.depts.add(r.dept);
    p.ranks.add(r.rank);
    p.list.push(r);
  }
  const head = ['소속', '부서', '직급', '성명', '교육 건수', '교육시간', '교육비(원)', '이수'];
  ps.columns = [...head.map((h, i) => ({ header: h, width: [11, 16, 8, 9, 9, 9, 13, 7][i] })), ...[...Array(12)].map((_, i) => ({ header: i + 1, width: 5.5 })), { header: '미정', width: 6 }, { header: '비고', width: 30 }];
  for (let i = 1; i <= 12; i++) ps.getRow(1).getCell(8 + i).numFmt = '0"월"';
  let pr = 2;
  for (const p of persons.values()) {
    const r = pr++;
    const cnt = p.list.length;
    const byMonth = (m) => p.list.filter((x) => x.month === m).length;
    const crit = `${D('B')},A${r},${D('F')},D${r}`;
    const cols = [];
    for (let m = 1; m <= 12; m++) {
      const colLetter = ps.getColumn(8 + m).letter;
      cols.push({ formula: `COUNTIFS(${crit},${D('O')},${colLetter}$1)`, result: byMonth(m) });
    }
    cols.push({ formula: `COUNTIFS(${crit},${D('O')},"미정")`, result: byMonth(0) });
    const noteParts = [];
    if (p.depts.size > 1) noteParts.push(`부서 표기 ${p.depts.size}종: ${[...p.depts].join(' / ')}`);
    if (p.ranks.size > 1) noteParts.push(`직급 표기 ${p.ranks.size}종: ${[...p.ranks].join(' / ')}`);
    ps.addRow([
      p.company, p.dept, p.rank, p.name,
      { formula: `COUNTIFS(${crit})`, result: cnt },
      { formula: `SUMIFS(${D('K')},${crit})`, result: p.list.reduce((s, x) => s + x.hours, 0) },
      { formula: `SUMIFS(${D('P')},${crit})`, result: p.list.reduce((s, x) => s + x.cost, 0) },
      { formula: `COUNTIFS(${crit},${D('Q')},"이수")`, result: p.list.filter(isDone).length },
      ...cols, noteParts.join(' · ') || null,
    ]);
  }
  const pLast = pr - 1;
  ps.addRow([
    '합계', null, null, null,
    { formula: `SUM(E2:E${pLast})`, result: rows.length },
    { formula: `SUM(F2:F${pLast})`, result: rows.reduce((s, x) => s + x.hours, 0) },
    { formula: `SUM(G2:G${pLast})`, result: rows.reduce((s, x) => s + x.cost, 0) },
    { formula: `SUM(H2:H${pLast})`, result: doneAll },
    ...[...Array(13)].map((_, i) => {
      const L = ps.getColumn(9 + i).letter;
      return { formula: `SUM(${L}2:${L}${pLast})`, result: rows.filter((x) => x.month === (i < 12 ? i + 1 : 0)).length };
    }),
  ]);
  styleHeader(ps.getRow(1));
  styleBody(ps, 2, pLast + 1, { 5: '#,##0', 6: '#,##0', 7: '#,##0' });
  ps.getRow(pLast + 1).eachCell((c) => { c.font = { name: FONT, bold: true, size: 10 }; c.fill = SUB_FILL; });
  for (let r = 2; r <= pLast; r++) for (let c = 9; c <= 21; c++) {
    const cell = ps.getRow(r).getCell(c);
    cell.alignment = { horizontal: 'center' };
    if (cell.value && cell.value.result > 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cell.value.result > 1 ? 'FF9DB8F0' : 'FFDCE7FB' } };
  }
  ps.views = [{ state: 'frozen', xSplit: 4, ySplit: 1 }];
  ps.autoFilter = { from: 'A1', to: `V${pLast}` };

  // ===== 월별·인원별 현황 (칸 안에 교육과목) =====
  mx.columns = [{ header: '소속', width: 10 }, { header: '부서', width: 15 }, { header: '직급', width: 7 }, { header: '성명', width: 9 }, ...[...Array(12)].map((_, i) => ({ header: `${i + 1}월`, width: 30 })), { header: '미정', width: 30 }];
  for (const p of persons.values()) {
    const cells = [];
    let maxLines = 1;
    for (let m = 1; m <= 12; m++) cells.push(m);
    cells.push(0);
    const texts = cells.map((m) => {
      const lines = p.list.filter((x) => x.month === m).sort((a, b) => String(a.start_date || '').localeCompare(String(b.start_date || ''))).map((x) => {
        const d = x.start_date ? `${x.start_date.slice(5).replace('-', '/')}${x.end_date && x.end_date !== x.start_date ? '~' + x.end_date.slice(8) : ''} ` : '';
        return `${d}${x.course}${x.kind ? ` [${x.kind}]` : ''}${x.result ? ` (${x.result})` : ''}`;
      });
      maxLines = Math.max(maxLines, lines.reduce((s, l) => s + Math.ceil(l.length / 16), 0));
      return lines.join('\n') || null;
    });
    const row = mx.addRow([p.company, p.dept, p.rank, p.name, ...texts]);
    row.height = Math.min(400, Math.max(18, maxLines * 14));
    row.eachCell({ includeEmpty: true }, (c, i) => { c.alignment = { wrapText: true, vertical: 'top' }; c.font = { name: FONT, size: 9 }; c.border = BORDER; if (i > 4 && c.value) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F6FD' } }; });
  }
  styleHeader(mx.getRow(1));
  mx.views = [{ state: 'frozen', xSplit: 4, ySplit: 1 }];
  mx.autoFilter = { from: 'A1', to: { row: persons.size + 1, column: 17 } };

  // ===== 월별 상세 (월 순서대로 나열) =====
  dt.columns = [['월', 7], ['일정', 17], ['소속', 10], ['부서', 15], ['직급', 7], ['성명', 9], ['구분', 7], ['교육과목', 40], ['교육기관', 18], ['시간', 7], ['교육비(원)', 12], ['실적', 12]].map(([header, width]) => ({ header, width }));
  for (const r of sorted) dt.addRow([r.month === 0 ? '미정' : r.month, r.schedule_raw, r.company, r.dept, r.rank, r.name, r.kind, r.course, r.org, r.hours || null, r.cost, r.result || null]);
  styleHeader(dt.getRow(1));
  styleBody(dt, 2, sorted.length + 1, { 11: '#,##0' });
  for (let r = 2; r <= sorted.length + 1; r++) { const c = dt.getRow(r).getCell(1); if (typeof c.value === 'number') c.numFmt = '0"월"'; c.alignment = { horizontal: 'center' }; }
  dt.views = [{ state: 'frozen', ySplit: 1 }];
  dt.autoFilter = { from: 'A1', to: `L${sorted.length + 1}` };

  wb.views = [{ activeTab: 0 }];
  return wb;
}
