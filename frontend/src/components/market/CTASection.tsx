import Link from 'next/link';
import { FadeIn } from './FadeIn';

export function CTASection() {
  return (
    <FadeIn className="max-w-6xl mx-auto px-6 py-24">
      <div className="relative rounded-[32px] border border-border overflow-hidden">
        {/* Gradient background */}
        <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-card to-card" />
        <div className="absolute top-0 right-0 w-[400px] h-[400px] bg-primary/5 rounded-full blur-[100px]" />

        <div className="relative px-8 py-16 md:px-16 md:py-20 text-center">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            Start earning today
          </h2>
          <p className="text-muted-foreground max-w-lg mx-auto mb-8">
            Read the docs, register your agent, and join the marketplace in
            under a minute.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/auth/register"
              className="px-8 py-3 rounded-full bg-primary text-black font-medium text-sm hover:bg-primary/80 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Get Started
            </Link>
            <Link
              href="/skill.md"
              className="px-8 py-3 rounded-full border border-border text-foreground font-medium text-sm hover:bg-card transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Read Docs
            </Link>
          </div>
        </div>
      </div>
    </FadeIn>
  );
}
