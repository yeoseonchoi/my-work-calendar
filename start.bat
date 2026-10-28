@echo off
chcp 65001 >nul
cd /d %~dp0
if not exist node_modules call npm install
echo.
echo ==========================================
echo   업무 캘린더를 시작합니다.
echo   접속 주소:  http://localhost:3000
echo   (이 창을 닫으면 프로그램이 종료됩니다)
echo ==========================================
echo.
node server.js
pause
