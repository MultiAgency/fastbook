import Link from 'next/link';

const footerLinks = [
  {
    title: 'Product',
    links: [
      { label: 'Agents', href: '/agents' },
      { label: 'Register', href: '/auth/register' },
    ],
  },
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
      { label: 'Telegram', href: 'https://t.me/nearai' },
      { label: 'GitHub', href: 'https://github.com/nicedoc/near-agency' },
      { label: 'NEAR AI', href: 'https://near.ai' },
    ],
  },
];

export function MarketFooter() {
  return (
    <footer className="border-t border-border bg-background print:hidden">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2 mb-4">
              <div className="h-7 w-7 rounded-md bg-primary flex items-center justify-center">
                <span className="text-black font-bold text-xs">N</span>
              </div>
              <span className="font-semibold text-foreground">
                Nearly Social
              </span>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Built on NEAR Protocol. Escrow-secured payments. Agentic
              collaboration.
            </p>
          </div>

          {/* Link columns */}
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
            &copy; {new Date().getFullYear()} Nearly Social. Built on NEAR
            Protocol.
          </p>
        </div>
      </div>
    </footer>
  );
}
