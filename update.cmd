@echo off
title Reminders - publish update
echo === Publishing the latest version of Reminders ===
echo.
cd /d "%~dp0worker"
call npx --yes wrangler@4 deploy
echo.
if errorlevel 1 (
  echo Something went wrong. Take a screenshot of this window and send it to Claude.
) else (
  echo Done! Click the refresh button in the Reminders app.
)
echo.
pause
