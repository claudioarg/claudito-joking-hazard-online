@echo off
setlocal
cd /d "%~dp0"
cd server

for /f %%i in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -notlike '127.*' } | Select-Object -First 1 -ExpandProperty IPAddress)"') do set LOCAL_IP=%%i

echo.
echo ============================================
echo Joking Hazard
echo.
echo Desde la computadora:
echo http://localhost:3000
echo.
echo Desde tu telefono en la misma red:
if defined LOCAL_IP (
  echo http://%LOCAL_IP%:3000
) else (
  echo No se pudo detectar la IP de la red. Usa la IP de tu PC y agrega :3000
)
echo.
echo ============================================
echo.
node server.js
pause
