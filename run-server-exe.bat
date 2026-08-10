@echo off
setlocal
cd /d "%~dp0server"
if not exist "dist\joking-hazard-server.exe" (
  echo No se encontro dist\joking-hazard-server.exe
  echo Ejecuta: npm run build:exe
  pause
  exit /b 1
)
echo Iniciando Joking Hazard Server...
start "Joking Hazard Server" "dist\joking-hazard-server.exe"
