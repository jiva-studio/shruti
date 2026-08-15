export default {
  askFailed: "Impossible d'ouvrir Ask Sadhu pour cette citation. Réessayez.",
  downloadFailed: "Échec du téléchargement. Vérifiez votre connexion internet et réessayez.",
  downloadNotSaved:
    "La conférence a été téléchargée, mais n'a pas pu être enregistrée sur votre appareil. Libérez de l'espace et réessayez.",
  downloadNoSource: "Il n'y a aucun fichier à télécharger pour cette conférence.",
  downloadAlreadyRunning: "Cette conférence est déjà en cours de téléchargement.",
  downloadFailedUnknown: "Le téléchargement a échoué. Réessayez.",
  filtersNotSaved:
    "Impossible d'enregistrer le filtre. Il sera réinitialisé au prochain lancement.",
  downloadsCacheUnavailable:
    "Impossible de lire l'index de vos téléchargements. Les fichiers en cache sont toujours sur le disque.",
  trackNotFound: "Conférence introuvable.",
  languageListUnavailable: "Impossible de charger les langues — liste réduite affichée.",
  dictionariesUnavailable: "Impossible de charger les noms — certaines étiquettes peuvent manquer.",
  playbackFailed: "Impossible de lire ce cours. Vérifiez votre connexion et réessayez.",
  noAudioForLecture: "Ce cours n'a pas d'audio.",
  translationFailed: "La traduction en {language} a échoué. Réessayez plus tard.",
  translationStillRunning:
    "La traduction en {language} prend plus de temps que d'habitude — elle apparaîtra dès qu'elle sera prête.",
  translationCancelled: "La traduction en {language} a été annulée.",
  transcriptLanguageUnavailable:
    "Impossible de charger la transcription en {language} — le reste est affiché.",
  downloadStorageFull:
    "Limite de stockage atteinte. Supprimez les cours écoutés ou augmentez la limite dans les réglages.",
  downloadStorageFullAction: "Télécharger quand même",
  // The storage-error screen (`views/StorageError`) — shown when the local
  // databases could not be opened at all.
  storage: {
    title: "Impossible d'ouvrir vos données",
    description:
      "La base de données contenant vos notes, votre playlist et votre historique d'écoute ne s'est pas ouverte, l'application ne peut donc pas afficher votre bibliothèque.",
    advice:
      "Redémarrez l'application et réessayez. Si cela persiste, libérez de l'espace sur l'appareil ou réinstallez l'application.",
    retry: "Réessayer",
    reset: {
      action: "Réinitialiser les données locales",
      hint: "À utiliser si le redémarrage ne suffit pas. Le catalogue de conférences téléchargé est conservé.",
      confirm: {
        header: "Réinitialiser les données locales ?",
        message:
          "Vos notes, votre playlist, votre historique d'écoute et vos discussions enregistrés sur cet appareil seront définitivement supprimés. Le catalogue de conférences téléchargé est conservé.",
        cancel: "Annuler",
        ok: "Réinitialiser",
      },
      error: "Impossible de réinitialiser les données locales",
    },
  },
}
