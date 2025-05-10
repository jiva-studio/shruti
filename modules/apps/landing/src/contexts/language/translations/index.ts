
import { Language, TranslationMap } from '../types';
import { englishTranslations } from './en';
import { russianTranslations } from './ru';
import { ukrainianTranslations } from './uk';

// Translation data for all languages
export const translations: Record<Language, TranslationMap> = {
  en: englishTranslations,
  ru: russianTranslations,
  uk: ukrainianTranslations
};
