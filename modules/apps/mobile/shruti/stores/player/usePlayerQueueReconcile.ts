import {
  createQueueJournalReconciler,
  type QueueJournalReconciler,
} from "@usecases/playback/reconcileQueueJournal.js"
import { useShruti } from "@shruti/shruti.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { reportError } from "@shruti/services/monitoring/reportError.js"

/** The native transition journal folded into the listening history of this app. */
export function usePlayerQueueReconcile(): QueueJournalReconciler {
  const app = useShruti()
  return createQueueJournalReconciler({
    markers: app.preferences,
    listeningSessions: () => app.repositories().listeningSessions,
    playlist: usePlaylistStore,
    engine: app.audioPlayer,
    reportError: (err) => reportError("player-queue", err),
  })
}
