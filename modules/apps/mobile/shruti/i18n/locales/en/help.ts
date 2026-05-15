export default {
  title: "Help",
  back: "Back",
  close: "Close",

  categories: {
    features: "How it works",
    settings: "Settings",
    data: "Your data",
  },

  pages: {
    "what-is-sadhana": {
      title: "What is sadhana",
      summary: "Daily spiritual practice and how the app supports it",
    },
    "activity-tracker": {
      title: "Activity tracker",
      summary: "Heatmap, day streak and total listening time",
    },
    notifications: {
      title: "Notifications and reminders",
      summary: "Daily reminder, time, and system permissions",
    },
    indicators: {
      title: "Track indicators",
      summary: "What each badge next to a track means, screen by screen",
    },
    "settings-overview": {
      title: "Settings overview",
      summary: "Every settings group and item explained",
    },
    "export-import": {
      title: "Export and import",
      summary: "Backup and restore your personal data",
    },
  },

  indicators: {
    intro:
      "The same circle can mean different things on different screens. Here is what each badge means in each context.",

    screens: {
      home: {
        title: "Home — your playlist",
        description: "Every track here is in your playlist. The badge shows your progress.",
      },
      search: {
        title: "Search and Library",
        description:
          "You are browsing the catalog. A track with no badge is not in your playlist yet.",
      },
    },

    common: {
      downloading: {
        title: "Downloading",
        description: "The track is being downloaded. The ring fills as the download progresses.",
      },
      failed: {
        title: "Download failed",
        description: "Downloading was interrupted. Tap the track to retry.",
      },
      completed: {
        title: "Completed",
        description:
          "You finished the track. It stays marked so you can see what you've listened to.",
      },
    },

    home: {
      progress: {
        title: "Progress in this track",
        description:
          "Tap to listen. The ring shows your last saved position. On the track currently in the player, the ring fills in real time as it plays.",
      },
    },

    search: {
      added: {
        title: "Added to playlist",
        description: "This track is already in your playlist.",
      },
    },
  },
}
