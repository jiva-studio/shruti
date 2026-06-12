/**
 * Chat marker parsing + rendering. Split into focused modules under
 * `chatMarkers/`:
 *   - `parse.ts`      — marker grammar (regexes), `parseChatMarkers`,
 *                       `extractFollowups`, token post-processing
 *   - `renderHtml.ts` — inline-markdown → HTML (the `marked` pipeline)
 *   - `toMarkdown.ts` — `messageToMarkdown` plain-text export (copy/share)
 *
 * This barrel preserves the original `@shruti/composables/chatMarkers`
 * import path. It stays in the composition-root layer (not @lib) because
 * the rendering pipeline depends on `marked`.
 */
export type { ActionKind, ChatToken } from "./chatMarkers/parse.js"
export { parseChatMarkers, extractFollowups } from "./chatMarkers/parse.js"
export { inlineMd } from "./chatMarkers/renderHtml.js"
export type {
  VerseBodyLike,
  CiteBodyLike,
  VerseLookup,
  CiteLookup,
  MessageToMarkdownOptions,
} from "./chatMarkers/toMarkdown.js"
export { messageToMarkdown } from "./chatMarkers/toMarkdown.js"
