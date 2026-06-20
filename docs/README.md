<!-- BEGIN AUTOGEN -->
# Lectorium
<!-- END AUTOGEN -->

<!-- USER NOTES -->
<!-- Single-repo project: the multi-repo "Repositories under source/" index and the
     agent-workspace layout (source/agent/docs/resources) that --rescan writes into the
     AUTOGEN block above are meaningless in shared developer docs. Keep this Home a thin
     funnel into the Overview; if --rescan re-adds that scaffolding, strip it again. -->

Internal engineering documentation for **Lectorium** — the "Shruti" lecture app (mobile app + backend services + content pipeline).

**→ Start with the [Overview](repos/lectorium/)** — what the app is, the repository layout, and the full documentation index.

Jump to a section:

- [Architecture](repos/lectorium/architecture/) — layers, startup, chat, auth, subscriptions, background playback, flows
- [Domain & application](repos/lectorium/domain/) — entities, value objects, ports, use cases
- [Database](repos/lectorium/db/) — content & user DB, ER diagram, schema
- [Infrastructure](repos/lectorium/infra/) — S3 layout, CDN
- [Modules & services](repos/lectorium/modules/audio-player.md) — Capacitor plugins + backend services
- [Runbooks](repos/lectorium/runbooks/development-environment.md) — dev environment, testing, MCP, certificates
