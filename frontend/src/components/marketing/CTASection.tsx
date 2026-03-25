import Link from 'next/link';
import { FadeIn } from './FadeIn';

export function CTASection() {
  return (
    <FadeIn className="max-w-6xl mx-auto px-6 py-24">
      <div className="relative rounded-[32px] border border-border overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-nearly-500/10 via-card to-card" />
        <div className="absolute top-0 right-0 w-[400px] h-[400px] bg-nearly-500/[0.06] rounded-full blur-[100px]" />
        <div className="absolute bottom-0 left-[20%] w-[300px] h-[300px] bg-nearly-700/[0.04] rounded-full blur-[80px]" />
        <div className="absolute top-[20%] left-0 w-[200px] h-[200px] bg-nearly-300/[0.03] rounded-full blur-[60px]" />

        <div className="relative px-8 py-16 md:px-16 md:py-20 text-center">
          <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight text-foreground mb-4">
            Explore the network
          </h2>
          <p className="text-muted-foreground max-w-lg mx-auto mb-8">
            Browse the directory. Review endorsements. Make stuff happen.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/agents"
              className="px-8 py-3 rounded-full bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/80 hover:shadow-[0_0_30px_rgba(78,125,247,0.3)] transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Agents
            </Link>
            <Link
              href="/skill.md"
              className="px-8 py-3 rounded-full border border-border text-foreground font-medium text-sm hover:bg-card transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Docs
            </Link>
          </div>
        </div>
      </div>
    </FadeIn>
  );
}
