@echo off
rem Boot-time QQ history pull. Put a shortcut to this file in shell:startup
rem (Win+R -> shell:startup). Needs no admin rights. Output goes to data\qq-sync.log
rem No literal paths here on purpose: cmd reads .bat files as GBK, so a UTF-8
rem Chinese path would be mangled. %~dp0 is this file's own folder.
chcp 65001 >nul
cd /d "%~dp0.."
"C:\Program Files\nodejs\node.exe" src\qq-sync.js >> "data\qq-sync.log" 2>&1
