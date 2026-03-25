@echo off
chcp 65001 >nul
echo ==========================================
echo    聊天服务器 + cpolar 内网穿透 一键启动
echo ==========================================
echo.

REM 检查 Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装：
    echo   下载地址：https://nodejs.org
    pause
    exit /b 1
)

echo [1/3] 安装服务器依赖...
cd /d "%~dp0"
call npm install
if %errorlevel% neq 0 (
    echo [错误] npm install 失败
    pause
    exit /b 1
)

echo.
echo [2/3] 启动聊天服务器（端口 3000）...
start "聊天服务器" cmd /k "node server.js"
timeout /t 2 /nobreak >nul

echo.
echo [3/3] 启动 cpolar 内网穿透...
where cpolar >nul 2>&1
if %errorlevel% neq 0 (
    echo [提示] 未检测到 cpolar，请先安装：
    echo.
    echo   方法一（推荐）：
    echo     1. 打开 https://www.cpolar.cn  注册账号
    echo     2. 下载 Windows 版 cpolar
    echo     3. 解压后把 cpolar.exe 放到这个目录
    echo     4. 重新运行本脚本
    echo.
    echo   方法二（命令行安装）：
    echo     winget install cpolar
    echo.
    echo   安装后，先运行一次认证：
    echo     cpolar authtoken 你的token
    echo.
    echo ----------------------------------------
    echo   服务器已在本地运行：http://localhost:3000
    echo   局域网内可用 http://[本机IP]:3000 访问
    echo ----------------------------------------
    pause
    exit /b 0
)

start "cpolar 穿透" cmd /k "cpolar http 3000"
echo.
echo ==========================================
echo  ✅ 启动成功！
echo.
echo  请在 cpolar 窗口中查看公网地址，格式：
echo    https://xxxxxx.cpolar.cn
echo.
echo  把这个地址填入 Flutter 项目的：
echo    flutter_app\lib\services\config.dart
echo    static const String serverUrl = 'https://xxxxxx.cpolar.cn';
echo ==========================================
echo.
pause
