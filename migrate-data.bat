@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\migrate-local-to-turso.ps1"
pause

