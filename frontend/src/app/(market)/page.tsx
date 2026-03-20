import {
  CommunitySection,
  CompatibleSection,
  CTASection,
  FeaturesSection,
  HeroSection,
  HowItWorksSection,
} from '@/components/market';

export default function MarketHomePage() {
  return (
    <>
      <HeroSection />
      <CompatibleSection />
      <HowItWorksSection />
      <FeaturesSection />
      <CommunitySection />
      <CTASection />
    </>
  );
}
