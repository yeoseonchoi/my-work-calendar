import { db } from './db.js';

// 내부(앱 상단) 알림 저장. exceptUserId 는 행위자 본인에게는 보내지 않기 위해 사용
export function pushNote(userIds, { type, event_id = null, ref_start = null, title, body = '' }, exceptUserId = null) {
  const ins = db.prepare('INSERT INTO notifications (user_id, type, event_id, ref_start, title, body) VALUES (?, ?, ?, ?, ?, ?)');
  for (const uid of new Set(userIds.filter(Boolean))) {
    if (uid !== exceptUserId) ins.run(uid, type, event_id, ref_start, title, body);
  }
}

// 변경 이력 기록
export function addHistory(eventId, userId, action, detail = '') {
  db.prepare('INSERT INTO history (event_id, user_id, action, detail) VALUES (?, ?, ?, ?)').run(eventId, userId, action, detail);
}
