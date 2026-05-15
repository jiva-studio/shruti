export default {
  groups: {
    appearance: "Appearance",
    contacts: "Contact Us",
    status: "Status",
    sadhana: "Sadhana",
    data: "Data",
    help: "Help",
    danger: "Danger zone",
    about: "About",
  },

  help: {
    open: {
      title: "Open help",
      description: "Indicators, settings and features explained",
    },
  },

  appLanguage: {
    title: "Language",
    description: "Language of an interface",
  },

  server: {
    title: "Server",
    description: "Content delivery network",
  },

  player: {
    showProgress: {
      title: "Player progress",
      description: "Show progress around play button",
    },
  },
  notes: {
    showTab: {
      title: "Notes tab",
      description: "Show notes tab at the bottom",
    },
  },
  activityTracker: {
    show: {
      title: "Activity tracker",
      description: "Show listening heatmap on the home screen",
    },
  },
  transcript: {
    highlightCurrentSentence: {
      title: "Highlight sentence",
      description: "Follow the current sentence in the transcript",
    },
    showAutomatically: {
      title: "Open transcript automatically",
      description: "Open transcript when playing a lecture",
    },
  },

  contacts: {
    socialNetworks: {
      title: "Social networks",
      description: "Let's stay connected",
    },
    email: {
      title: "Send us an email",
      description: "Have questions or suggestions?",
    },
  },

  notifications: {
    enabled: {
      title: "Notifications",
      description: "You will receive notifications.",
    },
    daily: {
      title: "Reminder time",
      description: "The time when notifications will be sent.",
    },
  },

  data: {
    export: {
      title: "Export user data",
      description: "Save playlist, notes and progress to a file",
      error: "Export failed",
    },
    import: {
      title: "Import user data",
      description: "Replace current data with a previously exported file",
      error: "Import failed",
      confirm: {
        header: "Replace all current data?",
        message:
          "Your current playlist, notes, downloads and listening progress will be replaced by the imported file. This cannot be undone.",
        ok: "Replace",
        cancel: "Cancel",
      },
    },
  },

  danger: {
    clearCache: {
      title: "Clear cache",
      description: "Removes downloaded transcripts",
    },
    clearUserData: {
      title: "Clear user data",
      description: "Deletes all tracks, playlists, notes and bookmarks",
    },
    confirmClearUserData: {
      header: "Clear all user data?",
      message:
        "Notes, playlist, downloaded tracks and search filters will be permanently deleted. This cannot be undone.",
      cancel: "Cancel",
      confirm: "Delete everything",
    },
  },

  appVersion: "App version",
  contentDatabase: "Content database",
  activeServer: "Active CDN",
}
