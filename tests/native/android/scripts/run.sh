#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/env.sh"
cd "$HERE/.."

APK=../../../modules/apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
if [ ! -f "$APK" ]; then
  echo "[run] no APK — build one first: make build"
  exit 1
fi

if ! adb -s "$ANDROID_SERIAL" shell true >/dev/null 2>&1; then
  echo "[run] $ANDROID_SERIAL is not up — make emulator"
  exit 1
fi

exec npx wdio run ./wdio.conf.ts "$@"
