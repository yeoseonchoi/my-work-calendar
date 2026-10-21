# 업무 캘린더

팀원(10명 내외)이 일정을 등록·공유하고, 반복 일정과 이메일 알람을 쓸 수 있는 웹 캘린더입니다.
교육계획 엑셀을 올리면 월별·인원별로 정리하고, 교육 참석 요청 메일을 주기에 맞춰 자동 발송합니다.

## 두 가지 실행 방식
| 방식 | 데이터 | 설명 |
|---|---|---|
| **내 PC / 사내 서버** | `data/calendar.db` 파일 | `start.bat` 더블클릭. 설정이 가장 간단 |
| **Vercel 배포 (웹)** | Turso DB + Vercel Blob | [DEPLOY.md](DEPLOY.md) 를 따라 설정 |

## 로컬 실행
1. Node.js 설치 (v22.13 이상)
2. `start.bat` 더블클릭 (또는 `npm install` 후 `npm start`)
3. 브라우저에서 http://localhost:3000 접속 — 첫 가입자가 관리자가 됩니다.
4. 팀원은 `http://서버PC의IP:3000` 으로 접속합니다.

## 설정 (.env)
`.env.example` 을 `.env` 로 복사하고 필요한 값을 채운 뒤 서버를 다시 시작하세요.
- `SMTP_*` : 알람·교육 안내 메일 발송
- `JOIN_CODE` : 설정하면 가입 코드를 아는 사람만 가입할 수 있습니다.

## 데이터 (로컬 실행 시)
`data/` 폴더에 DB(calendar.db)와 첨부파일이 저장됩니다. 이 폴더를 백업하세요.

## 개발 메모
- 서버: Express 5 + libSQL(`@libsql/client`). `TURSO_DATABASE_URL` 이 없으면 로컬 SQLite 파일을 씁니다.
- 주기 작업(알람·자동 종료·교육 메일)은 `/api/cron/tick` 이 실행합니다. 로컬에서는 서버가 30초마다 스스로 호출합니다.
- 기존 로컬 데이터를 Turso 로 옮기기: `npm run migrate:turso` (DEPLOY.md 7번 참고)
