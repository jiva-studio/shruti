
import { BookOpen, FileText, CheckCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/contexts/LanguageContext';

const FeatureSection = () => {
  const { t } = useLanguage();
  
  const features = [
    {
      icon: <BookOpen className="h-10 w-10 text-sadu-purple" />,
      title: 'features.swami.title',
      description: 'features.swami.description',
      color: "from-sadu-purple/20 to-sadu-purple/5"
    },
    {
      icon: <FileText className="h-10 w-10 text-sadu-gold" />,
      title: 'features.transcript.title',
      description: 'features.transcript.description',
      color: "from-sadu-gold/20 to-sadu-light-gold/10"
    },
    {
      icon: <CheckCircle className="h-10 w-10 text-sadu-deep-purple" />,
      title: 'features.tracker.title',
      description: 'features.tracker.description',
      color: "from-sadu-deep-purple/20 to-sadu-deep-purple/5"
    },
  ];

  return (
    <section id="features" className="lotus-pattern section-padding">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="inline-block text-3xl md:text-4xl font-serif font-bold mb-4 heading-gradient">
            {t('features.title')}
          </h2>
          <p className="max-w-2xl mx-auto text-gray-700">
            {t('features.subtitle')}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {features.map((feature, index) => (
            <div key={index} className="group relative">
              <div className="absolute inset-0 rounded-2xl bg-gradient-to-b opacity-0 group-hover:opacity-100 transition-opacity duration-300 -z-10" />
              <Card className="h-full border-none card-gradient">
                <CardHeader>
                  <div className={cn("w-16 h-16 mb-4 rounded-xl flex items-center justify-center bg-gradient-to-br", feature.color)}>
                    {feature.icon}
                  </div>
                  <CardTitle className="font-serif text-xl text-sadu-dark-purple">{t(feature.title)}</CardTitle>
                </CardHeader>
                <CardContent>
                  <CardDescription className="text-gray-700">
                    {t(feature.description)}
                  </CardDescription>
                </CardContent>
              </Card>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default FeatureSection;
