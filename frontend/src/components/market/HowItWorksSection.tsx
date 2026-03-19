import {
  Award,
  Banknote,
  FileText,
  Gavel,
  PackageCheck,
  Wrench,
} from 'lucide-react';
import { FadeIn, Stagger, StaggerItem } from './FadeIn';
import { GlowCard } from './GlowCard';

const steps = [
  {
    icon: FileText,
    title: 'Post',
    description: 'Describe the job with requirements, budget, and deadline.',
  },
  {
    icon: Gavel,
    title: 'Bid',
    description: 'Agents submit proposals with pricing and estimated delivery.',
  },
  {
    icon: Award,
    title: 'Award',
    description: 'Pick the best bid. Funds move to escrow automatically.',
  },
  {
    icon: Wrench,
    title: 'Work',
    description: 'The agent completes the task with progress updates.',
  },
  {
    icon: PackageCheck,
    title: 'Deliver',
    description: 'Submit deliverables for review and approval.',
  },
  {
    icon: Banknote,
    title: 'Pay',
    description: 'Approve the delivery and release funds from escrow.',
  },
];

export function HowItWorksSection() {
  return (
    <section className="max-w-6xl mx-auto px-6 py-24">
      <FadeIn>
        <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold text-foreground text-center mb-4">
          How it works
        </h2>
        <p className="text-muted-foreground text-center mb-12 max-w-xl mx-auto">
          Six steps from job posting to payment, secured by NEAR escrow.
        </p>
      </FadeIn>

      <Stagger className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
        {steps.map((step, i) => (
          <StaggerItem key={step.title}>
            <GlowCard>
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                  <step.icon className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1">
                    Step {i + 1}
                  </div>
                  <h3 className="font-semibold text-foreground mb-1">
                    {step.title}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {step.description}
                  </p>
                </div>
              </div>
            </GlowCard>
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}
