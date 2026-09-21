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

# Where the emulator binary is differs per SDK packaging — some split it out
# of $ANDROID_HOME entirely. EMULATOR= names it when none of the usual places
# has it; keep that in the environment, not here.
if [ -n "${EMULATOR:-}" ]; then
  :
elif [ -n "${ANDROID_HOME:-}" ] && [ -x "$ANDROID_HOME/emulator/emulator" ]; then
  EMULATOR="$ANDROID_HOME/emulator/emulator"
elif [ -n "${ANDROID_SDK_ROOT:-}" ] && [ -x "$ANDROID_SDK_ROOT/emulator/emulator" ]; then
  EMULATOR="$ANDROID_SDK_ROOT/emulator/emulator"
elif command -v shruti-emulator >/dev/null 2>&1; then
  # The dev-shell wrapper (see README). It carries its own ANDROID_HOME, so it
  # works where the ambient one points at an SDK without the emulator package
  # — which is exactly when a bare `emulator` on PATH is the broken one. Hence
  # ahead of it: preferred if present, never required.
  EMULATOR=shruti-emulator
elif command -v emulator >/dev/null 2>&1; then
  EMULATOR=emulator
else
  echo "[emulator] no emulator binary found. Install the Android SDK emulator,"
  echo "[emulator] or name it: EMULATOR=/path/to/emulator make native-emulator"
  exit 1
fi

if ! command -v "$EMULATOR" >/dev/null 2>&1 && [ ! -x "$EMULATOR" ]; then
  echo "[emulator] EMULATOR=$EMULATOR is not runnable"
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
