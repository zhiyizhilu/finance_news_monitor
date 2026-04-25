@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ====================================
echo   FinNews Monitor 启动中...
echo ====================================

echo [1/2] 编译 TypeScript...
call node_modules\.bin\tsc
if %errorlevel% neq 0 (
    echo [错误] 编译失败，请检查代码！
    pause
    exit /b 1
)

echo [2/2] 启动服务...
echo 服务将运行在 http://localhost:3000
echo 按 Ctrl+C 可停止服务
echo.

start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3000"

node dist/app.js
pause
