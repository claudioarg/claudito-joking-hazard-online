@echo off
setlocal
cd /d "%~dp0"

echo.
echo ============================================
echo Joking Hazard - Modo instalable en telefono
echo ============================================
echo.
echo 1) Se abrira el servidor en otra ventana.
echo 2) Luego se creara un link HTTPS para iPhone/Android.
echo.

start "Joking Hazard Server" cmd /k "cd /d %~dp0server && node server.js"

echo Espera a que la otra ventana muestre: http://localhost:3000
set /p READY=Cuando ya este listo, presiona ENTER aqui...

echo.
echo Creando tunel HTTPS publico con localtunnel...
echo Copia la URL https://xxxxx.loca.lt y abrila desde tu telefono.
echo.
npx --yes localtunnel --port 3000

echo.
echo Si se cerro el tunel, vuelve a ejecutar este .bat.
pause
