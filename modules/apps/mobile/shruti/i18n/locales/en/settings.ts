export default {
  groups: {
    subscription: "Subscription",
    account: "Account",
    appearance: "Appearance",
    contacts: "Contact Us",
    status: "Status",
    sadhana: "Sadhana",
    data: "Data",
    help: "Help",
    danger: "Danger zone",
    about: "About",
  },

  account: {
    signInCta: {
      title: "Sign in",
      description: "Keep your progress",
    },
    signInWithGoogle: "Continue with Google",
    signInWithApple: "Continue with Apple",
    signedIn: "You are signed in",
    signOut: "Sign out",
    signinRetryOtherRegion: {
      title: "No account found in {currentRegion}",
      message:
        "If you signed up in {otherRegion} before, try that region. Otherwise, create a new account here.",
      switchTo: "Switch to {otherRegion} and try again",
      createNew: "Create new account in {currentRegion}",
      dupRiskTitle: "Account on the other region may exist",
      dupRiskMessage:
        "We couldn't reach {otherRegion} to verify. Creating a new account in {currentRegion} while one may exist in {otherRegion} will result in two parallel accounts.",
      continueAnyway: "Continue anyway",
      cancel: "Cancel",
      alreadyExistsTitle: "Account already exists in {otherRegion}",
      alreadyExistsMessage: "Switch to {otherRegion} and sign in there instead.",
      switchAndRetry: "Switch and sign in",
    },
    deleteAccount: {
      title: "Delete account",
      confirmWipe: "Delete account and wipe data",
      confirmKeep: "Delete account, keep my data",
      errorToast: "Could not delete account. Please try again.",
      alreadyDeletedToast: "Your account is already deleted.",
      rateLimitedToast: "Please wait a bit before trying again.",
      networkErrorToast: "No connection. Check your internet and try again.",
      serverErrorToast: "Something went wrong on our end. Please try again in a moment.",
    },
  },

  subscription: {
    title: "Subscription",
    description: "Subscription management",
    subscriptionIsActive: "Subscription is active",
    tapToManage: "Tap to view or manage",
    choose: 'Support "Shruti"',
    subscribe: "Subscribe",
    subscribed: "Subscription completed",
    manage: "Manage Subscription",
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
      },
      benefit1: {
        title: "Bookmarks",
        description:
          "Save important moments from the text and audio of lectures to revisit later or share with friends.",
      },
      benefit2: {
        title: "Smart Library",
        description:
          "The app keeps fresh lectures on your device and automatically clears finished ones.",
      },
      benefit3: {
        title: "Seminars and Courses",
        description:
          "Add seminars and courses to your playlist to listen to them in a convenient order.",
      },
      benefit4: {
        title: "Dynamic Collections",
        description:
          "Create collections for lectures that will automatically update based on specified criteria.",
      },
      sakha: {
        title: "Sakhā — AI Companion",
        description:
          "Searches lectures, audio and books, finds shlokas, generates PDFs, and helps you make sense of the teachings. A bigger daily allowance comes with a subscription.",
      },
      autoScroll: {
        title: "Automatic Scroll",
        description:
          "The transcript follows along as audio plays, so the current paragraph is always in view.",
      },
      notesStudio: {
        title: "Notes Studio",
        description: "Turn your notes from lectures into short videos and share them with friends.",
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
    privacyPolicy: {
      title: "Privacy Policy",
      description: "What we collect, sub-processors, account deletion",
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

  accountRegion: {
    title: "Account region",
    description: "Where your account and chat history live",
    /** Small note rendered below the picker; surfaces the server-truth
     *  region (mirror of auth.users.home_region) so the user sees what
     *  the server thinks alongside the local picker. */
    serverTruth: "Account region: {region}",
  },

  regionMigration: {
    confirmAnonymous: {
      title: "Switch region?",
      message:
        "Switching to {region} will create a new anonymous account there. Your on-device data (chat history, listening notes) will be kept.",
      cancel: "Cancel",
      confirm: "Switch",
    },
    confirmSignedIn: {
      title: "Move account to {region}?",
      message:
        "Your account, subscription, and on-device data will move to {region}. Your old region's account will be deleted in the background.",
      cancel: "Cancel",
      confirm: "Move",
    },
    inProgress: "Moving your account…",
    success: "Account moved to {region}.",
    failed: {
      unreachable: "Could not reach the new region. Please try again later.",
      rejected:
        "The migration was rejected. Anonymous accounts cannot be migrated — please sign in first.",
      network: "Network error. Please check your connection and try again.",
      no_session: "No active session. Please sign in first.",
    },
  },

  player: {
    showProgress: {
      title: "Player progress",
      description: "Show progress around play button",
    },
  },
  notes: {
    showPlayer: {
      title: "Player on notes page",
      description: "Show an inline audio player next to each quote",
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
    autoScroll: {
      title: "Automatic scroll",
      description: "Follow the current paragraph while audio plays",
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
  },

  appVersion: "App version",
  contentDatabase: "Content database",
  activeServer: "Active CDN",
}
