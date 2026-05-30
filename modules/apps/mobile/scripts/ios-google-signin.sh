#!/usr/bin/env bash
#
# Keep the iOS Google Sign-In config in Info.plist in lock-step with the
# iOS client id baked into the web bundle (vite.config.ts reads the same
# LECTORIUM_GOOGLE_IOS_CLIENT_ID env var as __GOOGLE_IOS_CLIENT_ID__).
#
# The committed Info.plist already carries the *default* client id, so a
# plain `npx cap sync` + Xcode build works with no env setup. This script
# only does something when LECTORIUM_GOOGLE_IOS_CLIENT_ID overrides that
# default — it rewrites GIDClientID and the reversed-client-id URL scheme
# so the OAuth redirect routes back to the app instead of crashing.
#
# Wired into fastlane's before_all (after `cap sync`). Idempotent.
set -euo pipefail

CLIENT_ID="${LECTORIUM_GOOGLE_IOS_CLIENT_ID:-}"

# No override → committed default stands. Nothing to do.
if [[ -z "$CLIENT_ID" ]]; then
  echo "[ios-google-signin] LECTORIUM_GOOGLE_IOS_CLIENT_ID unset — keeping Info.plist default"
  exit 0
fi

# modules/apps/mobile (parent of scripts/)
MOBILE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$MOBILE_ROOT/ios/App/App/Info.plist"
PLIST_BUDDY="/usr/libexec/PlistBuddy"

if [[ ! -f "$PLIST" ]]; then
  echo "[ios-google-signin] Info.plist not found at $PLIST" >&2
  exit 1
fi

# Reversed-client-id scheme = client id with the .apps.googleusercontent.com
# suffix stripped, prefixed with com.googleusercontent.apps.
SUFFIX=".apps.googleusercontent.com"
PROJECT="${CLIENT_ID%"$SUFFIX"}"
if [[ "$PROJECT" == "$CLIENT_ID" ]]; then
  echo "[ios-google-signin] '$CLIENT_ID' is not a *$SUFFIX client id" >&2
  exit 1
fi
REVERSED="com.googleusercontent.apps.$PROJECT"

# PlistBuddy `Set` fails if the key is absent; the committed plist always has
# both keys, so Set is enough (no add/delete dance).
"$PLIST_BUDDY" -c "Set :GIDClientID $CLIENT_ID" "$PLIST"
"$PLIST_BUDDY" -c "Set :CFBundleURLTypes:0:CFBundleURLSchemes:0 $REVERSED" "$PLIST"

echo "[ios-google-signin] Info.plist → $CLIENT_ID (scheme $REVERSED)"
