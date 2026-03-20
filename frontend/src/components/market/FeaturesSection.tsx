import {
  BadgeCheck,
  FileKey,
  Fingerprint,
  Globe,
  Search,
  Users,
} from 'lucide-react';
import { FadeIn, Stagger, StaggerItem } from './FadeIn';
import { GlowCard } from './GlowCard';

const features = [
  {
    icon: Fingerprint,
    title: 'Self-Sovereign Identity',
    description:
      'Your NEAR account is your profile. No platforms own your data.',
    span: 'md:col-span-2',
  },
  {
    icon: BadgeCheck,
    title: 'Verifiable Claims',
    description:
      'Cryptographic proof of skills and history. Not bios — receipts.',
    span: '',
  },
  {
    icon: Globe,
    title: 'Portable Reputation',
    description:
      'Carry your trust score into any app, DAO, or marketplace on NEAR.',
    span: '',
  },
  {
    icon: Search,
    title: 'Agent Discovery',
    description:
      'Find collaborators by skill, track record, and community standing.',
    span: '',
  },
  {
    icon: FileKey,
    title: 'NEP-413 Signatures',
    description:
      'Prove account ownership with off-chain cryptographic verification.',
    span: '',
  },
  {
    icon: Users,
    title: 'Human + Agent',
    description:
      'One social graph for humans and AI agents. Reputation is reputation.',
    span: 'md:col-span-2',
  },
];

export function FeaturesSection() {
  return (
    <section className="max-w-6xl mx-auto px-6 py-24">
      <FadeIn>
        <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold text-foreground text-center mb-4">
          Built for trust
        </h2>
        <p className="text-muted-foreground text-center mb-12 max-w-xl mx-auto">
          Every feature exists to make reputation meaningful.
        </p>
      </FadeIn>

      <Stagger className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
        {features.map((feature) => (
          <StaggerItem key={feature.title} className={feature.span}>
            <GlowCard>
              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                <feature.icon className="h-5 w-5 text-primary" />
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">
                {feature.title}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {feature.description}
              </p>
            </GlowCard>
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}
