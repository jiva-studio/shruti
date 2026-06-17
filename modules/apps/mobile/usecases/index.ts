/**
 * @usecases — application use cases. Pure functions that orchestrate domain
 * services + repository ports. Depends only on `@lib/domain`.
 */

export * from "./playback/playTrack.js"
export * from "./playback/loadTrackDetail.js"
export * from "./playback/loadTranscript.js"
export * from "./playback/getProgressForItem.js"

export * from "./playlist/addTrackToPlaylist.js"
export * from "./playlist/archivePlaylistItem.js"
export * from "./playlist/listPlaylistTracks.js"

export * from "./notes/createNote.js"
export * from "./notes/updateNote.js"
export * from "./notes/deleteNote.js"
export * from "./notes/searchNotes.js"
export * from "./notes/formatNoteShare.js"

export * from "./downloads/downloadMedia.js"
export * from "./downloads/removeDownloadedMedia.js"
export * from "./downloads/downloadTranscripts.js"
export * from "./downloads/removeDownloadedTranscripts.js"

export * from "./activity/getActivityOverview.js"
export * from "./activity/getDailyListeningHeatmap.js"
export * from "./activity/buildHeatmapDays.js"
export * from "./activity/computeCurrentStreak.js"

export * from "./discovery/searchAndFilterTracks.js"
export * from "./discovery/buildRecommendations.js"
export * from "./discovery/listSimilarTracksByTopic.js"

export * from "./library/reduceLocaleToLibraryLanguages.js"

export * from "./chat/buildChatUserContext.js"
export * from "./chat/addTracksToPlaylist.js"
export * from "./chat/saveCitationAsNote.js"
export * from "./chat/runChatTurn.js"
export * from "./chat/replayChatTurn.js"
export * from "./chat/submitChatFeedback.js"
export * from "./chat/recordInlineHintCooldown.js"
