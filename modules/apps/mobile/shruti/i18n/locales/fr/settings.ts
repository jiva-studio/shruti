export default {
  groups: {
    subscription: "Abonnement",
    account: "Compte",
    appearance: "Apparence",
    library: "Bibliothèque",
    chat: "Demandez à Sadhu",
    contacts: "Nous contacter",
    status: "Statut",
    sadhana: "Sādhana",
    data: "Données",
    help: "Aide",
    debug: "Débogage",
    danger: "Zone sensible",
    about: "À propos",
  },
  libraryLanguages: {
    title: "Langues des conférences",
    description:
      "Afficher les conférences dans ces langues dans la recherche, les sujets et les recommandations.",
  },

  account: {
    signInCta: {
      title: "Se connecter",
      description: "Conservez votre progression",
    },
    signInWithGoogle: "Continuer avec Google",
    signInWithApple: "Continuer avec Apple",
    signedIn: "Vous êtes connecté",
    // Subtitle for the signed-in row when the auth provider didn't
    // expose email/picture (RU region: no personal data by design;
    // also any OAuth flow that withheld the profile). Reassures the
    // user that their session is still attached to something
    // persistent even without a visible identity.
    signedInNoDataSubtitle: "Votre progression est en sécurité",
    signOut: "Se déconnecter",
    deleteAccount: {
      title: "Supprimer le compte",
      confirmWipe: "Supprimer le compte et effacer les données",
      confirmKeep: "Supprimer le compte, conserver mes données",
      errorToast: "Impossible de supprimer le compte. Veuillez réessayer.",
      alreadyDeletedToast: "Votre compte est déjà supprimé.",
      rateLimitedToast: "Veuillez patienter un peu avant de réessayer.",
      networkErrorToast: "Pas de connexion. Vérifiez votre internet et réessayez.",
      serverErrorToast:
        "Un problème est survenu de notre côté. Veuillez réessayer dans un instant.",
    },
  },

  subscription: {
    title: "Abonnement",
    description: "Gestion de l'abonnement",
    subscriptionIsActive: "L'abonnement est actif",
    tapToManage: "Appuyez pour voir ou gérer",
    choose: "Soutenir « Shruti »",
    subscribe: "S'abonner",
    trialBadge: "{days} jours gratuits",
    trialThenPrice: "puis {price} / {period}",
    startFreeTrial: "Essai gratuit",
    trialDisclaimer:
      "Annulable à tout moment. À la fin de l'essai, l'abonnement se renouvelle automatiquement.",
    disclaimer: "Annulable à tout moment. L'abonnement se renouvelle automatiquement.",
    subscribed: "Abonnement effectué",
    unavailable: "Les achats intégrés ne sont pas disponibles sur cet appareil.",
    manage: "Gérer l'abonnement",
    restore: "Restaurer",
    restored: "Votre abonnement a été restauré avec succès !",
    error: "Une erreur s'est produite lors de l'opération. Veuillez réessayer.",
    noSubscriptionFound:
      "Aucun abonnement actif trouvé. Veuillez vous abonner pour accéder aux fonctionnalités premium.",
    thanks:
      "Merci pour votre abonnement et votre soutien 🙏 Que votre cœur se remplisse de bonheur et que chaque jour vous rapproche de la Vérité. Nous sommes heureux de vous compter parmi nous sur ce chemin.",
    benefits: {
      progress: {
        title: "Suivez votre progression",
        description: "Suivez votre série d'écoute et reprenez là où vous vous êtes arrêté.",
      },
      andMore: {
        title: "Et bien plus encore",
        description: "Lecture continue, partage, le studio de notes et bien plus encore.",
      },
      intro:
        "Nous mettons en place de nouvelles fonctionnalités et améliorations. Votre soutien nous aide à poursuivre le développement et à améliorer le produit.",
      benefit0: {
        title: "Nouvelles conférences",
        description: "Votre abonnement nous aide à ajouter de nouvelles conférences.",
      },
      benefit1: {
        title: "Signets",
        description: "Gardez les moments clés d'une conférence pour y revenir ou partager.",
      },
      benefit2: {
        title: "Bibliothèque intelligente",
        description: "Garde de nouvelles conférences sur l'appareil et efface celles finies.",
      },
      benefit3: {
        title: "Séminaires et cours",
        description:
          "Ajoutez des séminaires et des cours à votre playlist pour les écouter dans l'ordre qui vous convient.",
      },
      benefit4: {
        title: "Collections dynamiques",
        description:
          "Créez des collections de conférences qui se mettront à jour automatiquement selon les critères que vous avez définis.",
      },
      sakha: {
        title: "Demandez à Sadhu",
        description: "Cherche dans conférences, audio et livres et explique l'enseignement.",
      },
      autoScroll: {
        title: "Défilement automatique",
        description: "La transcription suit l'audio, le paragraphe en cours reste visible.",
      },
      continuousPlayback: {
        title: "Lecture continue",
        description:
          "Les conférences s'enchaînent — quand l'une se termine, la suivante démarre automatiquement, même écran verrouillé.",
      },
      shareTranscript: {
        title: "Partager et exporter",
        description:
          "Partagez une conférence en PDF ou en transcription texte, ou partagez l'audio — avec n'importe qui.",
      },
      notesStudio: {
        title: "Studio de notes",
        description:
          "Transformez vos notes de conférences en courtes vidéos et partagez-les avec vos amis.",
      },
      trackInfo: {
        title: "Disposition des informations",
        description:
          "Choisissez quel détail — référence, auteur, lieu, date — figure sur la ligne supérieure mise en avant sous le titre de chaque conférence, et lesquels apparaissent sur la ligne en dessous.",
      },
    },
    periods: {
      P1M: "mois",
      P3M: "3 mois",
      P6M: "6 mois",
      P1Y: "an",
    },
    plans: {
      $rc_monthly: "Mensuel",
      $rc_three_month: "Trimestriel",
      $rc_six_month: "Semestriel",
      $rc_annual: "Annuel",
    },
    legal: {
      privacy: "Politique de confidentialité",
      terms: "Conditions d'utilisation",
    },
  },

  help: {
    open: {
      title: "Ouvrir l'aide",
      description: "Indicateurs, paramètres et fonctionnalités expliqués",
    },
    privacyPolicy: {
      title: "Politique de confidentialité",
      description: "Ce que nous collectons, sous-traitants, suppression du compte",
    },
  },

  appLanguage: {
    title: "Langue",
    description: "Langue de l'interface",
  },

  chatLanguage: {
    title: "Langue du chat",
    description: "Langue dans laquelle Sadhu répond.",
  },

  chatTranslateCitations: {
    title: "Traduire les citations",
    description: "Traduire les citations dans la langue du chat.",
  },

  syncChats: {
    title: "Synchroniser les discussions",
    description: "Gardez vos conversations Ask Sadhu synchronisées sur tous vos appareils.",
  },

  downloadLimit: {
    title: "Limite de téléchargement",
    unlimited: "Sans limite",
    usage: "{used} sur {limit}",
    usageUnlimited: "{used} téléchargés",
  },

  smartLibrary: {
    title: "Bibliothèque intelligente",
    description: "Garder de nouvelles conférences prêtes et faire le ménage après l'écoute",
    enable: "Activer",
    hint: "L'application maintient une réserve de conférences non écoutées et retire automatiquement celles qui sont terminées. Utilisez le filtre pour choisir ce qui est mis en file.",
    sections: {
      filter: "Que télécharger",
      target: "Longueur de la file",
      archive: "Archiver après écoute",
    },
    filter: {
      label: "Filtre",
      none: "Toutes les conférences",
    },
    target: {
      off: "Désactivé",
      "30m": "30 minutes",
      "1h": "1 heure",
      "2h": "2 heures",
      "3h": "3 heures",
      "5h": "5 heures",
      "8h": "8 heures",
      "10h": "10 heures",
    },
    archive: {
      off: "Jamais",
      immediate: "Immédiatement",
      _8h: "Après 8 heures",
      _1d: "Après 1 jour",
      _2d: "Après 2 jours",
      _3d: "Après 3 jours",
    },
    subtitleOff: "Mise à jour automatique des conférences et nettoyage après écoute",
    subtitleArchivePrefix: "archive",
  },

  preferredServer: {
    title: "Serveur préféré",
  },

  trackInfo: {
    label: "Informations sur la conférence",
    description: "Configurez l'apparence de la liste des conférences",
    title: "Informations sur la conférence",
    top: "Ligne supérieure",
    topField: "Champ",
    bottom: "Ligne inférieure",
    none: "Rien",
    fields: {
      reference: "Référence",
      author: "Auteur",
      location: "Lieu",
      date: "Date",
      duration: "Durée",
    },
    preview: {
      title: "Happiness Beyond The Senses",
      author: "A.C. Bhaktivedanta Swami",
      location: "Bombay",
      date: "21 avr. 1974",
      duration: "47min",
    },
  },
  player: {
    showProgress: {
      title: "Progression du lecteur",
      description: "Afficher la progression autour du bouton de lecture",
    },
    autoPlayNext: {
      title: "Lecture automatique",
      description: "Quand une conférence se termine, démarrer la suivante de votre playlist",
    },
  },
  notes: {
    showPlayer: {
      title: "Lecteur sur la page des notes",
      description: "Afficher un lecteur audio intégré à côté de chaque citation",
    },
  },
  activityTracker: {
    show: {
      title: "Suivi d'activité",
      description: "Afficher la carte de chaleur d'écoute sur l'écran d'accueil",
    },
  },
  transcript: {
    highlightCurrentSentence: {
      title: "Surligner la phrase",
      description: "Suivre la phrase en cours dans la transcription",
    },
    autoScroll: {
      title: "Défilement automatique",
      description: "Suivre le paragraphe en cours pendant la lecture de l'audio",
    },
    showAutomatically: {
      title: "Ouvrir la transcription automatiquement",
      description: "Ouvrir la transcription lors de la lecture d'une conférence",
    },
  },

  contacts: {
    email: {
      title: "Envoyez-nous un e-mail",
      description: "Des questions ou des suggestions ?",
      emailSubject: "Demande d'assistance",
      emailIntro: "Veuillez décrire votre question ou votre problème au-dessus de cette ligne.",
    },
    // VK / Telegram rows render only in the ru locale (Russian-audience
    // communities), so their strings live solely in ru/settings.ts.
  },

  notifications: {
    enabled: {
      title: "Notifications",
      description: "Vous recevrez des notifications.",
    },
    daily: {
      title: "Heure du rappel",
      description: "L'heure à laquelle les notifications seront envoyées.",
    },
  },

  data: {
    export: {
      title: "Exporter les données utilisateur",
      description: "Enregistrer la playlist, les notes et la progression dans un fichier",
      error: "Échec de l'export",
    },
    import: {
      title: "Importer les données utilisateur",
      description: "Remplacer les données actuelles par un fichier exporté précédemment",
      error: "Échec de l'import",
      confirm: {
        header: "Remplacer toutes les données actuelles ?",
        message:
          "Votre playlist, vos notes, vos téléchargements et votre progression d'écoute actuels seront remplacés par le fichier importé. Cette action est irréversible.",
        ok: "Remplacer",
        cancel: "Annuler",
      },
    },
  },

  debug: {
    viewLogs: {
      title: "Voir les journaux",
      description: "Journal d'événements de l'application · {count} entrées",
    },
  },

  logs: {
    title: "Journaux",
    close: "Fermer",
    copy: "Copier",
    copied: "Journaux copiés",
    clear: "Effacer",
    count: "{count} entrées",
    empty: "Aucun journal pour l'instant",
  },

  danger: {
    clearCache: {
      title: "Vider le cache",
      description: "Supprime tous les audios et transcriptions téléchargés",
    },
  },

  appVersion: "Version de l'application",
  contentDatabase: "Base de données du contenu",
  activeServer: "CDN actif",
}
