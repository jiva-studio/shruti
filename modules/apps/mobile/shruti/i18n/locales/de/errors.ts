export default {
  askFailed: "Ask Sadhu konnte für dieses Zitat nicht geöffnet werden. Versuche es erneut.",
  downloadFailed: "Download fehlgeschlagen. Prüfe deine Internetverbindung und versuche es erneut.",
  downloadNotSaved:
    "Der Vortrag wurde heruntergeladen, konnte aber nicht auf dem Gerät gespeichert werden. Schaffe Speicherplatz und versuche es erneut.",
  downloadNoSource: "Für diesen Vortrag gibt es keine Datei zum Herunterladen.",
  downloadAlreadyRunning: "Dieser Vortrag wird bereits heruntergeladen.",
  downloadFailedUnknown: "Der Download ist fehlgeschlagen. Versuche es erneut.",
  filtersNotSaved:
    "Der Filter konnte nicht gespeichert werden. Beim nächsten Start wird er zurückgesetzt.",
  downloadsCacheUnavailable:
    "Dein Download-Index konnte nicht gelesen werden. Die zwischengespeicherten Dateien liegen weiterhin auf dem Speicher.",
  trackNotFound: "Vortrag nicht gefunden.",
  languageListUnavailable:
    "Sprachen konnten nicht geladen werden — es wird eine kurze Liste angezeigt.",
  dictionariesUnavailable:
    "Namen konnten nicht geladen werden — einige Bezeichnungen fehlen möglicherweise.",
  playbackFailed:
    "Diese Vorlesung konnte nicht abgespielt werden. Prüfe deine Verbindung und versuche es erneut.",
  noAudioForLecture: "Diese Vorlesung hat kein Audio.",
  translationFailed:
    "Die Übersetzung nach {language} ist fehlgeschlagen. Versuche es später erneut.",
  translationStillRunning:
    "Die Übersetzung nach {language} dauert länger als üblich — sie erscheint, sobald sie fertig ist.",
  translationCancelled: "Die Übersetzung nach {language} wurde abgebrochen.",
  transcriptLanguageUnavailable:
    "Das Transkript auf {language} konnte nicht geladen werden — der Rest wird angezeigt.",
  downloadStorageFull:
    "Speichergrenze erreicht. Entferne gehörte Vorträge oder erhöhe das Limit in den Einstellungen.",
  downloadStorageFullAction: "Trotzdem laden",
  // The storage-error screen (`views/StorageError`) — shown when the local
  // databases could not be opened at all.
  storage: {
    title: "Deine Daten konnten nicht geöffnet werden",
    description:
      "Die Datenbank mit deinen Notizen, deiner Playlist und deinem Hörverlauf ließ sich nicht öffnen, daher kann die App deine Bibliothek nicht anzeigen.",
    advice:
      "Starte die App neu und versuche es erneut. Wenn es weiterhin auftritt, gib Speicherplatz frei oder installiere die App neu.",
    retry: "Erneut versuchen",
    reset: {
      action: "Lokale Daten zurücksetzen",
      hint: "Nutze das, wenn ein Neustart nicht hilft. Der heruntergeladene Vortragskatalog bleibt erhalten.",
      confirm: {
        header: "Lokale Daten zurücksetzen?",
        message:
          "Deine Notizen, deine Playlist, dein Hörverlauf und deine Chats auf diesem Gerät werden endgültig gelöscht. Der heruntergeladene Vortragskatalog bleibt erhalten.",
        cancel: "Abbrechen",
        ok: "Zurücksetzen",
      },
      error: "Lokale Daten konnten nicht zurückgesetzt werden",
    },
  },
}
