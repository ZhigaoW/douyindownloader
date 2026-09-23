#!/usr/bin/env bash
# Build standalone executables; frontend assets are embedded by Go.
set -euo pipefail
cd "$(dirname "$0")/.."
for target in darwin/arm64 darwin/amd64 windows/amd64; do
  os="${target%/*}"
  arch="${target#*/}"
  output="dist/${os}-${arch}"
  name=douyin-downloader
  if [ "$os" = windows ]; then name="$name.exe"; fi
  mkdir -p "$output"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" "${GO:-go}" build \
    -trimpath -ldflags="-s -w" -o "$output/$name" ./cmd/douyin-downloader
  cp docs/usage.md "$output/README.md"
  printf '已生成 %s/%s\n' "$output" "$name"
done
