export default {
  appLanguage: {
    title: 'Language',
    description: 'Language of an interface',
  },
  groups: {
    appearance: 'Appearance',
    pro: 'Pro Features',
    contacts: 'Contact Us',
    auth: 'Profile',
    status: 'Status',
  },
  auth: {
    actions: 'Actions',
    syncing: 'Syncing...',
    syncCompletedAt: 
      'Synced at {hour}:{min} | ' +
      'Synced {count} day ago | ' +
      'Synced {count} days ago',
    signedIn: 'You are signed in',
    signOut: 'Sign Out',
    signIn: {
      title: 'Sign In',
      subtitle: 'Sign In With',
      description: 'For data and subscription synchronization'
    },
  },
  player: {
    showProgress: {
      title: 'Player progress',
      description: 'Show progress around play button',
    }
  },
  notes: {
    showTab: {
      title: 'Notes tab',
      description: 'Show notes tab at the bottom'
    }
  },
  transcript: {
    highlightCurrentSentence: {
      title: 'Highlight sentence',
      description: 'Follow the current sentence in the transcript'
    },
    showAutomatically: {
      title: 'Open transcript automatically',
      description: 'Open transcript when playing a lecture'
    }
  },
  contacts: {
    socialNetworks: {
      title: 'Social networks',
      description: 'Let\'s stay connected',
    },
    email: {
      title: 'Send us an email',
      description: 'Have questions or suggestions?',
    }
  },
  subscription: {
    title: 'Subscription',
    description: 'Subscription management',
    yourSubscriptionPlanIs: 'You are a {plan} user!',
    choose: 'Support "Shruti"',
    subscribe: 'Subscribe',
    subscribed: 'Subscription completed',
    restore: 'Restore',
    restored: 'Your subscription has been successfully restored!',
    error: 'An error occurred during the operation. Please try again.',
    noSubscriptionFound: 'No active subscription found. Please subscribe to access premium features.',
    thanks: 'Thank you for your subscription and support 🙏 May your heart be filled with happiness, and each day bring you closer to Truth. We are glad that you are with us on this path.',
    benefits: {
      intro: 'We are implementing new features and improvements. Your support helps us continue development and make the product better.',
      benefit0: {
        title: 'New Lectures',
        description: 'Your subscription helps us continue adding new lectures.',
        icon: '🌟'
      },
      benefit1: {
        title: 'Bookmarks',
        description: 'Save important moments from lectures to return to them later.',
        icon: '🔖'
      },
      benefit2: {
        title: 'Automatic Lecture Downloads',
        description: 'You will always have lectures without needing to manually add them from the library.',
        icon: '📥'
      },
      benefit3: { 
        title: 'Seminars and Courses',
        description: 'Add seminars and courses to your playlist to listen to them in a convenient order.',
        icon: '📚'
      },
      benefit4: { 
        title: 'Dynamic Collections',
        description: 'Create collections for lectures that will automatically update based on specified criteria.',
        icon: '🗃️'
      },
      benefit5: {
        title: 'Advanced Search',
        description: 'Search through lecture texts to quickly find needed moments.',
        icon: '🔍'
      },
    },
    subscriptionIsActive: 'Subscription is active',
    tapToManage: 'You are already subscribed. Tap to manage your subscription.',
    periods: {
      'P1M': 'month',
      'P1Y': 'year',
    },
    plans: {
      '$rc_monthly': 'Monthly',
      '$rc_annual': 'Annual',
    }
  }
}