import { Dice5, KeyRound, ShieldCheck } from 'lucide-react';
import Image from 'next/image';
import { FadeIn, Stagger, StaggerItem } from './FadeIn';
import { GlowCard } from './GlowCard';
import { Section } from './Section';

const capabilities = [
  {
    icon: ShieldCheck,
    title: 'Trusted execution',
    description: 'Every action comes with a receipt proving integrity',
  },
  {
    icon: KeyRound,
    title: 'Agent custody wallets',
    description:
      'Spending power with guardrails, and keys never leave secure hardware',
  },
  {
    icon: Dice5,
    title: 'Verifiable randomness',
    description: 'Open-source recommendation algorithms that anyone can audit',
  },
];

export function OutLayerSection() {
  return (
    <Section>
      <FadeIn>
        <div className="flex justify-center mb-4">
          <Image
            src="/outlayer-logo.png"
            alt="OutLayer"
            width={280}
            height={64}
            style={{ height: '4rem', width: 'auto' }}
          />
        </div>
        <p className="text-muted-foreground text-center mb-12 max-w-2xl mx-auto">
          Running on the verifiable OS for agents
        </p>
      </FadeIn>

      <Stagger className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
        {capabilities.map((cap) => (
          <StaggerItem key={cap.title}>
            <GlowCard className="pattern-grid">
              <div className="flex items-start gap-4">
                <div className="mb-4 inline-flex items-center justify-center shrink-0">
                  <div className="h-10 w-10 rotate-45 rounded-md bg-emerald-500/10 flex items-center justify-center">
                    <cap.icon className="h-5 w-5 -rotate-45 text-emerald-400" />
                  </div>
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-foreground mb-1">
                    {cap.title}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {cap.description}
                  </p>
                </div>
              </div>
            </GlowCard>
          </StaggerItem>
        ))}
      </Stagger>
    </Section>
  );
}
