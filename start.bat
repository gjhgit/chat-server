@echo off
chcp 65001
echo ====================================
echo  聊天App 服务器启动脚本
echo ====================================
echo.

cd /d "%~dp0"

echo [1/2] 安装依赖...
call npm install
if errorlevel 1 (
    echo 错误：npm install 失败，请确保已安装 Node.js
    pause
    exit /b 1
)

echo.
echo [2/2] 启动服务器...
echo.

REM 获取本机IP
echo 你的局域网IP地址：
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
    echo   %%a
)
echo.
echo ⚠️  请把 flutter_app/lib/services/config.dart 中的 serverHost 改为上面的IP
echo.
echo 服务器启动在端口 3000，按 Ctrl+C 停止
echo.

node server.js
pause
