<p align="center">
  <img src="assets/logo.png" height="140px" alt="Shruti Engine Logo"/>
</p>

<p align="center">
  <strong>The open-source audio lecture platform & semantic intelligence engine</strong>
</p>

<p align="center">
  <a href="https://github.com/jiva-studio/shruti/actions/workflows/services-ghcr.yml"><img src="https://github.com/jiva-studio/shruti/actions/workflows/services-ghcr.yml/badge.svg" alt="Container Images"/></a>
  <a href="https://github.com/jiva-studio/shruti/actions/workflows/services-chat-tests.yml"><img src="https://github.com/jiva-studio/shruti/actions/workflows/services-chat-tests.yml/badge.svg" alt="Chat Tests"/></a>
  <a href="https://github.com/jiva-studio/shruti/actions/workflows/services-discovery-tests.yml"><img src="https://github.com/jiva-studio/shruti/actions/workflows/services-discovery-tests.yml/badge.svg" alt="Discovery Tests"/></a>
  <a href="https://github.com/jiva-studio/shruti/actions/workflows/architecture-guard.yml"><img src="https://github.com/jiva-studio/shruti/actions/workflows/architecture-guard.yml/badge.svg" alt="Architecture Guard"/></a>
  <a href="https://github.com/jiva-studio/shruti/actions/workflows/modules-go-lint.yml"><img src="https://github.com/jiva-studio/shruti/actions/workflows/modules-go-lint.yml/badge.svg" alt="Go Lint"/></a>
  <a href="https://github.com/jiva-studio/shruti/actions/workflows/gitleaks.yml"><img src="https://github.com/jiva-studio/shruti/actions/workflows/gitleaks.yml/badge.svg" alt="Secret Scan"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg" alt="License"/></a>
</p>

<p align="center">
  Shruti Engine powers rich audio lecture applications — listen to audio content, follow along with synchronized transcripts, take notes, and interact with an AI companion grounded in the transcript corpus.
</p>

---

## 🎯 Architecture & Services

Shruti Engine is structured as a clean, hexagonal microservice monorepo:

### Core Microservices (`modules/services/`)
- **`chat`** (Python / FastAPI / LangGraph): Semantic AI companion grounded in lecture transcripts with exact timestamp attributions.
- **`discovery`** (Go / PgVector): Semantic search, vector embeddings, entity extraction, and content discovery.
- **`auth`** (Go): JWT authentication supporting OAuth (Google, Apple) and device identities.
- **`orchestrator` & `ingest`** (Go): Audio processing pipeline orchestration and worker jobs.
- **`billing` & `profile`** (Go): User profile, preferences, listen history sync, and subscription entitlement management.
- **`share-audio`, `share-video`, `share-transcript`** (Go / Python): Dynamic snippet rendering (audiograms, subtitles, waveforms, and cards).
- **`shruti-corpus-mcp`** (Go): Model Context Protocol (MCP) server for corpus querying and tools.
- **`storage-sync` & `cleanup-worker`** (Go): Object storage sync, cache invalidation, and background maintenance.

### Audio Pipeline Tools (`modules/tools/`)
- **`transcriber-service`**: Speech recognition (ASR) and transcript alignment service.
- **`denoiser-service`**: Neural audio denoiser.

### Infrastructure (`infra/`)
- **`app/compose/`**: Docker Compose configurations for local development and production VPS.
- **`app/compose/caddy/`**: Reverse proxy with automatic SSL and metrics routing.
- **`observability/`**: Prometheus, Loki, Grafana, and alerting configurations.

---

## 🚀 Quick Start

### Running the Backend Stack
```bash
# Setup development environment and generate local secrets
make stack-setup

# Start the full stack with Docker Compose
make stack-up

# Check service health and readiness
make stack-status
```

### Verification & Architecture
```bash
# Verify architectural boundaries (hexagonal/clean architecture)
make check-architecture

# Run mutation tests
make mutate-diff
```

---

## 📱 Mobile App

The client mobile application is developed in the [`listentosadhu`](https://github.com/jiva-studio/listentosadhu) repository, integrating Shruti Engine as a submodule.

---

## 📄 License

Shruti Engine is source-available under the [PolyForm Noncommercial License 1.0.0](./LICENSE).
