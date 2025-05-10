
import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Language, LanguageContextType } from './types';
import { translations } from './translations';
import { detectBrowserLanguage } from './utils';

// Create the language context
const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

// Create the language provider component
export const LanguageProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  // Try to get stored language from localStorage, then browser language, or default to English
  const [language, setLanguage] = useState<Language>(() => {
    const storedLanguage = localStorage.getItem('language') as Language;
    
    if (storedLanguage && ['en', 'ru', 'uk'].includes(storedLanguage)) {
      return storedLanguage;
    } else {
      // If no stored preference, detect from browser
      return detectBrowserLanguage();
    }
  });

  // Update localStorage when language changes
  useEffect(() => {
    localStorage.setItem('language', language);
  }, [language]);

  // Translation function
  const t = (key: string): string => {
    const translation = translations[language][key] || key;
    return translation;
  };

  const value = {
    language,
    setLanguage,
    t
  };

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
};

// Create a hook for using the language context
export const useLanguage = (): LanguageContextType => {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
};
