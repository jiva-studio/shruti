export default {
  groups: {
    subscription: "सब्सक्रिप्शन",
    account: "खाता",
    appearance: "रूप-रंग",
    library: "लाइब्रेरी",
    chat: "Ask Sadhu",
    contacts: "संपर्क करें",
    status: "स्थिति",
    sadhana: "साधना",
    data: "डेटा",
    help: "सहायता",
    debug: "डीबग",
    danger: "खतरनाक क्षेत्र",
    about: "ऐप के बारे में",
  },
  libraryLanguages: {
    title: "प्रवचन की भाषाएँ",
    description: "खोज, विषयों और अनुशंसाओं में प्रवचन इन भाषाओं में दिखाएँ।",
  },

  account: {
    signInCta: {
      title: "साइन इन करें",
      description: "अपनी प्रगति सहेजें",
    },
    signInWithGoogle: "Google से जारी रखें",
    signInWithApple: "Apple से जारी रखें",
    signInWithEmail: "ईमेल से जारी रखें",
    email: {
      title: "ईमेल से साइन इन",
      emailStep: "हम आपके ईमेल पर एक बार का कोड भेजेंगे — पासवर्ड की ज़रूरत नहीं।",
      emailLabel: "ईमेल",
      emailPlaceholder: "you{'@'}example.com",
      sendCode: "कोड भेजें",
      codeStep: "{email} पर भेजा गया 6 अंकों का कोड दर्ज करें।",
      codeLabel: "कोड",
      codePlaceholder: "6 अंकों का कोड",
      verify: "साइन इन करें",
      resend: "कोड फिर भेजें",
      resendIn: "{seconds} सेकंड में फिर भेजें",
      changeEmail: "ईमेल बदलें",
      errors: {
        invalidEmail: "कृपया मान्य ईमेल पता दर्ज करें।",
        invalidCode: "यह कोड अमान्य है या इसकी अवधि समाप्त हो गई है।",
        throttled: "नया कोड माँगने से पहले थोड़ी देर रुकें।",
        disabled: "ईमेल से साइन इन अभी उपलब्ध नहीं है।",
        network: "कोई कनेक्शन नहीं। अपना इंटरनेट जाँचें और फिर कोशिश करें।",
        server: "हमारी ओर से कुछ गड़बड़ हो गई। कृपया थोड़ी देर बाद फिर कोशिश करें।",
        generic: "कुछ गड़बड़ हो गई। कृपया फिर कोशिश करें।",
      },
    },
    signedIn: "आप साइन इन हैं",
    // Subtitle for the signed-in row when the auth provider didn't
    // expose email/picture (RU region: no personal data by design;
    // also any OAuth flow that withheld the profile). Reassures the
    // user that their session is still attached to something
    // persistent even without a visible identity.
    signedInNoDataSubtitle: "आपकी प्रगति सुरक्षित है",
    signOut: "साइन आउट करें",
    signOutWipeToast:
      "साइन आउट हो गए। आपके नोट्स और बातचीत आपके खाते में सुरक्षित रहते हैं और अगली बार साइन इन करने पर वापस आ जाएँगे।",
    deleteAccount: {
      title: "खाता हटाएँ",
      confirmWipe: "खाता हटाएँ और डेटा मिटाएँ",
      confirmKeep: "खाता हटाएँ, मेरा डेटा रखें",
      errorToast: "खाता हटाया नहीं जा सका। कृपया फिर कोशिश करें।",
      alreadyDeletedToast: "आपका खाता पहले ही हटाया जा चुका है।",
      rateLimitedToast: "कृपया फिर कोशिश करने से पहले थोड़ी देर रुकें।",
      networkErrorToast: "कोई कनेक्शन नहीं। अपना इंटरनेट जाँचें और फिर कोशिश करें।",
      serverErrorToast: "हमारी ओर से कुछ गड़बड़ हो गई। कृपया थोड़ी देर बाद फिर कोशिश करें।",
    },
  },

  subscription: {
    title: "सब्सक्रिप्शन",
    description: "सब्सक्रिप्शन प्रबंधन",
    subscriptionIsActive: "सब्सक्रिप्शन सक्रिय है",
    tapToManage: "देखने या प्रबंधित करने के लिए टैप करें",
    choose: '"Shruti" का समर्थन करें',
    subscribe: "सब्सक्राइब करें",
    trialBadge: "{days} दिन मुफ़्त",
    trialThenPrice: "फिर {price} / {period}",
    startFreeTrial: "मुफ़्त ट्रायल शुरू करें",
    trialDisclaimer: "कभी भी रद्द करें। ट्रायल के बाद सदस्यता अपने आप नवीनीकृत हो जाएगी।",
    disclaimer: "कभी भी रद्द करें। सदस्यता अपने आप नवीनीकृत हो जाएगी।",
    subscribed: "सब्सक्रिप्शन पूरा हुआ",
    loading: "सदस्यता विकल्प लोड हो रहे हैं…",
    unavailable: "इन-ऐप खरीदारी इस डिवाइस पर उपलब्ध नहीं है।",
    manage: "सब्सक्रिप्शन प्रबंधित करें",
    restore: "पुनर्स्थापित करें",
    restored: "आपका सब्सक्रिप्शन सफलतापूर्वक पुनर्स्थापित हो गया!",
    error: "संचालन के दौरान एक त्रुटि हुई। कृपया फिर कोशिश करें।",
    noSubscriptionFound:
      "कोई सक्रिय सब्सक्रिप्शन नहीं मिला। प्रीमियम सुविधाओं तक पहुँचने के लिए कृपया सब्सक्राइब करें।",
    thanks:
      "आपके सब्सक्रिप्शन और समर्थन के लिए धन्यवाद 🙏 आपका हृदय आनंद से भरा रहे, और हर दिन आपको सत्य के और निकट लाए। हमें खुशी है कि आप इस मार्ग पर हमारे साथ हैं।",
    benefits: {
      progress: {
        title: "अपनी प्रगति देखें",
        description: "अपनी सुनने की शृंखला देखें और जहाँ छोड़ा था वहीं से जारी रखें।",
      },
      andMore: {
        title: "और भी बहुत कुछ",
        description: "निरंतर प्लेबैक, साझा करना, नोट्स स्टूडियो और भी बहुत कुछ।",
      },
      intro:
        "हम नई सुविधाएँ और सुधार जोड़ रहे हैं। आपका समर्थन हमें विकास जारी रखने और उत्पाद को बेहतर बनाने में मदद करता है।",
      benefit0: {
        title: "नए प्रवचन",
        description: "आपका सब्सक्रिप्शन हमें नए प्रवचन जोड़ने में मदद करता है।",
      },
      benefit1: {
        title: "बुकमार्क",
        description: "प्रवचन के मुख्य क्षण सहेजें ताकि बाद में देखें या साझा करें।",
      },
      benefit2: {
        title: "स्मार्ट लाइब्रेरी",
        description: "ताज़ा प्रवचन डिवाइस पर रखता है और पूरे हुए अपने आप हटा देता है।",
      },
      benefit3: {
        title: "सेमिनार और पाठ्यक्रम",
        description:
          "सेमिनार और पाठ्यक्रमों को अपनी प्लेलिस्ट में जोड़ें ताकि उन्हें सुविधाजनक क्रम में सुन सकें।",
      },
      benefit4: {
        title: "गतिशील संग्रह",
        description:
          "ऐसे संग्रह बनाएँ जो निर्दिष्ट मापदंडों के आधार पर प्रवचनों के साथ अपने आप अपडेट होते रहेंगे।",
      },
      sakha: {
        title: "Ask Sadhu",
        description: "प्रवचनों, ऑडियो और पुस्तकों में खोजता है और शिक्षाओं को समझाता है।",
      },
      autoScroll: {
        title: "स्वतः स्क्रॉल",
        description: "ऑडियो के साथ प्रतिलिपि चलती है, वर्तमान अनुच्छेद हमेशा दिखता है।",
      },
      continuousPlayback: {
        title: "निरंतर प्लेबैक",
        description:
          "प्रवचन एक के बाद एक चलते हैं — जब एक समाप्त होता है तो अगला अपने आप शुरू हो जाता है, स्क्रीन लॉक होने पर भी।",
      },
      shareTranscript: {
        title: "साझा करें और निर्यात",
        description:
          "किसी व्याख्यान को PDF या टेक्स्ट ट्रांसक्रिप्ट के रूप में साझा करें, या उसका ऑडियो साझा करें — किसी के भी साथ।",
      },
      notesStudio: {
        title: "Notes Studio",
        description: "अपने प्रवचनों के नोट्स को छोटे वीडियो में बदलें और मित्रों के साथ साझा करें।",
      },
      trackInfo: {
        title: "ट्रैक जानकारी लेआउट",
        description:
          "चुनें कि कौन-सा विवरण — संदर्भ, वक्ता, स्थान, तिथि — हर प्रवचन शीर्षक के नीचे प्रमुख ऊपरी पंक्ति में हो, और कौन-से नीचे की पंक्ति में दिखें।",
      },
    },
    periods: {
      P1M: "माह",
      P3M: "3 माह",
      P6M: "6 माह",
      P1Y: "वर्ष",
    },
    plans: {
      $rc_monthly: "मासिक",
      $rc_three_month: "त्रैमासिक",
      $rc_six_month: "अर्धवार्षिक",
      $rc_annual: "वार्षिक",
    },
    legal: {
      privacy: "गोपनीयता नीति",
      terms: "उपयोग की शर्तें",
    },
  },

  help: {
    open: {
      title: "सहायता खोलें",
      description: "संकेतक, सेटिंग्स और सुविधाओं की व्याख्या",
    },
    privacyPolicy: {
      title: "गोपनीयता नीति",
      description: "हम क्या एकत्र करते हैं, उप-प्रोसेसर, खाता हटाना",
    },
  },

  appLanguage: {
    title: "भाषा",
    description: "इंटरफ़ेस की भाषा",
    loadFailedToast: "यह भाषा लोड नहीं हो सकी। कृपया फिर से प्रयास करें।",
  },

  chatLanguage: {
    title: "चैट की भाषा",
    description: "Sadhu जिस भाषा में उत्तर देता है।",
  },

  chatTranslateCitations: {
    title: "उद्धरण अनुवाद करें",
    description: "उद्धरणों को चैट की भाषा में अनुवाद करें।",
  },

  syncChats: {
    title: "चैट सिंक करें",
    description: "अपनी Ask Sadhu बातचीत को अपने सभी डिवाइस पर सिंक रखें।",
  },

  downloadLimit: {
    title: "डाउनलोड सीमा",
    unlimited: "कोई सीमा नहीं",
    usage: "{limit} में से {used}",
    usageUnlimited: "{used} डाउनलोड किया गया",
  },

  smartLibrary: {
    title: "स्मार्ट लाइब्रेरी",
    description: "ताज़ा प्रवचन तैयार रखें और सुनने के बाद सफ़ाई करें",
    enable: "चालू करें",
    hint: "ऐप बिना सुने प्रवचनों का एक भंडार बनाए रखता है और पूरे हो चुके प्रवचनों को अपने आप हटा देता है। क्या कतार में आए, यह चुनने के लिए फ़िल्टर का उपयोग करें।",
    sections: {
      filter: "क्या डाउनलोड करें",
      target: "कतार की लंबाई",
      archive: "सुनने के बाद संग्रहित करें",
    },
    filter: {
      label: "फ़िल्टर",
      none: "सभी प्रवचन",
    },
    target: {
      off: "बंद",
      "30m": "30 मिनट",
      "1h": "1 घंटा",
      "2h": "2 घंटे",
      "3h": "3 घंटे",
      "5h": "5 घंटे",
      "8h": "8 घंटे",
      "10h": "10 घंटे",
    },
    archive: {
      off: "कभी नहीं",
      immediate: "तुरंत",
      _8h: "8 घंटे बाद",
      _1d: "1 दिन बाद",
      _2d: "2 दिन बाद",
      _3d: "3 दिन बाद",
    },
    subtitleOff: "प्रवचन स्वतः अपडेट करें और सुनने के बाद सफ़ाई करें",
    subtitleArchivePrefix: "संग्रह",
  },

  preferredServer: {
    title: "पसंदीदा सर्वर",
  },

  trackInfo: {
    label: "ट्रैक जानकारी",
    description: "ट्रैक सूची कैसी दिखे, इसे कॉन्फ़िगर करें",
    title: "ट्रैक जानकारी",
    top: "ऊपरी पंक्ति",
    topField: "फ़ील्ड",
    bottom: "निचली पंक्ति",
    none: "कुछ नहीं",
    fields: {
      reference: "संदर्भ",
      author: "वक्ता",
      location: "स्थान",
      date: "तिथि",
      duration: "अवधि",
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
      title: "प्लेयर प्रगति",
      description: "प्ले बटन के चारों ओर प्रगति दिखाएँ",
    },
    autoPlayNext: {
      title: "स्वतः चलाएँ",
      description: "जब कोई प्रवचन समाप्त हो, तो प्लेलिस्ट में अगला शुरू करें",
    },
  },
  notes: {
    showPlayer: {
      title: "नोट्स पेज पर प्लेयर",
      description: "हर उद्धरण के पास एक इनलाइन ऑडियो प्लेयर दिखाएँ",
    },
  },
  activityTracker: {
    show: {
      title: "गतिविधि ट्रैकर",
      description: "मुख्य स्क्रीन पर सुनने का हीटमैप दिखाएँ",
    },
  },
  transcript: {
    highlightCurrentSentence: {
      title: "वाक्य हाइलाइट करें",
      description: "प्रतिलिपि में वर्तमान वाक्य का अनुसरण करें",
    },
    autoScroll: {
      title: "स्वतः स्क्रॉल",
      description: "ऑडियो बजते समय वर्तमान अनुच्छेद का अनुसरण करें",
    },
    showAutomatically: {
      title: "प्रतिलिपि स्वतः खोलें",
      description: "प्रवचन चलाते समय प्रतिलिपि खोलें",
    },
  },

  contacts: {
    studio: {
      title: "Jiva Studio",
      description: "हमारे स्टूडियो पर जाएँ और हमारे दूसरे ऐप देखें",
    },
    email: {
      title: "हमें ईमेल भेजें",
      description: "कोई प्रश्न या सुझाव हैं?",
      emailSubject: "सहायता अनुरोध",
      emailIntro: "कृपया इस पंक्ति के ऊपर अपना प्रश्न या समस्या लिखें।",
    },
    // VK / Telegram rows render only in the ru locale (Russian-audience
    // communities), so their strings live solely in ru/settings.ts.
  },

  notifications: {
    enabled: {
      title: "सूचनाएँ",
      description: "आपको सूचनाएँ मिलेंगी।",
    },
    daily: {
      title: "अनुस्मारक का समय",
      description: "वह समय जब सूचनाएँ भेजी जाएँगी।",
    },
  },

  data: {
    export: {
      title: "उपयोगकर्ता डेटा निर्यात करें",
      description: "प्लेलिस्ट, नोट्स और प्रगति को एक फ़ाइल में सहेजें",
      error: "निर्यात विफल",
    },
    import: {
      title: "उपयोगकर्ता डेटा आयात करें",
      description: "वर्तमान डेटा को पहले निर्यात की गई फ़ाइल से बदलें",
      error: "आयात विफल",
      confirm: {
        header: "सारा वर्तमान डेटा बदलें?",
        message:
          "आपकी वर्तमान प्लेलिस्ट, नोट्स, डाउनलोड और सुनने की प्रगति आयात की गई फ़ाइल से बदल दी जाएगी। इसे पूर्ववत नहीं किया जा सकता।",
        ok: "बदलें",
        cancel: "रद्द करें",
      },
    },
  },

  debug: {
    viewLogs: {
      title: "लॉग देखें",
      description: "ऐप के भीतर इवेंट लॉग · {count} प्रविष्टियाँ",
    },
    email: {
      title: "डायग्नोस्टिक्स भेजें",
      description: "लॉग और सिस्टम की स्थिति सहायता को भेजें",
      emailSubject: "डायग्नोस्टिक्स रिपोर्ट",
      emailIntro: "कृपया इस पंक्ति के ऊपर अपना प्रश्न या समस्या लिखें।",
    },
  },

  logs: {
    title: "लॉग",
    close: "बंद करें",
    copy: "कॉपी करें",
    copied: "लॉग कॉपी किए गए",
    clear: "साफ़ करें",
    count: "{count} प्रविष्टियाँ",
    empty: "अभी कोई लॉग नहीं",
  },

  danger: {
    clearCache: {
      title: "कैश साफ़ करें",
      description: "सभी डाउनलोड किए गए ऑडियो और प्रतिलिपियाँ हटा देता है",
    },
  },

  appVersion: "ऐप संस्करण",
  contentDatabase: "सामग्री डेटाबेस",
  activeServer: "सक्रिय CDN",
}
