@echo off
rem Launch the local server (if not already running) and open the app in the default browser.
rem The page must be opened through http://127.0.0.1:8787/ ; opening web/index.html directly shows an unstyled shell.
cd /d "%~dp0.."
netstat -ano | findstr ":8787" | findstr "LISTENING" >nul && goto running
start "uni-info-hub" node server.js
ping -n 3 127.0.0.1 >nul
:running
start "" http://127.0.0.1:8787/
