<p align="center">
  <img src="assets/logo.png" height="130px" alt="Shruti Engine Logo"/>
</p>

<p align="center">
  <strong>The open-source audio lecture platform & semantic intelligence engine</strong>
</p>

<p align="center">
  <a href="https://github.com/jiva-studio/shruti/actions/workflows/services-ghcr.yml"><img src="https://github.com/jiva-studio/shruti/actions/workflows/services-ghcr.yml/badge.svg" alt="CI"/></a>
  <a href="https://github.com/jiva-studio/shruti/releases"><img src="https://img.shields.io/github/v/release/jiva-studio/shruti?color=blue" alt="Release"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg" alt="License"/></a>
</p>

<p align="center">
  Shruti Engine powers rich audio lecture applications — listen to audio content, follow along with synchronized transcripts, take notes, and interact with an AI companion grounded in the transcript corpus.
</p>

<p align="center">
  <img src="assets/splash.png" alt="Shruti App Preview"/>
</p>

## Architecture & Services

Shruti Engine is structured as a clean, modular microservice platform:

### Core Microservices (`modules/services/`)
- **`chat`** (Python / FastAPI / LangGraph): Semantic AI companion grounded in lecture transcripts with exact timestamp attributions.
- **`discovery`** (Go / PgVector): Semantic search, vector embeddings, entity extraction, and content discovery.
- **`auth`** (Go): JWT authentication supporting OAuth (Google, Apple) and device identities.
- **`orchestrator` & `ingest`** (Go): Audio processing pipeline orchestration and worker jobs.
- **`billing` & `profile`** (Go): User profile, preferences, listen history sync, and subscription entitlement management.
- **`share-audio`, `share-video`, `share-transcript`** (Go / Python): Dynamic snippet rendering (audiograms, subtitles, waveforms, and cards).
- **`shruti-corpus-mcp`** (Go): Model Context Protocol (MCP) server for corpus querying and tools.
- **`storage-sync` & `cleanup-worker`** (Go): Object storage sync, cache invalidation, and background maintenance.

### Client Applications (`modules/apps/`)
- **`mobile`** (Ionic / Capacitor / Vue 3): Offline-first cross-platform mobile player with synced transcripts, embedded SQLite database, and background audio controls.

### Audio Pipeline Tools (`modules/tools/`)
- **`transcriber-service`**: Speech recognition (ASR) and transcript alignment service.
- **`denoiser-service`**: Neural audio denoiser.

### Infrastructure (`infra/`)
- **`app/compose/`**: Docker Compose configurations for local development and production VPS.
- **`app/compose/caddy/`**: Reverse proxy with automatic SSL and metrics routing.
- **`observability/`**: Prometheus, Loki, Grafana, and alerting configurations.

## Quick Start

### Running the Backend Stack
```bash
# Setup development environment and generate local secrets
make stack-setup

# Start the full stack with Docker Compose
make stack-up

# Check service health and readiness
make stack-status
```

## License

Shruti Engine is source-available under the [PolyForm Noncommercial License 1.0.0](./LICENSE).
