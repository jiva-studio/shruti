
import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '@/contexts/LanguageContext';
import { Facebook, DollarSign, MessageCircle, Linkedin } from 'lucide-react';

const Footer = () => {
  const currentYear = new Date().getFullYear();
  const { t } = useLanguage();
  
  return (
    <footer className="bg-sadu-dark-purple text-white py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col md:flex-row justify-between items-center">
          {/* App name and copyright */}
          <div className="mb-6 md:mb-0">
            <div className="flex items-center mb-2">
              <span className="text-xl font-serif font-semibold">Shruti</span>
            </div>
            <p className="text-sm text-gray-300">
              © {currentYear} AKd Studios
            </p>
          </div>
          
          {/* Links section */}
          <div className="grid grid-cols-1 gap-x-12 gap-y-4 mb-6 md:mb-0">
            {/* Legal links */}
            <div>
              <h3 className="font-medium text-sm mb-2">{t('footer.legal')}</h3>
              <ul className="space-y-2 text-sm text-gray-300">
                <li><Link to="/terms" className="hover:text-white transition-colors">{t('footer.terms')}</Link></li>
                <li><Link to="/policy" className="hover:text-white transition-colors">{t('footer.privacy')}</Link></li>
              </ul>
            </div>
          </div>
          
          {/* Social and donation links */}
          <div>
            <h3 className="font-medium text-sm mb-2 text-center md:text-right">{t('footer.follow')}</h3>
            <div className="flex space-x-3 mb-3">
              <a href="https://www.facebook.com/groups/akd.studios/" target="_blank" rel="noopener noreferrer" className="p-2 rounded-full bg-sadu-purple/20 hover:bg-sadu-purple/30 transition-colors">
                <Facebook className="h-4 w-4" />
              </a>
              <a href="https://vk.com/akd.studios" target="_blank" rel="noopener noreferrer" className="p-2 rounded-full bg-sadu-purple/20 hover:bg-sadu-purple/30 transition-colors">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M21.547 7h-3.29a.743.743 0 0 0-.655.392s-1.312 2.416-1.734 3.23C14.734 12.813 14 12.126 14 11.368V7.577c0-.322-.181-.577-.498-.577H10.5c-.314 0-.5.245-.5.544 0 .285.428.351.47 1.158v2.752c0 .603-.128.714-.406.714-.735 0-2.531-2.584-3.584-5.536-.208-.478-.393-.658-.81-.658H2.36c-.517 0-.621.245-.621.544 0 .312.407 1.875 1.887 3.93 1.806 2.613 4.328 4.033 6.642 4.033 1.382 0 1.732-.287 1.732-.788v-1.82c0-.517.11-.621.477-.621.27 0 .738.14 1.827 1.132 1.241 1.185 1.447 1.715 2.149 1.715h3.29c.517 0 .776-.258.627-.768-.165-.51-1.849-2.17-1.92-2.271-.262-.329-.184-.478 0-.772.001-.002 2.474-3.329 2.728-4.46.182-.345.025-.498-.358-.498" />
                </svg>
              </a>
              <a href="https://t.me/akd_studios" target="_blank" rel="noopener noreferrer" className="p-2 rounded-full bg-sadu-purple/20 hover:bg-sadu-purple/30 transition-colors">
                <MessageCircle className="h-4 w-4" />
              </a>
              <a href="https://linkedin.com/company/akd-studios" target="_blank" rel="noopener noreferrer" className="p-2 rounded-full bg-sadu-purple/20 hover:bg-sadu-purple/30 transition-colors">
                <Linkedin className="h-4 w-4" />
              </a>
            </div>
            <h3 className="font-medium text-sm mb-2 text-center md:text-right">{t('footer.support')}</h3>
            <div className="flex space-x-3">
              <a href="https://www.patreon.com/shruti" target="_blank" rel="noopener noreferrer" className="p-2 rounded-full bg-sadu-purple/20 hover:bg-sadu-purple/30 transition-colors">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M14.82 2.41C18.78 2.41 22 5.65 22 9.62C22 13.58 18.78 16.8 14.82 16.8C10.85 16.8 7.61 13.58 7.61 9.62C7.61 5.65 10.85 2.41 14.82 2.41M2 21.6H5.5V2.41H2V21.6Z" />
                </svg>
              </a>
              <a href="https://boosty.to/akd-studios" target="_blank" rel="noopener noreferrer" className="p-2 rounded-full bg-sadu-purple/20 hover:bg-sadu-purple/30 transition-colors">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.43-1.58-.85-1.28-.95-2.02-1.54-3.26-2.46-.72-.52-.25-1.07.16-1.67.08-.14 1.88-1.92 1.92-2.08.04-.16-.02-.23-.16-.16-.09.04-1.88 1.25-2.33 1.53-.43.27-.92.3-1.25.02-.38-.32-.65-.59-.88-.88-.67-.88-.78-1.36 0-1.98.29-.22 2.42-1.6 4.76-3.03.7-.41 1.18-.21 1.38-.02.82.79.97 1.59.9 2.36z" />
                </svg>
              </a>
              <a href="https://paypal.me/akdstudios" target="_blank" rel="noopener noreferrer" className="p-2 rounded-full bg-sadu-purple/20 hover:bg-sadu-purple/30 transition-colors">
                <DollarSign className="h-4 w-4" />
              </a>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
