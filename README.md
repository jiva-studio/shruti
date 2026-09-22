<p align="center">
    <img src="assets/logo.png" height="184px"/>
</p>

# Shruti Engine

<p align="center"><i>
Shruti Engine is an open framework and platform for building rich audio lecture apps — listen to audio content, follow along with synchronized transcripts, take notes, and ask an AI companion grounded in the transcript corpus.
</i></p>

<p align="center">
  <img src="assets/splash.png"/>
</p>

## Overview

Shruti Engine provides an end-to-end architecture for content-heavy educational and study applications:
- **Mobile Client**: Ionic + Capacitor + Vue 3 offline-first player with synced subtitles, SQLite database, audio speed/equalizer controls, bookmarks, and background media downloads.
- **AI Companion**: Semantic search and cited Q&A over lecture transcripts with exact timestamp references.
- **Audio Processing Pipeline**: Speech recognition (ASR), denoising, transcript alignment, and audio/video clip sharing.
- **Backend Microservices**: Lightweight Go & Python services (Auth, Semantic Chat, Share Audio/Video/Transcript, Storage Sync).

## Architecture

The **mobile app** (Ionic + Capacitor + Vue 3) ships a prebuilt SQLite catalog inside the package and pulls updates from storage in the background. Audio and transcripts are served over HTTPS/S3, enabling full offline playback and reading without constant server connectivity.

The **backend** provides modular services:
- `auth`: JWT authentication supporting Google, Apple, and device identities.
- `chat`: Semantic, cited AI chat over the transcript corpus.
- `share-audio`, `share-transcript`, `share-video`: Media snippet generator for highlights.
- `shruti-mcp`: Content processing, transcript alignment, and catalog publishing pipeline.

## Repository Layout

```
modules/
├── apps/
│   ├── mobile/                 # Ionic + Capacitor + Vue 3 mobile application
│   └── web/                    # Astro + Vue web application
├── libs/
│   ├── domain/                 # Domain entities, value objects, ports
│   ├── contracts/              # Shared API & data contracts
│   └── persistence/            # DB row schemas
├── plugins/
│   ├── audio-player/           # Native Capacitor audio playback plugin
│   └── media-downloader/       # Background media download plugin
├── kit/                        # Reusable core mobile & web primitives
├── services/
│   ├── auth/                   # JWT auth service
│   ├── chat/                   # AI semantic assistant
│   ├── share-audio/            # Shareable audio clip renderer
│   ├── share-transcript/       # Shareable transcript snippet renderer
│   ├── share-video/            # Video clip renderer with waveform/subtitles
│   └── storage-sync/           # Storage synchronization worker
└── tools/
    ├── transcriber-service/    # ASR & transcript alignment service
    └── denoiser-service/       # Neural audio denoiser
```

## Getting Started

1. **Install Dependencies**: `make mobile-install`
2. **Run Dev Server**: `make mobile` (starts local mobile dev server)
3. **Build Android/iOS**: `make mobile-build`
4. **All Commands**: `make help`

## License

Shruti Engine is source-available under the [PolyForm Noncommercial License 1.0.0](./LICENSE).
