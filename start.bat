@echo off
chcp 65001 >nul
echo ==========================================
echo    聊天服务器 + cpolar 内网穿透 一键启动
echo ==========================================
echo.

REM 优先使用系统 node，否则用内置 node
where node >nul 2>&1
if %errorlevel% equ 0 (
    set "NODE=node"
    set "NPM=npm"
) else (
    set "NODE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.12.0\node.exe"
    set "NPM=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.12.0\npm.cmd"
)

REM 检查 node
if not exist "%NODE%" (
    set "NODE=node"
)

echo [1/3] 安装服务器依赖...
cd /d "%~dp0"
"%NODE%" "%~dp0node_modules\.bin\npm" install 2>nul || "%NPM%" install
if %errorlevel% neq 0 (
    echo [错误] 依赖安装失败，请检查网络
    pause
    exit /b 1
)

echo.
echo [2/3] 启动聊天服务器（端口 3000）...
start "聊天服务器 - 请勿关闭" cmd /k ""%NODE%" "%~dp0server.js""
timeout /t 3 /nobreak >nul

REM 检查服务器是否启动成功
curl -s http://localhost:3000 >nul 2>&1
if %errorlevel% equ 0 (
    echo     ✅ 服务器启动成功！
) else (
    echo     ⏳ 服务器启动中...
)

echo.
echo [3/3] 启动 cpolar 内网穿透...
where cpolar >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo ========================================
    echo   ⚠️  未检测到 cpolar，请按以下步骤安装：
    echo ========================================
    echo.
    echo   1. 打开浏览器访问：https://www.cpolar.cn
    echo   2. 注册免费账号（邮箱注册）
    echo   3. 登录后进入"下载"页面，下载 Windows 版
    echo   4. 解压 zip 文件，把 cpolar.exe 复制到：
    echo      %~dp0
    echo   5. 回到控制台，点击"验证"，复制 authtoken 命令
    echo      格式：cpolar authtoken xxxxxxxxxx
    echo   6. 在此目录打开命令行，运行上面的命令
    echo   7. 重新双击 start.bat 启动
    echo.
    echo ----------------------------------------
    echo   现在服务器已在本地运行：
    echo   http://localhost:3000
    echo.
    echo   局域网内手机可用（手机和电脑同WiFi）：
    for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /i "IPv4"') do (
        set ip=%%i
        set ip=!ip: =!
        echo   http://!ip!:3000
    )
    echo ----------------------------------------
    pause
    exit /b 0
)

start "cpolar 内网穿透 - 请勿关闭" cmd /k "cpolar http 3000"
timeout /t 3 /nobreak >nul

echo.
echo ==========================================
echo  ✅ 全部启动成功！
echo.
echo  请在"cpolar 内网穿透"窗口中查看公网地址
echo  格式类似：https://abc123.cpolar.cn
echo.
echo  把这个地址填入 Flutter 项目的：
echo    flutter_app\lib\services\config.dart
echo.
echo  static const String serverUrl = 'https://xxx.cpolar.cn';
echo ==========================================
pause
