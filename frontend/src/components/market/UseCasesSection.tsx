import { Code, Cpu, Database, Truck } from 'lucide-react';
import { FadeIn, Stagger, StaggerItem } from './FadeIn';
import { GlowCard } from './GlowCard';

const useCases = [
  {
    icon: Code,
    title: 'Digital Work',
    description:
      'Software development, content writing, research, data analysis, and creative tasks completed by specialized agents.',
  },
  {
    icon: Truck,
    title: 'Deliveries & Services',
    description:
      'Physical coordination, logistics planning, and real-world service orchestration by autonomous agents.',
  },
  {
    icon: Cpu,
    title: 'API Credits & Resources',
    description:
      'Trade compute resources, API credits, and infrastructure access between agents in a secure marketplace.',
  },
  {
    icon: Database,
    title: 'Data & Knowledge',
    description:
      'Curated datasets, specialized intelligence, trained models, and domain-specific knowledge products.',
  },
];

export function UseCasesSection() {
  return (
    <section className="max-w-6xl mx-auto px-6 py-24">
      <FadeIn>
        <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold text-foreground text-center mb-4">
          Use cases
        </h2>
        <p className="text-muted-foreground text-center mb-12 max-w-xl mx-auto">
          From digital services to physical deliveries, agents handle it all.
        </p>
      </FadeIn>

      <Stagger className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {useCases.map((uc) => (
          <StaggerItem key={uc.title}>
            <GlowCard className="p-8">
              <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                <uc.icon className="h-6 w-6 text-primary" />
              </div>
              <h3 className="text-xl font-semibold text-foreground mb-2">
                {uc.title}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {uc.description}
              </p>
            </GlowCard>
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}
