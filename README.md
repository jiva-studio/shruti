<p align="center">
    <img src="assets/logo.png" height="184px"/>
</p>

<p align="center"><i>
Shruti is your personal lecture companion — listen to lectures, follow along with synced transcripts, and save what matters. Whether you're commuting, walking, or relaxing at home, Shruti makes learning accessible on the go.
</i></p>

<p align="center">
  <img src="assets/splash.png"/>
</p>

<p align="center">
  <a href="https://apps.apple.com/us/app/listen-to-sadhu/id6745510353">
    <img src="assets/download-app-store.png" height="50" alt="Download on the App Store">
  </a>
  <a href="https://play.google.com/store/apps/details?id=studio.jiva.shruti">
    <img src="assets/download-google-play.png" height="50" alt="Get it on Google Play">
  </a>
</p>

# Features

🎓 **A library of lectures in one place**
Browse a curated catalog by author, location, source, tag, or language — all searchable full-text from your phone.

🎧 **Take your learning offline**
Download lectures for offline playback. No Wi-Fi, no problem.

📖 **Read while you listen**
Auto-synced transcripts highlight the current sentence as the lecture plays. Tap to jump, select to copy or share.

🔖 **Save what matters**
Bookmark any moment with a highlight on the transcript. Your notes are searchable and shareable, and tapping one jumps you back to the exact second.

🔥 **Build a listening habit**
A queue keeps your "up next" ready, and an activity heatmap and streak counter show your consistency at a glance.

# Architecture

Shruti is a **mobile-only app** that reads all its content directly from a public S3 bucket — there is no backend service. The app ships a prebuilt SQLite database inside the APK/IPA and pulls fresher versions from the CDN in the background; transcripts and audio are public JSON/mp3 files served over HTTPS.

The codebase follows **hexagonal / clean / DDD** architecture. Internal documentation (architecture layers, startup flow, storage layout, DB schemas) is maintained outside this repository.

# Repository layout

```
modules/
├── apps/
│   └── mobile/                 # Ionic + Capacitor 8 + Vue 3 mobile app
├── libs/
│   ├── domain/                 # Entities, value objects, domain ports (zero deps)
│   ├── application/            # Use cases (depends on @lib/domain only)
│   └── persistence/            # DB row type schemas (main + user)
├── capacitor/
│   └── audio-player/           # In-house Capacitor plugin (native Android/iOS/web)
└── tools/
    └── shruti-mcp/          # Go MCP service that owns the catalog SQLite and publishes it to S3
```

# Get involved

1. Build the mobile app: `cd modules/apps/mobile && npm install && npm run build`.
2. Run tests: `npm test` (in the mobile package).
