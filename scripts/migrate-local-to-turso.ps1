# 이 PC 의 로컬 데이터를 Turso(Vercel 에서 쓰는 DB)로 옮기는 도우미.
# 토큰은 입력창에서만 받고, 화면에 표시하거나 파일에 저장하지 않는다.
Set-Location (Split-Path $PSScriptRoot -Parent)
$ErrorActionPreference = 'Stop'

Write-Host ""
Write-Host "=== 업무 캘린더 데이터 이전 (이 PC -> Turso) ===" -ForegroundColor Cyan
Write-Host "이전 대상: 이 PC 의 data\calendar.db (교육 현황, 메일 주소, 일정, 계정)"
Write-Host "백업: claude\백업_data_2026-10-28 폴더에 이미 복사해 두었습니다."
Write-Host ""
Write-Host "[주의] Turso 쪽의 기존 데이터(방금 새로 가입한 계정)는 지워지고, 이 PC 의 데이터로 바뀝니다." -ForegroundColor Yellow
Write-Host "       이전 후에는 이 PC 에서 쓰던 계정(suda0706@ds-al.com)과 비밀번호로 로그인합니다."
Write-Host ""
$ok = Read-Host "계속하려면 YES 를 입력하세요"
if ($ok -ne 'YES') { Write-Host "취소했습니다."; exit 0 }

$env:TURSO_DATABASE_URL = 'libsql://work-calendar-yeoseon.turso.io'
$sec = Read-Host "Turso 토큰을 붙여넣고 Enter (입력은 화면에 보이지 않습니다)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$env:TURSO_AUTH_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
if ([string]::IsNullOrWhiteSpace($env:TURSO_AUTH_TOKEN)) { Write-Host "토큰이 비어 있습니다." -ForegroundColor Red; exit 1 }

Write-Host ""
try {
  node scripts/migrate-to-turso.mjs --force
} finally {
  Remove-Item Env:TURSO_AUTH_TOKEN -ErrorAction SilentlyContinue
}
Write-Host ""
Write-Host "끝났습니다. 위에 '완료: 총 ○○건' 이 보이면 성공입니다." -ForegroundColor Green
Write-Host "이전 전용 토큰을 새로 만드셨다면 Turso 에서 삭제(Revoke)하세요."
