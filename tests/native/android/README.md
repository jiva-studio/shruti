# Native Android tests

Drives the real APK on an emulator through Appium's UiAutomator2 driver. It
covers what the browser suite (`tests/e2e/mobile`) cannot reach: the Capacitor
bridge, the media session, downloads on disk, permissions, system keys and
process death.

## Layout

```
src/ports/       what a test may do to the system (AppLifecycle, MediaSession, …)
src/adapters/    how it is done (adb, Appium, the mock server)
src/screens/     page objects — the only place selectors live
src/flows/       user-level journeys the specs compose
src/world.ts     composition root
specs/           behaviour only
```

## Prerequisites

- `lectorium-emulator` on PATH (declared in dotfiles, see
  `personal/projects/jiva-studio/lectorium.nix`) and the `lectorium_api36` AVD
  running on port 5556 — the `mobile-emulator-run` skill sets both up.
- `NIX_LD_LIBRARY_PATH` — Appium downloads an unpatched chromedriver to reach
  the WebView, and nix-ld needs glib/nss/nspr/libxcb to run it. The dev shell
  exports it.

## Building the APK under test

The suite never builds; it installs whatever is at
`modules/apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

Build it pointed at the mock server, so no test traffic reaches production:

```bash
cd modules
bash db-sync.sh android          # bundle the catalog, or the app downloads it at every start
cd apps/mobile
export VITE_DEV_REGION='{"id":"dev","name":"Mock",
  "urlTemplate":"http://localhost:11090/{path}",
  "authBaseUrl":"http://localhost:11090/auth",
  "chatBaseUrl":"http://localhost:11090",
  "profileBaseUrl":"http://localhost:11090",
  "orchestratorBaseUrl":"http://localhost:11090",
  "discoveryBaseUrl":"http://localhost:11090",
  "shareAudioUrl":"http://localhost:11090/share/audio/excerpts",
  "shareVideoUrl":"http://localhost:11090/share/video/reels",
  "shareTranscriptUrl":"http://localhost:11090/share/transcripts"}'
npm run build && npx cap sync android
(cd android && ./gradlew assembleDebug)
```

Without that region the app talks to production: it mints anonymous users and
syncs the queue and listening history, which both pollutes the backend and
breaks isolation — a "fresh" install comes back with the previous run's data.

## Running

```bash
npm test                      # whole suite
npx wdio run ./wdio.conf.ts --spec specs/cold-start.spec.ts
```

The runner starts `tests/tools/mock-server` itself and wires `adb reverse
tcp:11090`, so `localhost` inside the APK reaches it — the same build therefore
works on a USB-attached phone.

`appium:fullReset` reinstalls the app before every spec file, so each file
starts from first-launch state.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `ANDROID_SERIAL` | `emulator-5556` | target device |
| `MOCK_PORT` | `11090` | mock server port |
| `APPIUM_PORT` | — | drive an already-running Appium instead of spawning one |
| `COLD_START_BUDGET_MS` | `6000` | threshold for the cold-start spec |
