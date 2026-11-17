@echo off
chcp 65001 >nul
title Corrtex - installation des outils
echo.
echo  ===========================================================
echo   Corrtex : installation des outils de compilation
echo  ===========================================================
echo.
echo  Ce script installe (une seule fois) :
echo    - Rust (le langage du coeur du navigateur)
echo    - Visual Studio Build Tools (compilateur C++ de Microsoft)
echo  Windows demandera peut-etre une autorisation : acceptez-la.
echo  Duree : 10 a 20 minutes selon la connexion.
echo.
pause

where winget >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ERREUR] winget est introuvable. Installez "App Installer" depuis le Microsoft Store puis relancez ce script.
  pause
  exit /b 1
)

echo.
echo  [1/3] Visual Studio Build Tools (outils C++)...
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-source-agreements --accept-package-agreements --override "--quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

echo.
echo  [2/3] Rust...
winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements

echo.
echo  [3/3] Configuration de Rust...
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
rustup default stable-msvc

echo.
echo  ===========================================================
echo   Termine ! Lancez maintenant "2-Compiler-et-lancer.bat".
echo   (WebView2 est deja inclus dans Windows 10/11.)
echo  ===========================================================
pause
