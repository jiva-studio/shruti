export default {
  groups: {
    subscription: "Subscription",
    account: "Account",
    appearance: "Appearance",
    library: "Library",
    chat: "Ask Sadhu",
    contacts: "Contact Us",
    status: "Status",
    sadhana: "Sadhana",
    data: "Data",
    help: "Help",
    debug: "Debug",
    danger: "Danger zone",
    about: "About",
  },
  libraryLanguages: {
    title: "Lecture languages",
    description: "Show lectures in these languages across search, topics and recommendations.",
  },

  account: {
    signInCta: {
      title: "Sign in",
      description: "Keep your progress",
    },
    signInWithGoogle: "Continue with Google",
    signInWithApple: "Continue with Apple",
    signInWithEmail: "Continue with email",
    email: {
      title: "Sign in with email",
      emailStep: "We'll email you a one-time code — no password needed.",
      emailLabel: "Email",
      emailPlaceholder: "you{'@'}example.com",
      sendCode: "Send code",
      codeStep: "Enter the 6-digit code we sent to {email}.",
      codeLabel: "Code",
      codePlaceholder: "6-digit code",
      verify: "Sign in",
      resend: "Resend code",
      resendIn: "Resend in {seconds}s",
      changeEmail: "Change email",
      errors: {
        invalidEmail: "Please enter a valid email address.",
        invalidCode: "That code is invalid or has expired.",
        throttled: "Please wait a moment before requesting another code.",
        disabled: "Email sign-in is unavailable right now.",
        network: "No connection. Check your internet and try again.",
        server: "Something went wrong on our end. Please try again in a moment.",
        generic: "Something went wrong. Please try again.",
      },
    },
    signedIn: "You are signed in",
    // Subtitle for the signed-in row when the auth provider didn't
    // expose email/picture (RU region: no personal data by design;
    // also any OAuth flow that withheld the profile). Reassures the
    // user that their session is still attached to something
    // persistent even without a visible identity.
    signedInNoDataSubtitle: "Your progress is safe",
    signOut: "Sign out",
    // Silent-wipe notice (#1773). Signing out clears this device's copy of
    // the account's data; the toast is the only notice the user gets, so it
    // says where the data went instead of just confirming the sign-out.
    signOutWipeToast:
      "Signed out. Your notes and chats stay in your account and come back when you sign in.",
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
    trialBadge: "{days} days free",
    trialThenPrice: "then {price} / {period}",
    startFreeTrial: "Start free trial",
    trialDisclaimer: "Cancel anytime. After the trial, the subscription renews automatically.",
    disclaimer: "Cancel anytime. The subscription renews automatically.",
    loading: "Loading subscription options…",
    unavailable: "In-app purchases aren't available on this device.",
    unconfirmed: "We couldn’t confirm your subscription. If you already have one, tap “Restore”.",
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
      progress: {
        title: "Track Your Progress",
        description: "Track your listening streak and pick up where you left off.",
      },
      andMore: {
        title: "And much more",
        description: "Continuous playback, sharing, the notes studio, and much more.",
      },
      intro:
        "We are implementing new features and improvements. Your support helps us continue development and make the product better.",
      benefit0: {
        title: "New Lectures",
        description: "Your subscription helps us keep adding new lectures.",
      },
      benefit1: {
        title: "Bookmarks",
        description: "Save key moments from a lecture to revisit or share.",
      },
      benefit2: {
        title: "Smart Library",
        description: "Keeps fresh lectures on your device and clears finished ones.",
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
        title: "Ask Sadhu",
        description: "Searches lectures, audio and books and explains the teachings.",
      },
      autoScroll: {
        title: "Automatic Scroll",
        description: "The transcript follows the audio, keeping your place in view.",
      },
      continuousPlayback: {
        title: "Continuous Playback",
        description:
          "Lectures play one after another — when one ends the next begins automatically, even with the screen locked.",
      },
      shareTranscript: {
        title: "Share & Export",
        description:
          "Share a lecture as a PDF or text transcript, or share its audio — with anyone.",
      },
      notesStudio: {
        title: "Notes Studio",
        description: "Turn your notes from lectures into short videos and share them with friends.",
      },
      trackInfo: {
        title: "Track Info Layout",
        description:
          "Choose which detail — reference, author, location, date — sits on the prominent top line under each lecture title, and which show in the line below.",
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
    loadFailedToast: "Couldn't load that language. Please try again.",
  },

  chatLanguage: {
    title: "Chat language",
    description: "Language Sadhu answers in.",
  },

  chatTranslateCitations: {
    title: "Translate quotes",
    description: "Translate quotes into the chat language.",
  },

  syncChats: {
    title: "Sync chats",
    description: "Keep your Ask Sadhu conversations in sync across your devices.",
  },

  downloadLimit: {
    title: "Download limit",
    unlimited: "No limit",
    usage: "{used} of {limit}",
    usageUnlimited: "{used} downloaded",
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
      off: "Never",
      immediate: "Immediately",
      _8h: "After 8 hours",
      _1d: "After 1 day",
      _2d: "After 2 days",
      _3d: "After 3 days",
    },
    subtitleOff: "Auto-update lectures and clean up after listening",
    subtitleArchivePrefix: "archive",
  },

  preferredServer: {
    title: "Preferred server",
  },

  trackInfo: {
    label: "Track info",
    description: "Configure how the track list looks",
    title: "Track info",
    top: "Top line",
    topField: "Field",
    bottom: "Bottom line",
    none: "Nothing",
    fields: {
      reference: "Reference",
      author: "Author",
      location: "Location",
      date: "Date",
      duration: "Duration",
    },
    preview: {
      title: "Happiness Beyond The Senses",
      author: "A.C. Bhaktivedanta Swami",
      location: "Bombay",
      date: "21 Apr 1974",
      duration: "47m",
    },
  },
  player: {
    showProgress: {
      title: "Player progress",
      description: "Show progress around play button",
    },
    autoPlayNext: {
      title: "Autoplay",
      description: "When a lecture ends, start the next one in your playlist",
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
    studio: {
      title: "Jiva Studio",
      description: "Visit our studio and explore our other apps",
    },
    email: {
      title: "Send us an email",
      description: "Have questions or suggestions?",
      emailSubject: "Support request",
      emailIntro: "Please describe your question or problem above this line.",
    },
    // VK / Telegram rows render only in the ru locale (Russian-audience
    // communities), so their strings live solely in ru/settings.ts.
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

  debug: {
    viewLogs: {
      title: "View logs",
      description: "In-app event log · {count} entries",
    },
    email: {
      title: "Email diagnostics",
      description: "Send logs and system state to support",
      emailSubject: "Diagnostics report",
      emailIntro: "Please describe your question or problem above this line.",
    },
  },

  logs: {
    title: "Logs",
    close: "Close",
    copy: "Copy",
    copied: "Logs copied",
    clear: "Clear",
    count: "{count} entries",
    empty: "No logs yet",
  },

  danger: {
    clearCache: {
      title: "Clear cache",
      description: "Removes all downloaded audio and transcripts",
    },
  },

  appVersion: "App version",
  contentDatabase: "Content database",
  activeServer: "Active CDN",
}
