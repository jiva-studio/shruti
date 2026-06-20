<!-- BEGIN AUTOGEN -->
# Shruti
<!-- END AUTOGEN -->

<!-- USER NOTES -->
<!-- Single-repo project: the multi-repo "Repositories under source/" index and the
     agent-workspace layout (source/agent/docs/resources) that --rescan writes into the
     AUTOGEN block above are meaningless in shared developer docs. Keep this Home a thin
     funnel into the Overview; if --rescan re-adds that scaffolding, strip it again. -->

Internal engineering documentation for **Shruti** — the "Shruti" lecture app (mobile app + backend services + content pipeline).

**→ Start with the [Overview](repos/shruti/)** — what the app is, the repository layout, and the full documentation index.

Jump to a section:

- [Architecture](repos/shruti/architecture/) — layers, startup, chat, auth, subscriptions, background playback, flows
- [Domain & application](repos/shruti/domain/) — entities, value objects, ports, use cases
- [Database](repos/shruti/db/) — content & user DB, ER diagram, schema
- [Infrastructure](repos/shruti/infra/) — S3 layout, CDN
- [Modules & services](repos/shruti/modules/audio-player.md) — Capacitor plugins + backend services
- [Runbooks](repos/shruti/runbooks/development-environment.md) — dev environment, testing, MCP, certificates
