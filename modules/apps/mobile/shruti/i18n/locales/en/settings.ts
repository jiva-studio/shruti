export default {
  groups: {
    subscription: "Subscription",
    appearance: "Appearance",
    contacts: "Contact Us",
    status: "Status",
    sadhana: "Sadhana",
    data: "Data",
    help: "Help",
    danger: "Danger zone",
    about: "About",
  },

  subscription: {
    title: "Subscription",
    description: "Subscription management",
    subscriptionIsActive: "Subscription is active",
    tapToManage: "You are already subscribed",
    choose: 'Support "Shruti"',
    subscribe: "Subscribe",
    subscribed: "Subscription completed",
    restore: "Restore",
    restored: "Your subscription has been successfully restored!",
    error: "An error occurred during the operation. Please try again.",
    noSubscriptionFound:
      "No active subscription found. Please subscribe to access premium features.",
    thanks:
      "Thank you for your subscription and support 🙏 May your heart be filled with happiness, and each day bring you closer to Truth. We are glad that you are with us on this path.",
    benefits: {
      intro:
        "We are implementing new features and improvements. Your support helps us continue development and make the product better.",
      benefit0: {
        title: "New Lectures",
        description: "Your subscription helps us continue adding new lectures.",
        icon: "🌟",
      },
      benefit1: {
        title: "Bookmarks",
        description: "Save important moments from lectures to return to them later.",
        icon: "🔖",
      },
      benefit2: {
        title: "Smart Library",
        description:
          "The app keeps fresh lectures on your device and automatically clears finished ones.",
        icon: "📥",
      },
      benefit3: {
        title: "Seminars and Courses",
        description:
          "Add seminars and courses to your playlist to listen to them in a convenient order.",
        icon: "📚",
      },
      benefit4: {
        title: "Dynamic Collections",
        description:
          "Create collections for lectures that will automatically update based on specified criteria.",
        icon: "🗃️",
      },
      benefit5: {
        title: "Advanced Search",
        description: "Search through lecture texts to quickly find needed moments.",
        icon: "🔍",
      },
    },
    periods: {
      P1M: "month",
      P3M: "3 months",
      P6M: "6 months",
      P1Y: "year",
    },
    plans: {
      $rc_monthly: "Monthly",
      $rc_three_month: "Quarterly",
      $rc_six_month: "Half-yearly",
      $rc_annual: "Annual",
    },
    legal: {
      privacy: "Privacy Policy",
      terms: "Terms of Use",
    },
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

  smartLibrary: {
    title: "Smart library",
    description: "Keep fresh lectures ready and clean up after listening",
    enable: "Enable",
    hint: "The app keeps a buffer of unlistened lectures and automatically removes finished ones. Use the filter to choose what gets queued.",
    sections: {
      filter: "What to download",
      target: "Queue length",
      archive: "Archive after listening",
    },
    filter: {
      label: "Filter",
      none: "All lectures",
    },
    target: {
      off: "Off",
      "30m": "30 minutes",
      "1h": "1 hour",
      "2h": "2 hours",
      "3h": "3 hours",
      "5h": "5 hours",
      "8h": "8 hours",
      "10h": "10 hours",
    },
    archive: {
      immediate: "Immediately",
      _8h: "After 8 hours",
      _1d: "After 1 day",
      _2d: "After 2 days",
      _3d: "After 3 days",
    },
    subtitleOff: "Auto-update lectures and clean up after listening",
    subtitleArchivePrefix: "archive",
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
  chat: {
    showTab: {
      title: "Chat tab",
      description: "Show the Sadhu chat tab at the bottom",
    },
    clearHistory: {
      title: "Clear chat history",
      description: "Delete every chat session and message from this device",
    },
  },
  notes: {
    showTab: {
      title: "Notes tab",
      description: "Show notes tab at the bottom",
    },
    showPlayer: {
      title: "Player on notes page",
      description: "Show an inline audio player next to each quote",
    },
    studio: {
      title: "Studio",
      description: 'Adds "Open in Studio" to the note share menu',
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
