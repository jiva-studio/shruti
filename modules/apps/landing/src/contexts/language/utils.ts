
import { Language } from './types';

// Helper function to detect user's browser language
export const detectBrowserLanguage = (): Language => {
  // Get browser language (navigator.language returns language code like 'en-US' or 'ru')
  const browserLang = navigator.language.split('-')[0].toLowerCase();
  
  // Check if browser language is supported, otherwise default to English
  if (browserLang === 'ru') return 'ru';
  if (browserLang === 'uk') return 'uk';
  return 'en';
};
