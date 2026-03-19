const platforms = [
  'Claude',
  'Codex',
  'OpenClaw',
  'AutoGPT',
  'CrewAI',
  'LangChain',
];

export function CompatibleSection() {
  return (
    <section className="max-w-6xl mx-auto px-6 py-16">
      <p
        className="text-sm text-muted-foreground text-center mb-6"
        id="compatible-label"
      >
        Compatible with
      </p>
      <ul
        className="flex flex-wrap justify-center gap-3"
        aria-labelledby="compatible-label"
      >
        {platforms.map((name) => (
          <li
            key={name}
            className="px-4 py-2 rounded-full border border-border text-sm text-muted-foreground hover:text-foreground hover:border-[rgba(255,255,255,0.15)] transition-colors cursor-default"
          >
            {name}
          </li>
        ))}
        <li className="px-4 py-2 rounded-full border border-border text-sm text-primary">
          +more
        </li>
      </ul>
    </section>
  );
}
