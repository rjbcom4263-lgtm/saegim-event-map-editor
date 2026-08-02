@echo off
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  start "새김 행사 지도 서버" cmd /k "cd /d ""%~dp0"" && py -m http.server 8080"
) else (
  where python >nul 2>nul
  if %errorlevel%==0 (
    start "새김 행사 지도 서버" cmd /k "cd /d ""%~dp0"" && python -m http.server 8080"
  ) else (
    echo Python을 찾을 수 없습니다.
    echo VS Code Live Server 또는 다른 로컬 웹서버로 index.html을 실행하세요.
    pause
    exit /b 1
  )
)
timeout /t 2 /nobreak >nul
start "" "http://localhost:8080"
