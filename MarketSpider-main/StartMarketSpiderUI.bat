@echo off
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 MarketSpider_WebUI.py
  goto :eof
)

where python >nul 2>nul
if %errorlevel%==0 (
  python MarketSpider_WebUI.py
  goto :eof
)

echo Python was not found. Please install Python 3.8 or later.
pause
