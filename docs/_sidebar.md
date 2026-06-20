<!-- BEGIN AUTOGEN -->
* [Home](/)
<!-- END AUTOGEN -->

<!-- USER NOTES -->
<!-- Single-repo project (shruti): a flat, hand-curated section nav — no -->
<!-- "Repositories > shruti" wrapper. Sub-groups (Chat, Flows) are nested -->
<!-- one extra level on purpose to keep long sections scannable. Preserved -->
<!-- across regeneration; if --rescan re-adds a repo hierarchy above, flatten -->
<!-- again. -->

* [**Overview**](repos/shruti/)

* **Architecture**
  * [Overview](repos/shruti/architecture/)
  * [Layer rules](repos/shruti/architecture/layers.md)
  * [Startup flow](repos/shruti/architecture/startup-flow.md)
  * [Multi-language chat & UI](repos/shruti/architecture/multilanguage.md)
  * [Attribution lookup](repos/shruti/architecture/attribution.md)
  * [Proactive messages](repos/shruti/architecture/proactive-messages.md)
  * [Authentication](repos/shruti/architecture/auth.md)
  * [Subscriptions & RevenueCat](repos/shruti/architecture/subscriptions.md)
  * [Background playlist (Pro)](repos/shruti/architecture/background-playlist.md)
  * [Observability (Langfuse)](repos/shruti/architecture/observability.md)
  * **Chat**
    * [Pipeline](repos/shruti/architecture/chat-pipeline.md)
    * [Intents & routing](repos/shruti/architecture/chat-intents.md)
    * [Mobile ↔ server protocol](repos/shruti/architecture/chat-protocol.md)
  * **Flows**
    * [Playback](repos/shruti/architecture/flows/playback.md)
    * [Transcript load](repos/shruti/architecture/flows/transcript-load.md)
    * [Content-DB refresh](repos/shruti/architecture/flows/content-db-refresh.md)
    * [Note create](repos/shruti/architecture/flows/note-create.md)
    * [Media download](repos/shruti/architecture/flows/media-download.md)

* **Domain & application**
  * [Overview](repos/shruti/domain/)
  * [Entities](repos/shruti/domain/entities.md)
  * [Value objects](repos/shruti/domain/value-objects.md)
  * [Ports](repos/shruti/domain/ports.md)
  * [Use cases](repos/shruti/api/use-cases.md)
  * [UI components](repos/shruti/components/)

* **Database**
  * [Overview](repos/shruti/db/)
  * [ER diagram](repos/shruti/db/er-diagram.md)
  * [Content DB tables](repos/shruti/db/content-db.md)
  * [User DB](repos/shruti/db/user-db.md)
  * [ID generation](repos/shruti/db/ids.md)
  * [Schema snapshot (2026-04-20)](repos/shruti/db/scheme.20260420.md)

* **Infrastructure**
  * [Overview](repos/shruti/infra/)
  * [S3 layout](repos/shruti/infra/s3-layout.md)
  * [CDN](repos/shruti/infra/cdn.md)

* **Modules & services**
  * **Plugins**
    * [Audio player](repos/shruti/modules/audio-player.md)
    * [media-downloader](repos/shruti/modules/media-downloader.md)
  * **Backend services**
    * [share-audio](repos/shruti/modules/share-audio.md)
    * [share-video](repos/shruti/modules/share-video.md)
    * [share-transcript](repos/shruti/modules/share-transcript.md)
    * [search-mcp (shruti-search)](repos/shruti/modules/search-mcp.md)
    * [cleanup-worker](repos/shruti/modules/cleanup-worker.md)

* **Runbooks**
  * [Development environment](repos/shruti/runbooks/development-environment.md)
  * [Testing & Qase](repos/shruti/runbooks/testing.md)
  * [shruti-mcp](repos/shruti/runbooks/shruti-mcp.md)
  * [track-selector](repos/shruti/runbooks/track-selector.md)
  * [RevenueCat webhook rotation](runbooks/rc-webhook-secret-rotation.md)
  * [App Store certificates](repos/shruti/runbooks/certificates.md)
  * [Storage (legacy)](repos/shruti/runbooks/storage.md)
