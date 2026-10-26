#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

VERSION_FILE="$SCRIPT_DIR/node-version.txt"
if [[ ! -f "$VERSION_FILE" ]]; then
  printf '错误：缺少 scripts/node-version.txt，无法确定 Node.js 版本。\n' >&2
  exit 1
fi
NODE_VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
if [[ -z "$NODE_VERSION" ]]; then
  printf '错误：scripts/node-version.txt 内容为空。\n' >&2
  exit 1
fi

log() { printf '%s\n' "$*"; }
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }

node_supported() {
  "$1" -e 'process.exit(process.features.typescript ? 0 : 1)' >/dev/null 2>&1
}

node_exe=""
system_node="$(command -v node 2>/dev/null || true)"
if [[ -n "$system_node" ]] && node_supported "$system_node"; then
  log "使用系统 Node.js $("$system_node" --version 2>/dev/null)"
  node_exe="$system_node"
elif [[ -n "$system_node" ]]; then
  log '系统 Node.js 版本过低，需要 22.18 或更高，将使用便携版。'
fi

case "$(uname -s)" in
  Darwin) platform='darwin' ;;
  Linux) platform='linux' ;;
  *) fail "暂不支持该系统：$(uname -s)" ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch='x64' ;;
  arm64|aarch64) arch='arm64' ;;
  *) fail "暂不支持该架构：$(uname -m)" ;;
esac

runtime_root="$ROOT/.runtime"
portable_dir="$runtime_root/node-$NODE_VERSION-$platform-$arch"
portable_node="$portable_dir/bin/node"

if [[ -z "$node_exe" && -x "$portable_node" ]] && node_supported "$portable_node"; then
  node_exe="$portable_node"
fi

if [[ -z "$node_exe" ]]; then
  mkdir -p "$runtime_root"
  filename="node-$NODE_VERSION-$platform-$arch.tar.gz"
  archive="$runtime_root/$filename"
  checksums="$runtime_root/SHASUMS256-$platform-$arch.txt"
  official="https://nodejs.org/dist/$NODE_VERSION"
  mirror="https://npmmirror.com/mirrors/node/$NODE_VERSION"

  download() {
    local url="$1" dest="$2"
    if command -v curl >/dev/null 2>&1; then
      curl -fL --retry 3 --connect-timeout 20 -o "$dest" "$url"
    elif command -v wget >/dev/null 2>&1; then
      wget -q -O "$dest" "$url"
    else
      return 1
    fi
  }

  log "首次运行：正在下载便携版 Node.js $NODE_VERSION ($platform-$arch) ..."
  downloaded=0
  for base in "$official" "$mirror"; do
    log "  正在连接 $base"
    if download "$base/$filename" "$archive" && download "$base/SHASUMS256.txt" "$checksums"; then
      downloaded=1
      break
    fi
    rm -f "$archive" "$checksums"
    log '  下载失败，尝试备用线路 ...'
  done
  if [[ "$downloaded" -ne 1 ]]; then
    fail 'Node.js 下载失败。请检查网络，或手动安装 Node.js 22.18+ 后重试：https://nodejs.org/'
  fi

  expected="$(awk -v f="$filename" '$2 == f { print $1; exit }' "$checksums")"
  [[ -n "$expected" ]] || fail 'Node.js 校验文件中没有找到对应条目。'
  if command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$archive" | awk '{print $1}')"
  else
    fail '需要 shasum 或 sha256sum 来校验 Node.js 下载文件。'
  fi
  [[ "$actual" == "$expected" ]] || fail 'Node.js 下载文件校验失败，请删除 .runtime 后重试。'

  log '正在解压 Node.js ...'
  tar -xzf "$archive" -C "$runtime_root" || fail 'Node.js 解压失败。'
  rm -f "$archive" "$checksums"
  [[ -x "$portable_node" ]] || fail 'Node.js 解压失败，未找到 node 可执行文件。'
  node_exe="$portable_node"
fi

if [[ "${VIDEO_DOWNLOADER_NO_BROWSER:-0}" == '1' ]]; then
  unset OPEN_BROWSER || true
else
  export OPEN_BROWSER=1
fi

log '正在启动视频下载器 ...'
log '使用期间请保持此窗口开启；按 Ctrl+C 可停止服务。'
set +e
"$node_exe" src/server.ts
status=$?
set -e
if [[ "$status" -ne 0 && "$status" -ne 130 ]]; then
  printf '服务异常退出（代码 %s）。按回车关闭 ...\n' "$status"
  read -r _ || true
fi
