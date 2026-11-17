@echo off
chcp 65001 >nul
title Corrtex - compilation
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "%~dp0src-tauri"

where cargo >nul 2>nul
if errorlevel 1 (
  echo  [ERREUR] Rust n'est pas installe. Lancez d'abord "1-Installer-les-outils.bat".
  pause
  exit /b 1
)

echo.
echo  Compilation de Corrtex (la premiere fois : 5 a 10 minutes, ensuite bien plus rapide)...
echo.
cargo build --release
if errorlevel 1 (
  echo.
  echo  [ERREUR] La compilation a echoue. Copiez le message ci-dessus et envoyez-le a Claude.
  pause
  exit /b 1
)

copy /y "target\release\corrtex.exe" "%~dp0Corrtex.exe" >nul
echo.
echo  OK ! Corrtex.exe est pret dans le dossier du projet. Lancement...
start "" "%~dp0Corrtex.exe"
timeout /t 3 >nul
