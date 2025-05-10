
import { Button } from '@/components/ui/button';
import { BookOpen, Apple, PlaySquare } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { Carousel, CarouselContent, CarouselItem } from '@/components/ui/carousel';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { useLanguage } from '@/contexts/LanguageContext';

const HeroSection = () => {
  const isMobile = useIsMobile();
  const [currentSlide, setCurrentSlide] = useState(0);
  const { t } = useLanguage();
  
  // Updated images for mobile slideshow
  const slideImages = [
    "https://shruti.app/res/slide1.png",
    "https://shruti.app/res/slide2.png",
    "https://shruti.app/res/slide3.png"
  ];
  
  // Auto-advance slides
  useEffect(() => {
    if (isMobile) {
      const interval = setInterval(() => {
        setCurrentSlide((prev) => (prev + 1) % slideImages.length);
      }, 3000);
      
      return () => clearInterval(interval);
    }
  }, [isMobile, slideImages.length]);
  
  // Helper function to render text with highlights
  const renderWithHighlights = (text: string) => {
    if (!text.includes('[highlight]')) return text;
    
    const parts = text.split(/\[highlight\](.*?)\[\/highlight\]/g);
    return parts.map((part, i) => {
      // Every odd index contains the highlighted text
      if (i % 2 === 1) {
        return <span key={i} className="heading-gradient">{part}</span>;
      }
      return <span key={i}>{part}</span>;
    });
  };
  
  return (
    <section className="pattern-bg min-h-screen flex flex-col items-center justify-center relative pt-16 section-padding">
      <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-sadu-purple/10 rounded-full blur-3xl -z-10" />
      <div className="absolute bottom-1/3 right-1/4 w-72 h-72 bg-sadu-gold/5 rounded-full blur-3xl -z-10" />
      
      <div className="max-w-7xl mx-auto w-full grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
        <div className="flex flex-col space-y-6">
          
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-serif font-bold leading-tight opacity-0 animate-fade-in animate-delay-100">
            {renderWithHighlights(t('hero.title'))}
            <Badge className="ml-2 bg-sadu-gold text-black text-xs px-2 py-0.5 rounded-md align-top translate-y-2">BETA</Badge>
          </h1>
          
          <p className="text-lg text-gray-700 max-w-xl opacity-0 animate-fade-in animate-delay-200">
            {t('app.description')}
          </p>
          
          <div className="flex flex-col sm:flex-row gap-4 pt-4 opacity-0 animate-fade-in animate-delay-300">
            <Button size="lg" className="bg-black hover:bg-black/80 text-white flex items-center" 
              onClick={() => window.open("https://testflight.apple.com/join/KYVY7r3a", "_blank")}>
              <Apple className="mr-2 h-5 w-5" />
              {t('hero.appStore')}
            </Button>
            <Button size="lg" className="bg-black hover:bg-black/80 text-white flex items-center"
              onClick={() => window.open("https://play.google.com/store/apps/details?id=studio.jiva.shruti", "_blank")}>
              <PlaySquare className="mr-2 h-5 w-5" />
              {t('hero.googlePlay')}
            </Button>
          </div>
          
          <div className="flex items-center space-x-4 pt-6 opacity-0 animate-fade-in animate-delay-400">
            <div className="flex -space-x-2">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="w-8 h-8 rounded-full bg-gradient-to-br from-sadu-purple/80 to-sadu-purple/30 border border-white" />
              ))}
            </div>
            <p className="text-sm text-gray-600">
              <span className="font-semibold">1,000+</span> {t('hero.reviews')}
            </p>
          </div>
        </div>
        
        <div className="relative flex items-center justify-center opacity-0 animate-fade-in animate-delay-200">
          <div className="absolute inset-0 bg-gradient-radial from-sadu-purple/20 to-transparent rounded-full blur-2xl -z-10" />
          <div className="w-full max-w-xs mx-auto">
            <div className="relative aspect-[9/19] rounded-[2.5rem] border-8 border-sadu-dark-purple p-1 bg-sadu-off-white shadow-2xl animate-float">
              <div className="absolute inset-0 rounded-[2rem] overflow-hidden">
                {isMobile ? (
                  <div className="w-full h-full">
                    {slideImages.map((src, index) => (
                      <div 
                        key={index} 
                        className={`absolute inset-0 transition-opacity duration-500 ${
                          index === currentSlide ? 'opacity-100' : 'opacity-0'
                        }`}
                      >
                        <img 
                          src={src} 
                          alt={`App preview ${index + 1}`} 
                          className="w-full h-full object-cover"
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <video
                    src="https://shruti.app/res/demo.mp4"
                    autoPlay
                    loop
                    muted
                    playsInline
                    className="w-full h-full object-cover"
                  >
                    Your browser does not support the video tag.
                  </video>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default HeroSection;
