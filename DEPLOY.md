# Vercel 배포 가이드

이 프로그램은 **Vercel(앱) + Turso(데이터베이스) + Vercel Blob(첨부파일)** 로 배포합니다.
Vercel 은 서버의 디스크가 영구 저장되지 않고 서버가 계속 켜져 있지도 않아서, 데이터·파일·주기 작업을 아래처럼 바깥 서비스로 나눴습니다.

| 하는 일 | 사용 서비스 | 비고 |
|---|---|---|
| 앱 실행 / 화면 | Vercel | GitHub 저장소와 연결하면 푸시할 때마다 자동 배포 |
| 일정·계정·교육 데이터 | **Turso** (SQLite 호환 클라우드 DB) | 무료 구간 있음 |
| 첨부파일 | **Vercel Blob** | "Private" 저장소로 만들 것 |
| 알람·자동 종료·교육 메일 (주기 작업) | **cron-job.org**(무료) 또는 Vercel Pro 크론 | 5분마다 `/api/cron/tick` 호출 |
| 메일 발송 | 외부 SMTP (Gmail, SendGrid, Resend 등) | 사내 25번 포트 메일 서버는 Vercel 에서 막혀 있을 가능성이 큼 |

> ⚠️ **요금 정책 확인**: Vercel **Hobby(무료) 플랜은 개인·비상업적 용도**로 제한됩니다. 회사 업무용이면 Pro 플랜이 필요할 수 있으니 약관을 확인하세요.

---

## 1. Turso 데이터베이스 만들기
1. https://turso.tech 에서 GitHub 로 가입합니다.
2. **Create Database** → 이름 `work-calendar`, 지역은 **Tokyo (aws-ap-northeast-1)** (서울과 가장 가까움).
3. 만든 DB 화면에서 두 값을 복사해 둡니다.
   - **URL**: `libsql://work-calendar-계정.turso.io`
   - **Token**: "Generate Token" 으로 발급 (읽기/쓰기 권한)

## 2. 코드를 GitHub 에 올리기
```
cd work-calendar
git push -u origin main
```

## 3. Vercel 에 프로젝트 만들기
1. https://vercel.com 에서 GitHub 로 가입 → **Add New… → Project** → `work-calendar` 저장소 **Import**.
2. Framework Preset 은 **Other** 로 두면 됩니다(Express 자동 인식). Build/Output 설정은 비워 둡니다.
3. **Environment Variables** 에 아래를 입력하고 **Deploy** 합니다.

| 이름 | 값 | 필수 |
|---|---|---|
| `TURSO_DATABASE_URL` | 1단계의 URL (`libsql://…`) | ✅ |
| `TURSO_AUTH_TOKEN` | 1단계의 토큰 | ✅ |
| `JOIN_CODE` | 가입 코드(직원에게만 알려줄 문구). **공개 주소이므로 꼭 설정** | ✅ 권장 |
| `CRON_SECRET` | 길고 무작위인 문자열(32자 이상). 주기 작업 호출 암호 | ✅ |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` `SMTP_USER` `SMTP_PASS` `SMTP_FROM` | 외부 SMTP 정보 | 메일을 보내려면 |
| `APP_TZ_OFFSET_MIN` | 한국이면 비워 둠(기본 540) | 선택 |

## 4. 첨부파일 저장소(Blob) 연결
1. Vercel 프로젝트 → **Storage** 탭 → **Create → Blob** → 접근 방식은 **Private** 선택.
2. 프로젝트에 **Connect** 하면 `BLOB_READ_WRITE_TOKEN` 이 자동으로 추가됩니다.
3. **Redeploy** 해서 반영합니다.

## 5. 동작 확인
- `https://<내 주소>.vercel.app/api/health` 를 열어 `"ok": true, "db": true, "storage": "blob"` 인지 확인합니다.
- 주소에 접속해 **가입 코드를 입력하고 첫 계정을 만듭니다(첫 가입자 = 관리자)**.
  - `JOIN_CODE` 를 설정하지 않으면 주소를 아는 아무나 먼저 가입해 관리자가 될 수 있으니, 반드시 설정한 뒤 접속하세요.

## 6. 주기 작업 켜기 (알람 · 자동 종료 · 교육 메일)
Vercel 은 서버가 계속 떠 있지 않아서, 5분마다 아래 주소를 누군가 불러 줘야 합니다.

**방법 A. cron-job.org (무료, 권장)**
1. https://cron-job.org 가입 → **Create cronjob**
2. URL: `https://<내 주소>.vercel.app/api/cron/tick`
3. Schedule: **Every 5 minutes**
4. **Advanced → Headers** 에 `Authorization` = `Bearer <3단계의 CRON_SECRET 값>` 추가
5. 저장 후 실행 결과가 `200` 인지 확인합니다.

**방법 B. Vercel Pro 크론**: `vercel.json` 의 `crons` 일정을 `*/5 * * * *` 로 바꿉니다. (Hobby 는 하루 1번만 가능하고 시각 오차가 최대 1시간)

> `vercel.json` 에는 기본으로 하루 1번(한국 시간 오전 9시) 호출이 들어 있습니다. 교육 참석 요청 메일은 이것만으로도 동작하지만, **시작 전 알람(10분 전 등)은 5분 간격 호출이 있어야** 제때 나갑니다.

## 7. 기존 데이터 옮기기 (로컬에서 쓰던 데이터가 있을 때)
```
cd work-calendar
$env:TURSO_DATABASE_URL = "libsql://…"
$env:TURSO_AUTH_TOKEN   = "…"
$env:BLOB_READ_WRITE_TOKEN = "…"     # 첨부파일이 있을 때만
node scripts/migrate-to-turso.mjs
```
계정, 일정, 교육 현황, 설정, 첨부파일이 그대로 옮겨지고, 모두 새로 로그인해야 합니다.

---

## 알아둘 제한
- **첨부파일은 파일당 4MB** 까지 (Vercel 요청 크기 제한 4.5MB).
- **엑셀 일정 업로드는 한 번에 150행**까지, 파일 4MB 이하.
- 알람은 5분 간격 호출 기준이라 **최대 5분 정도 늦을 수 있습니다.**
- 사내 메일 서버(`mail.ds-al.com`, 25번 포트)는 외부에서 막혀 있을 수 있어, **외부 SMTP**(Gmail 앱 비밀번호, SendGrid, Resend 등)를 쓰거나 IT 담당자에게 허용을 요청해야 합니다.

## 문제 해결
| 증상 | 확인 |
|---|---|
| 화면은 뜨는데 로그인/가입이 안 됨 | `/api/health` 의 `db` 가 `false` 이면 `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` 을 다시 확인 |
| 첨부파일 업로드 실패 | `/api/health` 의 `storage` 가 `blob` 인지, Blob 저장소가 Private 으로 연결됐는지 확인 |
| 알람·교육 메일이 안 감 | cron-job.org 실행 기록이 `200` 인지, `CRON_SECRET` 이 같은지 확인 |
| 메일이 안 감 | `/api/health` 의 `smtp` 가 `true` 인지, 교육 현황 → ✉️ 참석요청 메일에서 테스트 메일로 확인 |
| 시간이 9시간 어긋남 | `APP_TZ_OFFSET_MIN` 이 비어 있거나 `540` 인지 확인 |

로컬에서 그대로 실행하려면 `start.bat` (또는 `npm start`)을 쓰면 됩니다. `TURSO_*` 값이 없으면 `data/calendar.db` 파일을 사용합니다.
