# GitHub Pages 배포 가이드 (서버 없는 버전)

`docs/` 폴더가 **서버 없이 브라우저만으로 도는 HTML 버전**입니다. GitHub Pages 에 올리면 `https://내계정.github.io/저장소이름/` 주소로 열립니다.
데이터는 기본적으로 **쓰는 브라우저 안**에 저장되고, 원하면 **내 비공개(private) GitHub 저장소의 파일**에도 저장해 여러 기기에서 맞출 수 있습니다.

> 코드 저장소는 공개(public)여도 괜찮습니다. 일정·만료일 같은 **개인 데이터는 코드 저장소에 올라가지 않습니다.**
> 데이터를 GitHub 에 저장하려면 반드시 **별도의 비공개 저장소**를 따로 만들어 쓰세요. (아래 3단계)

---

## 1. 코드 올리기
`work-calendar` 폴더에서:
```
git add .
git commit -m "서버 없는 HTML 버전 추가"
git push
```
`docs/` 폴더까지 함께 올라가야 합니다. (`.env`, `data/` 는 `.gitignore` 로 제외되어 올라가지 않습니다.)

## 2. GitHub Pages 켜기
1. GitHub 의 `work-calendar` 저장소 → **Settings → Pages**
2. **Build and deployment → Source**: `Deploy from a branch`
3. **Branch**: `main` , 폴더 `/docs` → **Save**
4. 1~2분 뒤 위쪽에 표시되는 주소(`https://yeoseonchoi.github.io/work-calendar/`)로 접속합니다.

> 무료 계정의 GitHub Pages 는 **공개 저장소**에서만 쓸 수 있습니다. 코드에는 개인 데이터가 없으니 공개해도 됩니다.

## 3. 데이터 저장용 비공개 저장소 만들기 (선택, 기기 간 동기화·백업용)
1. GitHub 에서 새 저장소를 만듭니다. 이름은 예: `calendar-data`
2. **반드시 `Private`(비공개)** 로 선택하고, **Add a README file** 을 체크한 뒤 만듭니다.

## 4. 토큰 만들기
1. GitHub 오른쪽 위 프로필 → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
2. **Repository access**: `Only select repositories` → 3단계에서 만든 `calendar-data` **하나만** 선택
3. **Permissions → Repository permissions → Contents**: `Read and write`
4. 만료 기간을 정하고 생성 → 나온 `github_pat_…` 값을 복사해 둡니다. (한 번만 보여 줍니다)

## 5. 앱에서 연결하기
1. 앱 접속 → 왼쪽 **설정**
2. **데이터 저장 (GitHub)** 에 입력: 저장소 주인(내 GitHub 계정), 저장소 이름(`calendar-data`), 토큰
3. **연결하고 동기화**를 누릅니다. 이후 일정을 바꾸면 몇 초 안에 저장소의 `calendar-data.json` 에 자동 저장됩니다.

다른 기기에서도 같은 방법으로 연결하면 저장소의 데이터를 불러옵니다.
- **새 기기(데이터가 비어 있음)** 는 저장소의 내용을 그대로 불러옵니다. 빈 데이터로 덮어쓰지 않습니다.
- 양쪽에 모두 데이터가 있으면 어느 쪽을 쓸지 묻습니다.
- 두 기기에서 동시에 고치면, 나중에 저장하는 쪽에 **선택창**(덮어쓰기 / 상대 내용 불러오기)이 뜹니다.

## 서버 없는 버전에서 되는 것 / 안 되는 것
| 되는 것 | 안 되는 것 (서버가 필요) |
|---|---|
| 내 캘린더(월·주·일·목록·년), 반복 일정, 종료·취소 | 교육 현황, 교육 참석요청 메일 |
| 업무 보드, 업무 템플릿, 만료일 관리 | 메일 알림 (앱 알림과 브라우저 알림은 가능) |
| 일정 검색, 복제, 링크 복사, 댓글·변경 이력 | 파일 첨부, 엑셀 업로드·내보내기 (대신 JSON 백업) |
| 오늘의 기분·테마 색상, 백업 내려받기·불러오기 | |

- **알람과 만료 알림, 종료 일정 자동 체크는 이 페이지가 열려 있는 동안에만** 동작합니다. (서버가 없어서 닫혀 있으면 확인할 수 없고, 다시 열면 한꺼번에 따라잡습니다.)
- 브라우저 알림은 설정의 **🔔 브라우저 알림 허용**을 눌러야 울립니다.
- 서버가 있는 전체 기능 버전(교육 현황·메일 등)은 기존 방식(`start.bat` 또는 Vercel)으로 계속 쓸 수 있습니다.

## 보안
- 토큰은 **그 브라우저의 저장소(localStorage)에만** 보관되고, GitHub 로 직접 보낼 때만 사용됩니다. 공용 PC 에서는 연결하지 마세요.
- 토큰은 `calendar-data` 한 저장소의 Contents 권한만 주었으므로, 유출돼도 피해가 그 저장소로 제한됩니다. 의심되면 GitHub 에서 토큰을 바로 삭제(Revoke)하세요.
- **공개 저장소에 연결하려 하면 경고**가 뜹니다. 공개 저장소에 저장하면 일정이 누구에게나 보입니다.
- 사이트 주소는 누구나 열 수 있지만, 데이터는 각자의 브라우저 또는 비공개 저장소에 있어서 **다른 사람이 열면 빈 캘린더**입니다.

## 수정 후 다시 만들기
화면(`public/`)이나 서버 없는 버전 부품(`static/`)을 고쳤다면:
```
npm run build:static
git add docs
git commit -m "HTML 버전 갱신"
git push
```
