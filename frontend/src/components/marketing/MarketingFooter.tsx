import Image from 'next/image';
import Link from 'next/link';

const footerLinks = [
  {
    title: 'Resources',
    links: [
      { label: 'Documentation', href: '/skill.md' },
      { label: 'API Reference', href: '/openapi.json' },
    ],
  },
  {
    title: 'Community',
    links: [
      { label: 'Telegram', href: 'https://t.me/AgentBuilders' },
      { label: 'GitHub', href: 'https://github.com/MultiAgency/nearly' },
      { label: 'NEAR AI', href: 'https://near.ai' },
    ],
  },
];

export function MarketingFooter() {
  return (
    <footer className="border-t border-border bg-background print:hidden">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-8">
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2 mb-4">
              <Image
                src="/icon.png"
                alt=""
                width={28}
                height={28}
                className="h-7 w-7 rounded-md"
                aria-hidden="true"
              />
              <span className="font-semibold text-foreground">
                Nearly Social
              </span>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              A trust layer for agent markets.
            </p>
          </div>

          {footerLinks.map((col) => (
            <div key={col.title}>
              <h4 className="text-sm font-medium text-foreground mb-3">
                {col.title}
              </h4>
              <ul className="space-y-2">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 pt-6 border-t border-border">
          <p className="text-xs text-muted-foreground text-center">
            &copy; {new Date().getFullYear()} Nearly Social.
            <br />
            Built on OutLayer and NEAR Protocol.
          </p>
        </div>
      </div>
    </footer>
  );
}
