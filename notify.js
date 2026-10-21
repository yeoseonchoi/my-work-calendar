import { db, batch } from './db.js';

// 내부(앱 상단) 알림 저장. exceptUserId 는 행위자 본인에게는 보내지 않기 위해 사용
// 여러 사람에게 보내도 한 번의 DB 요청으로 처리한다.
export async function pushNote(userIds, { type, event_id = null, ref_start = null, title, body = '' }, exceptUserId = null) {
  const targets = [...new Set(userIds.filter(Boolean))].filter((uid) => uid !== exceptUserId);
  if (!targets.length) return;
  await batch(
    targets.map((uid) => ({
      sql: 'INSERT INTO notifications (user_id, type, event_id, ref_start, title, body) VALUES (?, ?, ?, ?, ?, ?)',
      args: [uid, type, event_id, ref_start, title, body],
    })),
  );
}

// 변경 이력 기록
export async function addHistory(eventId, userId, action, detail = '') {
  await db.prepare('INSERT INTO history (event_id, user_id, action, detail) VALUES (?, ?, ?, ?)').run(eventId, userId, action, detail);
}
