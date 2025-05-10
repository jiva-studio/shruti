
import React from 'react';
import { useLanguage, Language } from '@/contexts/language';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Map of languages to their labels and flags
const languages: Record<Language, { label: string, flag: string }> = {
  en: { label: 'English', flag: '🇺🇸' },
  ru: { label: 'Русский', flag: '🇷🇺' },
  uk: { label: 'Українська', flag: '🇺🇦' }
};

const LanguageSwitcher: React.FC = () => {
  const { language, setLanguage } = useLanguage();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button 
          variant="outline" 
          size="sm" 
          className="bg-white/80 hover:bg-white text-sadu-dark-purple font-medium text-xs flex items-center gap-1.5"
        >
          {languages[language].flag} <span className="hidden md:inline">{languages[language].label}</span>
          {/* For mobile, just show the flag */}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-32 bg-white/95 backdrop-blur-md">
        {Object.entries(languages).map(([langCode, { label, flag }]) => (
          <DropdownMenuItem 
            key={langCode}
            className={`flex items-center gap-2 ${language === langCode ? 'font-medium text-sadu-purple' : ''}`}
            onClick={() => setLanguage(langCode as Language)}
          >
            <span>{flag}</span>
            <span>{label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default LanguageSwitcher;
