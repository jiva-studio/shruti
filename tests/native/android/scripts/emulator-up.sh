#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/env.sh"

AVD="${AVD:-shruti_api36}"
PORT="${ANDROID_SERIAL##*-}"

if adb -s "$ANDROID_SERIAL" shell true >/dev/null 2>&1; then
  echo "[emulator] $ANDROID_SERIAL already up"
  exit 0
fi

# `shruti-emulator` is a thin wrapper some setups declare to pin ANDROID_HOME
# and ANDROID_AVD_HOME before exec'ing the SDK's emulator. Use it when it is
# there, otherwise take the emulator the SDK ships.
if command -v shruti-emulator >/dev/null 2>&1; then
  EMULATOR=shruti-emulator
elif [ -n "${ANDROID_HOME:-}" ] && [ -x "$ANDROID_HOME/emulator/emulator" ]; then
  EMULATOR="$ANDROID_HOME/emulator/emulator"
elif [ -n "${ANDROID_SDK_ROOT:-}" ] && [ -x "$ANDROID_SDK_ROOT/emulator/emulator" ]; then
  EMULATOR="$ANDROID_SDK_ROOT/emulator/emulator"
elif command -v emulator >/dev/null 2>&1; then
  EMULATOR=emulator
else
  echo "[emulator] no emulator binary found. Install the Android SDK emulator"
  echo "[emulator] and point ANDROID_HOME (or ANDROID_SDK_ROOT) at the SDK, or"
  echo "[emulator] put an emulator on PATH."
  exit 1
fi

if ! "$EMULATOR" -list-avds 2>/dev/null | grep -qx "$AVD"; then
  echo "[emulator] no AVD named '$AVD'. Create one (API 36, x86_64), or point"
  echo "[emulator] AVD= at an existing one: AVD=my_avd make native-emulator"
  exit 1
fi

echo "[emulator] booting $AVD on port $PORT via $EMULATOR"
"$EMULATOR" -avd "$AVD" -port "$PORT" -no-snapshot-save -gpu host >/dev/null 2>&1 &

until [ "$(adb -s "$ANDROID_SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
  sleep 5
done
echo "[emulator] $ANDROID_SERIAL booted"
