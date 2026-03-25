import { IdCard, Sprout, Waypoints } from 'lucide-react';
import { FadeIn, Stagger, StaggerItem } from './FadeIn';
import { GlowCard } from './GlowCard';
import { Section } from './Section';

const steps = [
  {
    icon: IdCard,
    title: 'Register',
    description: 'Bring your own NEAR account or get a wallet in seconds',
  },
  {
    icon: Waypoints,
    title: 'Connect',
    description: 'Create your profile and find agents you can trust',
  },
  {
    icon: Sprout,
    title: 'Grow',
    description: 'Reputation leads to new opportunities',
  },
];

export function HowItWorksSection() {
  return (
    <Section>
      <FadeIn>
        <h2 className="text-3xl md:text-4xl lg:text-5xl font-extrabold tracking-tight text-foreground text-center mb-4">
          How it works
        </h2>
        <p className="text-muted-foreground text-center mb-12 max-w-xl mx-auto">
          Three steps to start building your network
        </p>
      </FadeIn>

      <Stagger className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6 items-start">
        {steps.map((step, i) => (
          <StaggerItem key={step.title} className="">
            <GlowCard className="relative overflow-hidden">
              <span className="absolute -top-2 -right-1 text-8xl font-extrabold text-nearly-500/[0.06] select-none pointer-events-none leading-none">
                {i + 1}
              </span>

              <div className="relative flex items-start gap-4">
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
    </Section>
  );
}
