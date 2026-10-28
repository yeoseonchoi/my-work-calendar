// 서버 없는 버전(GitHub Pages)을 docs/ 폴더에 만든다.
//   node scripts/build-static.mjs
// public/ 의 화면 파일을 그대로 복사하고, static/ 의 "브라우저 안의 서버"를 끼워 넣는다.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'docs');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'vendor', 'rrule'), { recursive: true });

// 1) 화면 파일 복사 (public/ 전체)
fs.cpSync(path.join(root, 'public'), out, { recursive: true });

// 2) 브라우저용 파일 복사
for (const f of ['recur-browser.js', 'gh-sync.js', 'localapi.js', 'static-mode.js']) fs.copyFileSync(path.join(root, 'static', f), path.join(out, f));
fs.copyFileSync(path.join(root, 'node_modules/rrule/dist/es5/rrule.min.js'), path.join(out, 'vendor/rrule/rrule.min.js'));

// 3) index.html: 서버 없는 버전용 스크립트를 끼우고, GitHub Pages(하위 주소)에서도 열리도록 경로를 상대 경로로 바꾼다
let html = read('public/index.html');
const need = ['<!--STATIC-HEAD-->', '<!--STATIC-TAIL-->'];
for (const m of need) if (!html.includes(m)) throw new Error(`index.html 에 ${m} 표시가 없습니다.`);
html = html
  .replace('<!--STATIC-HEAD-->', '<script>window.STATIC_MODE = true;</script>\n<script src="vendor/rrule/rrule.min.js"></script>\n<script src="recur-browser.js"></script>\n<script src="gh-sync.js"></script>\n<script src="localapi.js"></script>')
  .replace('<!--STATIC-TAIL-->', '<script src="static-mode.js"></script>')
  .replace(/(href|src)="\/(?!\/)/g, '$1="');
html = html.replace('<title>', '<title>').replace(/<title>[^<]*<\/title>/, '<title>내 캘린더</title>');
fs.writeFileSync(path.join(out, 'index.html'), html);

// 4) GitHub Pages 가 파일을 그대로 서비스하도록
fs.writeFileSync(path.join(out, '.nojekyll'), '');

// 5) my-work-calendar 저장소는 Pages 를 "저장소 루트"에서 서비스하므로, 루트에도 같은 파일을 둔다.
//    (Pages 설정을 "/docs" 폴더로 바꾸면 이 단계와 루트의 복사본은 필요 없다)
if (process.argv.includes('--no-root') === false) {
  for (const e of fs.readdirSync(out, { withFileTypes: true })) fs.cpSync(path.join(out, e.name), path.join(root, e.name), { recursive: true });
  console.log('루트에도 사이트 파일을 복사했습니다. (끄려면 --no-root)');
}

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk : (p) => files.push(p))(path.join(d, e.name));
})(out);
console.log(`docs/ 생성 완료: 파일 ${files.length}개`);
