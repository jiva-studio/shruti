# Native Android tests

Drives the real APK on an emulator through Appium's UiAutomator2 driver. It
covers what the browser suite (`tests/e2e/mobile`) cannot reach: the Capacitor
bridge, the media session, downloads on disk, permissions, system keys and
process death.

## What belongs here

A test lives here only if it **breaks when the platform is swapped** — that is,
it checks behaviour that does not exist in a browser. Anything expressible
through the DOM and network mocks belongs in `tests/e2e/mobile`, where it costs
seconds instead of minutes and needs no emulator.

| layer | scope |
|---|---|
| `modules/apps/mobile` (vitest) | pure logic: stores, migrations, formatters, rules |
| `tests/e2e/mobile` (Playwright) | product behaviour: queue, limits, retries, failover, sync logic, i18n, layout, screen states |
| `tests/native/android` (Appium) | the Capacitor bridge and the OS: media session and shade, foreground service, files on a real disk, runtime permissions, system keys and intents, process lifecycle, system configuration, the real SQLite engine |

When an invariant is already covered in the web suite, keep **one smoke** here —
"this path works on a device" — and leave the branches and edge cases there.
`download-offline`, `offline-start`, `dark-mode` and `keyboard` are exactly
that: single smokes over paths the web suite explores in depth.

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

- `shruti-emulator` on PATH (declared in dotfiles, see
  `personal/projects/jiva-studio/shruti.nix`) and the `shruti_api36` AVD
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
export SHRUTI_E2E_BUILD=1   # compiles in the tier seam, so a spec can run as Pro
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

Specs that need Pro set the tier through `entitlement.set("pro")`, which only
works in a build made with `SHRUTI_E2E_BUILD=1`. Send the app to the
background before restarting it afterwards: the WebView flushes `localStorage`
lazily, and `force-stop` drops the write.

The date specs (`midnight-split`, `timezone-change`, `activity-streak`) move the
device's clock and timezone through the `Clock` port, which runs each setter
through `su` on the userdebug image. `adb root` would do as well but restarts
adbd, and that drops the `adb reverse` to the mock and Appium's own channel
mid-run. The specs snapshot the clock in `before` and put it back in `after`; a
run killed in between leaves the emulator on a fake date, and every later spec
then dates its data wrong — reset it with
`adb -s emulator-5556 shell su 0 date -u MMDDhhmmYYYY.ss` before trusting the
next run.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `ANDROID_SERIAL` | `emulator-5556` | target device |
| `MOCK_PORT` | `11090` | mock server port |
| `APPIUM_PORT` | — | drive an already-running Appium instead of spawning one |
| `COLD_START_BUDGET_MS` | `6000` | threshold for the cold-start spec |
