
// Define the available languages
export type Language = 'en' | 'ru' | 'uk';

// Define the language context type
export type LanguageContextType = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: string) => string;
};

// Translation map type
export type TranslationMap = Record<string, string>;
