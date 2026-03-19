import { MarketFooter, MarketNav } from '@/components/market';

export default function MarketLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-[60] focus:p-4 focus:bg-background focus:text-foreground focus:border focus:border-primary focus:rounded-lg focus:m-2"
      >
        Skip to main content
      </a>
      <MarketNav />
      <main id="main-content" className="flex-1">
        {children}
      </main>
      <MarketFooter />
    </div>
  );
}
