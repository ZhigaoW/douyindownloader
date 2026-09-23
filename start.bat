@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not defined DOWNLOAD_DIR set "DOWNLOAD_DIR=%~dp0downloads"
if exist bin\douyin-downloader.exe goto run
where go >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Go 1.22 或更高版本：https://go.dev/dl/
  pause
  exit /b 1
)
if not exist bin mkdir bin
go build -trimpath -ldflags="-s -w" -o bin\douyin-downloader.exe ./cmd/douyin-downloader
if errorlevel 1 (
  pause
  exit /b 1
)
:run
bin\douyin-downloader.exe
pause
