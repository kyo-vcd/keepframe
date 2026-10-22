#!/bin/bash
# YT Downloader macOS 설치 스크립트
#   curl -fsSL https://github.com/kyo-vcd/yt-downloader/releases/latest/download/install.sh | bash
# 터미널(curl)로 받은 파일에는 '인터넷에서 받음' 표시가 붙지 않아 보안 경고 없이 바로 열린다
set -euo pipefail

APP="YT Downloader.app"
URL="https://github.com/kyo-vcd/yt-downloader/releases/latest/download/YT-Downloader-mac.zip"

[ "$(uname)" = "Darwin" ] || { echo "macOS 전용 설치 스크립트입니다."; exit 1; }
[ "$(uname -m)" = "arm64" ] || { echo "Apple Silicon(M1 이후) Mac만 지원합니다."; exit 1; }

# 관리자 권한 없이 쓸 수 있는 곳에 설치
DEST="/Applications"
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "내려받는 중…"
curl -fL --progress-bar -o "$TMP/app.zip" "$URL"
ditto -x -k "$TMP/app.zip" "$TMP"

osascript -e 'quit app "YT Downloader"' 2>/dev/null || true
rm -rf "$DEST/$APP"
mv "$TMP/$APP" "$DEST/"
xattr -cr "$DEST/$APP" 2>/dev/null || true

echo "설치 완료: $DEST/$APP"
open "$DEST/$APP"
