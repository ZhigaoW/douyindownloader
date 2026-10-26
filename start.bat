@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 视频下载器

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\bootstrap-windows.ps1"
set "EXITCODE=%ERRORLEVEL%"

echo.
if not "%EXITCODE%"=="0" echo 启动程序返回错误代码 %EXITCODE%。
echo 服务已停止。按任意键关闭窗口。
pause >nul
