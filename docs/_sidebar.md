<!-- BEGIN AUTOGEN -->
* [Home](/)
<!-- END AUTOGEN -->

<!-- USER NOTES -->
<!-- Single-repo project (lectorium): a flat, hand-curated section nav — no -->
<!-- "Repositories > lectorium" wrapper. Sub-groups (Chat, Flows) are nested -->
<!-- one extra level on purpose to keep long sections scannable. Preserved -->
<!-- across regeneration; if --rescan re-adds a repo hierarchy above, flatten -->
<!-- again. -->

* [**Overview**](repos/lectorium/)

* **Architecture**
  * [Overview](repos/lectorium/architecture/)
  * [Layer rules](repos/lectorium/architecture/layers.md)
  * [Startup flow](repos/lectorium/architecture/startup-flow.md)
  * [Multi-language chat & UI](repos/lectorium/architecture/multilanguage.md)
  * [Attribution lookup](repos/lectorium/architecture/attribution.md)
  * [Memory (curator context)](repos/lectorium/architecture/memory.md)
  * [Proactive messages](repos/lectorium/architecture/proactive-messages.md)
  * [Authentication](repos/lectorium/architecture/auth.md)
  * [Subscriptions & RevenueCat](repos/lectorium/architecture/subscriptions.md)
  * [Background playlist (Pro)](repos/lectorium/architecture/background-playlist.md)
  * [Observability (Langfuse)](repos/lectorium/architecture/observability.md)
  * **Chat**
    * [Pipeline](repos/lectorium/architecture/chat-pipeline.md)
    * [Intents & routing](repos/lectorium/architecture/chat-intents.md)
    * [Mobile ↔ server protocol](repos/lectorium/architecture/chat-protocol.md)
  * **Flows**
    * [Playback](repos/lectorium/architecture/flows/playback.md)
    * [Transcript load](repos/lectorium/architecture/flows/transcript-load.md)
    * [Content-DB refresh](repos/lectorium/architecture/flows/content-db-refresh.md)
    * [Note create](repos/lectorium/architecture/flows/note-create.md)
    * [Media download](repos/lectorium/architecture/flows/media-download.md)

* **Domain & application**
  * [Overview](repos/lectorium/domain/)
  * [Entities](repos/lectorium/domain/entities.md)
  * [Value objects](repos/lectorium/domain/value-objects.md)
  * [Ports](repos/lectorium/domain/ports.md)
  * [Use cases](repos/lectorium/api/use-cases.md)
  * [UI components](repos/lectorium/components/)

* **Database**
  * [Overview](repos/lectorium/db/)
  * [ER diagram](repos/lectorium/db/er-diagram.md)
  * [Content DB tables](repos/lectorium/db/content-db.md)
  * [User DB](repos/lectorium/db/user-db.md)
  * [ID generation](repos/lectorium/db/ids.md)
  * [Schema snapshot (2026-04-20)](repos/lectorium/db/scheme.20260420.md)

* **Infrastructure**
  * [Overview](repos/lectorium/infra/)
  * [S3 layout](repos/lectorium/infra/s3-layout.md)
  * [CDN](repos/lectorium/infra/cdn.md)

* **Modules & services**
  * **Plugins**
    * [Audio player](repos/lectorium/modules/audio-player.md)
    * [media-downloader](repos/lectorium/modules/media-downloader.md)
  * **Backend services**
    * [share-audio](repos/lectorium/modules/share-audio.md)
    * [share-video](repos/lectorium/modules/share-video.md)
    * [share-transcript](repos/lectorium/modules/share-transcript.md)
    * [search-mcp (lectorium-search)](repos/lectorium/modules/search-mcp.md)
    * [cleanup-worker](repos/lectorium/modules/cleanup-worker.md)

* **Runbooks**
  * [Development environment](repos/lectorium/runbooks/development-environment.md)
  * [Testing & Qase](repos/lectorium/runbooks/testing.md)
  * [lectorium-mcp](repos/lectorium/runbooks/lectorium-mcp.md)
  * [track-selector](repos/lectorium/runbooks/track-selector.md)
  * [RevenueCat webhook rotation](runbooks/rc-webhook-secret-rotation.md)
  * [App Store certificates](repos/lectorium/runbooks/certificates.md)
  * [Storage (legacy)](repos/lectorium/runbooks/storage.md)
