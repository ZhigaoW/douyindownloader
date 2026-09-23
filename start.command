#!/bin/bash
cd "$(dirname "$0")" || exit 1
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/usr/local/go/bin"
export DOWNLOAD_DIR="${DOWNLOAD_DIR:-$PWD/downloads}"
if [ ! -x ./bin/douyin-downloader ]; then
  if ! command -v go >/dev/null 2>&1; then
    echo "未找到可执行文件。请安装 Go 1.22 或更高版本后重新启动：https://go.dev/dl/"
    read -r -p "按回车关闭窗口…"
    exit 1
  fi
  mkdir -p bin
  go build -trimpath -ldflags="-s -w" -o bin/douyin-downloader ./cmd/douyin-downloader || { read -r -p "编译失败，按回车关闭窗口…"; exit 1; }
fi
./bin/douyin-downloader
status=$?
if [ "$status" -ne 0 ]; then
  read -r -p "启动失败，请查看上面的提示。按回车关闭窗口…"
fi
exit "$status"
