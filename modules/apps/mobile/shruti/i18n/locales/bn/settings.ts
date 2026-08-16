export default {
  groups: {
    subscription: "সাবস্ক্রিপশন",
    account: "অ্যাকাউন্ট",
    appearance: "চেহারা",
    library: "লাইব্রেরি",
    chat: "Ask Sadhu",
    contacts: "যোগাযোগ করুন",
    status: "স্ট্যাটাস",
    sadhana: "সাধনা",
    data: "তথ্য",
    help: "সহায়তা",
    debug: "ডিবাগ",
    danger: "বিপদজনক এলাকা",
    about: "সম্পর্কে",
  },
  libraryLanguages: {
    title: "লেকচারের ভাষা",
    description: "অনুসন্ধান, বিষয় ও সুপারিশে এই ভাষাগুলোতে লেকচার দেখান।",
  },

  account: {
    signInCta: {
      title: "সাইন ইন করুন",
      description: "আপনার অগ্রগতি সংরক্ষণ করুন",
    },
    signInWithGoogle: "Google দিয়ে চালিয়ে যান",
    signInWithApple: "Apple দিয়ে চালিয়ে যান",
    signInWithEmail: "ইমেল দিয়ে চালিয়ে যান",
    email: {
      title: "ইমেল দিয়ে সাইন ইন",
      emailStep: "আমরা আপনার ইমেলে একটি এককালীন কোড পাঠাব — পাসওয়ার্ড লাগবে না।",
      emailLabel: "ইমেল",
      emailPlaceholder: "you{'@'}example.com",
      sendCode: "কোড পাঠান",
      codeStep: "{email}-এ পাঠানো ৬ সংখ্যার কোডটি লিখুন।",
      codeLabel: "কোড",
      codePlaceholder: "৬ সংখ্যার কোড",
      verify: "সাইন ইন করুন",
      resend: "আবার কোড পাঠান",
      resendIn: "{seconds} সেকেন্ড পরে আবার পাঠান",
      changeEmail: "ইমেল পরিবর্তন করুন",
      errors: {
        invalidEmail: "একটি সঠিক ইমেল ঠিকানা লিখুন।",
        invalidCode: "কোডটি ভুল বা মেয়াদোত্তীর্ণ।",
        throttled: "নতুন কোড চাওয়ার আগে একটু অপেক্ষা করুন।",
        disabled: "ইমেল দিয়ে সাইন ইন এখন উপলব্ধ নয়।",
        network: "সংযোগ নেই। আপনার ইন্টারনেট পরীক্ষা করে আবার চেষ্টা করুন।",
        server: "আমাদের দিকে কিছু একটা ভুল হয়েছে। অনুগ্রহ করে একটু পরে আবার চেষ্টা করুন।",
        generic: "কিছু একটা ভুল হয়েছে। আবার চেষ্টা করুন।",
      },
    },
    signedIn: "আপনি সাইন ইন করেছেন",
    // Subtitle for the signed-in row when the auth provider didn't
    // expose email/picture (RU region: no personal data by design;
    // also any OAuth flow that withheld the profile). Reassures the
    // user that their session is still attached to something
    // persistent even without a visible identity.
    signedInNoDataSubtitle: "আপনার অগ্রগতি নিরাপদ",
    signOut: "সাইন আউট",
    signOutWipeToast:
      "সাইন আউট হয়েছে। আপনার নোট ও কথোপকথন আপনার অ্যাকাউন্টে থাকে এবং পরের বার সাইন ইন করলে ফিরে আসবে।",
    deleteAccount: {
      title: "অ্যাকাউন্ট মুছুন",
      confirmWipe: "অ্যাকাউন্ট মুছুন ও তথ্য মুছে ফেলুন",
      confirmKeep: "অ্যাকাউন্ট মুছুন, আমার তথ্য রাখুন",
      errorToast: "অ্যাকাউন্ট মুছে ফেলা যায়নি। অনুগ্রহ করে আবার চেষ্টা করুন।",
      alreadyDeletedToast: "আপনার অ্যাকাউন্ট ইতিমধ্যে মুছে ফেলা হয়েছে।",
      rateLimitedToast: "আবার চেষ্টা করার আগে একটু অপেক্ষা করুন।",
      networkErrorToast: "সংযোগ নেই। আপনার ইন্টারনেট পরীক্ষা করে আবার চেষ্টা করুন।",
      serverErrorToast: "আমাদের দিকে কিছু একটা ভুল হয়েছে। অনুগ্রহ করে একটু পরে আবার চেষ্টা করুন।",
    },
  },

  subscription: {
    title: "সাবস্ক্রিপশন",
    description: "সাবস্ক্রিপশন ব্যবস্থাপনা",
    subscriptionIsActive: "সাবস্ক্রিপশন সক্রিয়",
    tapToManage: "দেখতে বা পরিচালনা করতে ট্যাপ করুন",
    choose: '"Shruti"-কে সমর্থন করুন',
    subscribe: "সাবস্ক্রাইব করুন",
    trialBadge: "{days} দিন ফ্রি",
    trialThenPrice: "এরপর {price} / {period}",
    startFreeTrial: "ফ্রি ট্রায়াল শুরু করুন",
    trialDisclaimer:
      "যেকোনো সময় বাতিল করুন। ট্রায়াল শেষে সাবস্ক্রিপশন স্বয়ংক্রিয়ভাবে নবায়ন হবে।",
    disclaimer: "যেকোনো সময় বাতিল করুন। সাবস্ক্রিপশন স্বয়ংক্রিয়ভাবে নবায়ন হবে।",
    subscribed: "সাবস্ক্রিপশন সম্পন্ন হয়েছে",
    loading: "সাবস্ক্রিপশনের বিকল্প লোড হচ্ছে…",
    unavailable: "এই ডিভাইসে ইন-অ্যাপ কেনাকাটা উপলব্ধ নয়।",
    unconfirmed:
      "আপনার সাবস্ক্রিপশন নিশ্চিত করা যায়নি। যদি আগে থেকেই থাকে, “পুনরুদ্ধার করুন” চাপুন।",
    manage: "সাবস্ক্রিপশন পরিচালনা করুন",
    restore: "পুনরুদ্ধার করুন",
    restored: "আপনার সাবস্ক্রিপশন সফলভাবে পুনরুদ্ধার করা হয়েছে!",
    error: "অপারেশনের সময় একটি ত্রুটি ঘটেছে। অনুগ্রহ করে আবার চেষ্টা করুন।",
    noSubscriptionFound:
      "কোনও সক্রিয় সাবস্ক্রিপশন পাওয়া যায়নি। প্রিমিয়াম সুবিধা পেতে অনুগ্রহ করে সাবস্ক্রাইব করুন।",
    thanks:
      "আপনার সাবস্ক্রিপশন ও সমর্থনের জন্য ধন্যবাদ 🙏 আপনার হৃদয় আনন্দে পূর্ণ হোক, আর প্রতিটি দিন আপনাকে সত্যের আরও কাছে নিয়ে যাক। আপনি এই পথে আমাদের সাথে আছেন বলে আমরা আনন্দিত।",
    benefits: {
      progress: {
        title: "আপনার অগ্রগতি দেখুন",
        description: "আপনার শোনার ধারাবাহিকতা দেখুন এবং যেখানে থেমেছিলেন সেখান থেকে চালিয়ে যান।",
      },
      andMore: {
        title: "আরও অনেক কিছু",
        description: "একটানা প্লেব্যাক, শেয়ারিং, নোটস স্টুডিও এবং আরও অনেক কিছু।",
      },
      intro:
        "আমরা নতুন সুবিধা ও উন্নতি যোগ করছি। আপনার সমর্থন আমাদের উন্নয়ন চালিয়ে যেতে এবং পণ্যটিকে আরও ভালো করতে সাহায্য করে।",
      benefit0: {
        title: "নতুন লেকচার",
        description: "আপনার সাবস্ক্রিপশন আমাদের নতুন লেকচার যোগ করতে সাহায্য করে।",
      },
      benefit1: {
        title: "বুকমার্ক",
        description: "লেকচারের গুরুত্বপূর্ণ মুহূর্ত সংরক্ষণ করুন—পরে দেখতে বা শেয়ার করতে।",
      },
      benefit2: {
        title: "স্মার্ট লাইব্রেরি",
        description: "ডিভাইসে নতুন লেকচার রাখে এবং শোনা হলে স্বয়ংক্রিয়ভাবে মুছে ফেলে।",
      },
      benefit3: {
        title: "সেমিনার ও কোর্স",
        description: "সুবিধাজনক ক্রমে শুনতে আপনার প্লেলিস্টে সেমিনার ও কোর্স যোগ করুন।",
      },
      benefit4: {
        title: "ডায়নামিক সংগ্রহ",
        description:
          "নির্দিষ্ট মাপকাঠির ভিত্তিতে স্বয়ংক্রিয়ভাবে আপডেট হবে এমন লেকচার সংগ্রহ তৈরি করুন।",
      },
      sakha: {
        title: "Ask Sadhu",
        description: "লেকচার, অডিও ও বইয়ে খোঁজে এবং শিক্ষা বুঝতে সাহায্য করে।",
      },
      autoScroll: {
        title: "স্বয়ংক্রিয় স্ক্রল",
        description: "অডিওর সাথে ট্রান্সক্রিপ্ট চলে, বর্তমান অনুচ্ছেদ সবসময় দৃশ্যমান।",
      },
      continuousPlayback: {
        title: "নিরবচ্ছিন্ন প্লেব্যাক",
        description:
          "লেকচার একের পর এক চলে — একটি শেষ হলে পরেরটি স্বয়ংক্রিয়ভাবে শুরু হয়, এমনকি স্ক্রিন লক থাকলেও।",
      },
      shareTranscript: {
        title: "শেয়ার ও এক্সপোর্ট",
        description:
          "একটি বক্তৃতা PDF বা টেক্সট ট্রান্সক্রিপ্ট হিসেবে শেয়ার করুন, অথবা এর অডিও শেয়ার করুন — যে কারও সঙ্গে।",
      },
      notesStudio: {
        title: "নোটস স্টুডিও",
        description:
          "লেকচার থেকে আপনার নোটগুলোকে ছোট ভিডিওতে পরিণত করুন এবং বন্ধুদের সাথে শেয়ার করুন।",
      },
      trackInfo: {
        title: "ট্র্যাক তথ্যের বিন্যাস",
        description:
          "কোন বিবরণ — শ্লোক, বক্তা, স্থান, তারিখ — প্রতিটি লেকচারের শিরোনামের নিচে প্রধান উপরের লাইনে থাকবে, আর কোনগুলো নিচের লাইনে দেখানো হবে তা বেছে নিন।",
      },
    },
    periods: {
      P1M: "মাস",
      P3M: "৩ মাস",
      P6M: "৬ মাস",
      P1Y: "বছর",
    },
    plans: {
      $rc_monthly: "মাসিক",
      $rc_three_month: "ত্রৈমাসিক",
      $rc_six_month: "ষাণ্মাসিক",
      $rc_annual: "বার্ষিক",
    },
    legal: {
      privacy: "গোপনীয়তা নীতি",
      terms: "ব্যবহারের শর্তাবলি",
    },
  },

  help: {
    open: {
      title: "সহায়তা খুলুন",
      description: "নির্দেশক, সেটিংস ও সুবিধার ব্যাখ্যা",
    },
    privacyPolicy: {
      title: "গোপনীয়তা নীতি",
      description: "আমরা কী সংগ্রহ করি, সাব-প্রসেসর, অ্যাকাউন্ট মুছে ফেলা",
    },
  },

  appLanguage: {
    title: "ভাষা",
    description: "ইন্টারফেসের ভাষা",
    loadFailedToast: "এই ভাষাটি লোড করা যায়নি। আবার চেষ্টা করুন।",
  },

  chatLanguage: {
    title: "চ্যাটের ভাষা",
    description: "Sadhu যে ভাষায় উত্তর দেয়।",
  },

  chatTranslateCitations: {
    title: "উদ্ধৃতি অনুবাদ করুন",
    description: "উদ্ধৃতিগুলো চ্যাটের ভাষায় অনুবাদ করুন।",
  },

  syncChats: {
    title: "চ্যাট সিঙ্ক করুন",
    description: "আপনার Ask Sadhu কথোপকথন আপনার সব ডিভাইসে সিঙ্ক রাখুন।",
  },

  downloadLimit: {
    title: "ডাউনলোড সীমা",
    unlimited: "কোনো সীমা নেই",
    usage: "{limit}-এর মধ্যে {used}",
    usageUnlimited: "{used} ডাউনলোড হয়েছে",
  },

  smartLibrary: {
    title: "স্মার্ট লাইব্রেরি",
    description: "নতুন লেকচার প্রস্তুত রাখুন এবং শোনার পরে পরিষ্কার করুন",
    enable: "চালু করুন",
    hint: "অ্যাপটি অশ্রুত লেকচারের একটি মজুদ রাখে এবং শোনা হয়ে গেলে স্বয়ংক্রিয়ভাবে মুছে ফেলে। কী সারিবদ্ধ হবে তা বেছে নিতে ফিল্টার ব্যবহার করুন।",
    sections: {
      filter: "কী ডাউনলোড হবে",
      target: "সারির দৈর্ঘ্য",
      archive: "শোনার পরে সংরক্ষণাগারে রাখুন",
    },
    filter: {
      label: "ফিল্টার",
      none: "সব লেকচার",
    },
    target: {
      off: "বন্ধ",
      "30m": "৩০ মিনিট",
      "1h": "১ ঘণ্টা",
      "2h": "২ ঘণ্টা",
      "3h": "৩ ঘণ্টা",
      "5h": "৫ ঘণ্টা",
      "8h": "৮ ঘণ্টা",
      "10h": "১০ ঘণ্টা",
    },
    archive: {
      off: "কখনও নয়",
      immediate: "তৎক্ষণাৎ",
      _8h: "৮ ঘণ্টা পরে",
      _1d: "১ দিন পরে",
      _2d: "২ দিন পরে",
      _3d: "৩ দিন পরে",
    },
    subtitleOff: "লেকচার স্বয়ংক্রিয় আপডেট এবং শোনার পরে পরিষ্কার",
    subtitleArchivePrefix: "সংরক্ষণাগার",
  },

  preferredServer: {
    title: "পছন্দের সার্ভার",
  },

  trackInfo: {
    label: "ট্র্যাক তথ্য",
    description: "ট্র্যাক তালিকা কেমন দেখাবে তা কনফিগার করুন",
    title: "ট্র্যাক তথ্য",
    top: "উপরের লাইন",
    topField: "ক্ষেত্র",
    bottom: "নিচের লাইন",
    none: "কিছুই না",
    fields: {
      reference: "শ্লোক",
      author: "বক্তা",
      location: "স্থান",
      date: "তারিখ",
      duration: "দৈর্ঘ্য",
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
      title: "প্লেয়ারের অগ্রগতি",
      description: "প্লে বোতামের চারপাশে অগ্রগতি দেখান",
    },
    autoPlayNext: {
      title: "স্বয়ংক্রিয় প্লে",
      description: "একটি লেকচার শেষ হলে, আপনার প্লেলিস্টের পরেরটি শুরু করুন",
    },
  },
  notes: {
    showPlayer: {
      title: "নোট পৃষ্ঠায় প্লেয়ার",
      description: "প্রতিটি উদ্ধৃতির পাশে একটি ইনলাইন অডিও প্লেয়ার দেখান",
    },
  },
  activityTracker: {
    show: {
      title: "কার্যকলাপ ট্র্যাকার",
      description: "হোম স্ক্রিনে শোনার হিটম্যাপ দেখান",
    },
  },
  transcript: {
    highlightCurrentSentence: {
      title: "বাক্য হাইলাইট করুন",
      description: "ট্রান্সক্রিপ্টে বর্তমান বাক্য অনুসরণ করুন",
    },
    autoScroll: {
      title: "স্বয়ংক্রিয় স্ক্রল",
      description: "অডিও চলার সময় বর্তমান অনুচ্ছেদ অনুসরণ করুন",
    },
    showAutomatically: {
      title: "ট্রান্সক্রিপ্ট স্বয়ংক্রিয়ভাবে খুলুন",
      description: "লেকচার চালানোর সময় ট্রান্সক্রিপ্ট খুলুন",
    },
  },

  contacts: {
    studio: {
      title: "Jiva Studio",
      description: "আমাদের স্টুডিও দেখুন এবং আমাদের অন্যান্য অ্যাপ ঘুরে দেখুন",
    },
    email: {
      title: "আমাদের ইমেল করুন",
      description: "কোনও প্রশ্ন বা পরামর্শ আছে?",
      emailSubject: "সহায়তার অনুরোধ",
      emailIntro: "এই লাইনের উপরে অনুগ্রহ করে আপনার প্রশ্ন বা সমস্যা বর্ণনা করুন।",
    },
    // VK / Telegram rows render only in the ru locale (Russian-audience
    // communities), so their strings live solely in ru/settings.ts.
  },

  notifications: {
    enabled: {
      title: "নোটিফিকেশন",
      description: "আপনি নোটিফিকেশন পাবেন।",
    },
    daily: {
      title: "অনুস্মারকের সময়",
      description: "যে সময়ে নোটিফিকেশন পাঠানো হবে।",
    },
  },

  data: {
    export: {
      title: "ব্যবহারকারীর তথ্য রপ্তানি করুন",
      description: "প্লেলিস্ট, নোট ও অগ্রগতি একটি ফাইলে সংরক্ষণ করুন",
      error: "রপ্তানি ব্যর্থ হয়েছে",
    },
    import: {
      title: "ব্যবহারকারীর তথ্য আমদানি করুন",
      description: "বর্তমান তথ্য আগে রপ্তানি করা একটি ফাইল দিয়ে প্রতিস্থাপন করুন",
      error: "আমদানি ব্যর্থ হয়েছে",
      confirm: {
        header: "বর্তমান সব তথ্য প্রতিস্থাপন করবেন?",
        message:
          "আপনার বর্তমান প্লেলিস্ট, নোট, ডাউনলোড ও শোনার অগ্রগতি আমদানি করা ফাইল দিয়ে প্রতিস্থাপিত হবে। এটি আর ফেরানো যাবে না।",
        ok: "প্রতিস্থাপন করুন",
        cancel: "বাতিল",
      },
    },
  },

  debug: {
    viewLogs: {
      title: "লগ দেখুন",
      description: "অ্যাপের ইন-অ্যাপ ইভেন্ট লগ · {count}টি এন্ট্রি",
    },
    email: {
      title: "ডায়াগনস্টিকস পাঠান",
      description: "লগ ও সিস্টেমের অবস্থা সাপোর্টে পাঠান",
      emailSubject: "ডায়াগনস্টিকস রিপোর্ট",
      emailIntro: "এই লাইনের উপরে অনুগ্রহ করে আপনার প্রশ্ন বা সমস্যা বর্ণনা করুন।",
    },
  },

  logs: {
    title: "লগ",
    close: "বন্ধ করুন",
    copy: "কপি করুন",
    copied: "লগ কপি করা হয়েছে",
    clear: "পরিষ্কার করুন",
    count: "{count}টি এন্ট্রি",
    empty: "এখনও কোনও লগ নেই",
  },

  danger: {
    clearCache: {
      title: "ক্যাশ পরিষ্কার করুন",
      description: "সমস্ত ডাউনলোড করা অডিও ও ট্রান্সক্রিপ্ট মুছে ফেলে",
    },
  },

  appVersion: "অ্যাপের সংস্করণ",
  contentDatabase: "কনটেন্ট ডেটাবেস",
  activeServer: "সক্রিয় CDN",
}
