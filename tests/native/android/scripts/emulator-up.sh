#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/env.sh"

AVD="${AVD:-lectorium_api36}"
PORT="${ANDROID_SERIAL##*-}"

if adb -s "$ANDROID_SERIAL" shell true >/dev/null 2>&1; then
  echo "[emulator] $ANDROID_SERIAL already up"
  exit 0
fi

if ! command -v lectorium-emulator >/dev/null 2>&1; then
  echo "[emulator] lectorium-emulator is not on PATH — the system has not been"
  echo "[emulator] rebuilt since it was declared. In the dotfiles checkout:"
  echo "[emulator]   ./build.sh <this host>"
  exit 1
fi

echo "[emulator] booting $AVD on port $PORT"
lectorium-emulator -avd "$AVD" -port "$PORT" -no-snapshot-save -gpu host >/dev/null 2>&1 &

until [ "$(adb -s "$ANDROID_SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
  sleep 5
done
echo "[emulator] $ANDROID_SERIAL booted"
