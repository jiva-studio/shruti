#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
APP="$ROOT/modules/apps/mobile"

# Every service the app talks to, pointed at the mock. Without this the APK
# reaches production: it mints anonymous users and syncs the queue and the
# listening history, so a "fresh" install comes back with the last run's data.
export VITE_DEV_REGION='{"id":"dev","name":"Mock","urlTemplate":"http://localhost:11090/{path}","authBaseUrl":"http://localhost:11090/auth","chatBaseUrl":"http://localhost:11090","profileBaseUrl":"http://localhost:11090","orchestratorBaseUrl":"http://localhost:11090","discoveryBaseUrl":"http://localhost:11090","shareAudioUrl":"http://localhost:11090/share/audio/excerpts","shareVideoUrl":"http://localhost:11090/share/video/reels","shareTranscriptUrl":"http://localhost:11090/share/transcripts"}'
# Compiles in the tier seam, so a spec can run as Pro.
export SHRUTI_E2E_BUILD=1
export JAVA_HOME="${JAVA_HOME:-$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")}"

echo "[build] bundling the catalog"
bash "$ROOT/modules/db-sync.sh" android

echo "[build] web bundle"
cd "$APP"
npm run build
npx cap sync android

echo "[build] apk"
cd "$APP/android"
./gradlew assembleDebug

ls -lh "$APP/android/app/build/outputs/apk/debug/app-debug.apk"
