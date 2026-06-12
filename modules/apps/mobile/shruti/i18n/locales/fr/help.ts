export default {
  title: "Aide",
  back: "Retour",
  close: "Fermer",

  categories: {
    features: "Comment ça marche",
    settings: "Paramètres",
    data: "Vos données",
  },

  pages: {
    "what-is-sadhana": {
      title: "Qu'est-ce que la sādhana",
      summary: "La pratique spirituelle quotidienne et comment l'application la soutient",
    },
    "chat-ask-sadhu": {
      title: "Demandez à Sadhu",
      summary: "Assistant IA qui cherche dans les conférences et cite la source",
    },
    "player-controls": {
      title: "Gestes et commandes du lecteur",
      summary: "Glissement entre les panneaux, vitesse de lecture et balance stéréo→mono",
    },
    transcripts: {
      title: "Transcriptions",
      summary:
        "Lisez en suivant l'audio, naviguez par phrase et sélectionnez des fragments à enregistrer",
    },
    notes: {
      title: "Notes",
      summary: "Enregistrez des passages de conférences, réécoutez l'extrait, partagez ou exportez",
    },
    "activity-tracker": {
      title: "Suivi d'activité",
      summary: "Carte de chaleur, série de jours et temps d'écoute total",
    },
    notifications: {
      title: "Notifications et rappels",
      summary: "Rappel quotidien, heure et autorisations système",
    },
    indicators: {
      title: "Indicateurs des conférences",
      summary: "Ce que signifie chaque badge à côté d'une conférence, écran par écran",
    },
    "settings-overview": {
      title: "Aperçu des paramètres",
      summary: "Chaque groupe et chaque option des paramètres expliqués",
    },
    "smart-library": {
      title: "Bibliothèque intelligente",
      summary: "Mise à jour automatique des conférences et nettoyage après écoute (PRO)",
    },
    "delete-account": {
      title: "Suppression de votre compte",
      summary: "Ce qui est supprimé de nos serveurs et de cet appareil",
    },
    "export-import": {
      title: "Export et import",
      summary: "Sauvegarde et restauration de vos données personnelles",
    },
  },

  indicators: {
    intro:
      "Le même cercle peut signifier différentes choses selon l'écran. Voici ce que signifie chaque badge dans chaque contexte.",

    screens: {
      home: {
        title: "Accueil — votre playlist",
        description:
          "Chaque conférence ici est dans votre playlist. Le badge indique votre progression.",
      },
      search: {
        title: "Recherche et Bibliothèque",
        description:
          "Vous parcourez le catalogue. Une conférence sans badge n'est pas encore dans votre playlist.",
      },
    },

    common: {
      downloading: {
        title: "Téléchargement",
        description:
          "La conférence est en cours de téléchargement. L'anneau se remplit à mesure de la progression.",
      },
      failed: {
        title: "Échec du téléchargement",
        description:
          "Le téléchargement a été interrompu. Appuyez sur la conférence pour réessayer.",
      },
      completed: {
        title: "Terminé",
        description:
          "Vous avez terminé la conférence. Elle reste marquée pour que vous voyiez ce que vous avez écouté.",
      },
    },

    home: {
      progress: {
        title: "Progression dans cette conférence",
        description:
          "Appuyez pour écouter. L'anneau indique votre dernière position enregistrée. Sur la conférence en cours de lecture, l'anneau se remplit en temps réel pendant l'écoute.",
      },
    },

    search: {
      added: {
        title: "Ajouté à la playlist",
        description: "Cette conférence est déjà dans votre playlist.",
      },
    },
  },
}
