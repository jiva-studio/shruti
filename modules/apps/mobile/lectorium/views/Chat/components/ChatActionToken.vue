<script setup lang="ts">
import router from "@lectorium/router/index.js"
import { useChatStore, type ActionState, type ChatMessage } from "@lectorium/stores/useChatStore.js"
import { useLibraryStore } from "@lectorium/stores/useLibraryStore.js"
import { useIngestStatusFor } from "@lectorium/composables/useIngestStatusFor.js"
import { useOpenAddedLecture } from "@lectorium/composables/useOpenAddedLecture.js"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import ActionCardSharePdf from "./ActionCardSharePdf.vue"
import ActionCardEnableReminder from "./ActionCardEnableReminder.vue"
import ActionCardConfigureSmartLibrary from "./ActionCardConfigureSmartLibrary.vue"
import ActionCardUpgradeToPro from "./ActionCardUpgradeToPro.vue"
import ActionCardQueueNextTrack from "./ActionCardQueueNextTrack.vue"
import ActionCardAddToLibrary from "./ActionCardAddToLibrary.vue"

// One action marker of a message, as the card its kind calls for.
const props = defineProps<{
  message: ChatMessage
  actionId: string
  actionKind: string
}>()

const chat = useChatStore()
const library = useLibraryStore()
// So a search candidate can be marked as already held; guarded, so repeated
// calls are free.
void library.ensureLoaded()

/** Where a track the chat offered is in the pipeline, and — once fetched —
 *  how it opens. The same rules the search results use. */
const ingestStatus = useIngestStatusFor()
const added = useOpenAddedLecture()

const state = (): ActionState => {
  const raw = props.message.actionStates?.[props.actionId]
  // Only the four states the UI renders; anything else collapses to pending so
  // the Confirm button stays reachable.
  if (raw === "executing" || raw === "done" || raw === "error") return raw
  return "pending"
}

/** The message's action payload for this id, but only when it is of the
 *  requested kind. */
function payload<K extends ChatActionPayload["kind"]>(
  kind: K
): Extract<ChatActionPayload, { kind: K }> | undefined {
  const a = props.message.actions?.[props.actionId]
  return a && a.kind === kind ? (a as Extract<ChatActionPayload, { kind: K }>) : undefined
}

/** The address an offered lecture came from — how the library store
 *  recognises it, whether the question is "has it", "how far along" or
 *  "can it open". */
const libraryUrl = (): string | undefined => payload("add_to_library")?.url

async function onConfirm(actionId: string, override?: { time?: string }): Promise<void> {
  // Snapshot the kind first: executeAction may mutate actionStates, and the
  // payload reference can disappear with it.
  const kind = props.message.actions?.[actionId]?.kind
  await chat.executeAction(props.message.id, actionId, override)
  // Smart Library has no feedback on the chat surface, so land the user in
  // Settings where the section reflects what was applied.
  if (kind === "configure_smart_library") void router.push("/tabs/settings")
}
</script>

<template>
  <ActionCardSharePdf
    v-if="actionKind === 'share_pdf'"
    :action-id="actionId"
    :payload="payload('share_pdf')"
    :state="state()"
    @confirm="onConfirm"
  />
  <ActionCardEnableReminder
    v-else-if="actionKind === 'enable_daily_reminder'"
    :action-id="actionId"
    :payload="payload('enable_daily_reminder')"
    :state="state()"
    @confirm="onConfirm"
  />
  <ActionCardConfigureSmartLibrary
    v-else-if="actionKind === 'configure_smart_library'"
    :action-id="actionId"
    :payload="payload('configure_smart_library')"
    :state="state()"
    @confirm="onConfirm"
  />
  <ActionCardUpgradeToPro
    v-else-if="actionKind === 'upgrade_to_pro'"
    :action-id="actionId"
    :payload="payload('upgrade_to_pro')"
    :state="state()"
    @confirm="onConfirm"
  />
  <ActionCardQueueNextTrack
    v-else-if="actionKind === 'queue_next_track'"
    :action-id="actionId"
    :payload="payload('queue_next_track')"
    :state="state()"
    @confirm="onConfirm"
  />
  <ActionCardAddToLibrary
    v-else-if="actionKind === 'add_to_library'"
    :action-id="actionId"
    :payload="payload('add_to_library')"
    :state="state()"
    :already-in-library="library.hasSource(libraryUrl() ?? '')"
    :live-status="ingestStatus(libraryUrl())"
    :selectable="added.canOpen(libraryUrl())"
    @confirm="onConfirm"
    @open="added.open(libraryUrl())"
  />
</template>
