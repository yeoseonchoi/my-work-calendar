// 첨부파일 저장소
//  - 배포(Vercel): Vercel Blob (BLOB_READ_WRITE_TOKEN 이 있으면 자동 사용). Vercel 의 디스크는 영구 저장이 되지 않기 때문.
//  - 로컬 개발: data/uploads 폴더
import { put, get, del } from '@vercel/blob';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { uploadDir } from './db.js';

export const useBlob = !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
// Blob 저장소를 "Private" 으로 만들면 파일 주소를 알아도 로그인 없이는 받을 수 없다 (권장)
const ACCESS = process.env.BLOB_ACCESS === 'public' ? 'public' : 'private';
export const storageMode = useBlob ? 'blob' : 'local';
// Vercel 은 요청 본문이 4.5MB 로 제한되므로 그 아래로 맞춘다
export const MAX_UPLOAD_BYTES = (process.env.VERCEL ? 4 : 10) * 1024 * 1024;

/** 파일을 저장하고 DB 에 기록할 식별자(stored)를 돌려준다 */
export async function saveFile(buffer, filename, contentType) {
  if (useBlob) {
    const ext = path.extname(filename).replace(/[^\w.]/g, '').slice(0, 12);
    const r = await put(`attachments/file${ext}`, buffer, { access: ACCESS, addRandomSuffix: true, contentType: contentType || 'application/octet-stream' });
    return `blob:${r.url}`;
  }
  fs.mkdirSync(uploadDir, { recursive: true });
  const name = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(uploadDir, name), buffer);
  return name;
}

/** 저장된 파일을 읽는다. 없으면 null. 반환: { stream(Node Readable), size, contentType } */
export async function openFile(stored) {
  if (stored.startsWith('blob:')) {
    const r = await get(stored.slice(5), { access: ACCESS });
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    return { stream: Readable.fromWeb(r.stream), size: r.blob.size, contentType: r.blob.contentType };
  }
  const p = path.join(uploadDir, stored);
  if (!fs.existsSync(p)) return null;
  return { stream: fs.createReadStream(p), size: fs.statSync(p).size, contentType: 'application/octet-stream' };
}

export async function removeFile(stored) {
  try {
    if (stored.startsWith('blob:')) await del(stored.slice(5));
    else fs.rmSync(path.join(uploadDir, stored), { force: true });
  } catch (e) {
    console.error('파일 삭제 실패:', stored, e.message); // DB 기록 삭제는 계속 진행
  }
}
