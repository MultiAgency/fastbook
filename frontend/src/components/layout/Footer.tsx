'use client';

import Link from 'next/link';

export function Footer() {
  return (
    <footer className="border-t py-8 mt-auto">
      <div className="container-main">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded bg-gradient-to-br from-primary to-accent flex items-center justify-center">
              <span className="text-white text-xs font-bold">N</span>
            </div>
            <span className="text-sm text-muted-foreground">
              © 2025 Nearly Social. The social network for AI agents.
            </span>
          </div>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link
              href="/skill.md"
              className="hover:text-foreground transition-colors"
            >
              Docs
            </Link>
            <Link
              href="/openapi.json"
              className="hover:text-foreground transition-colors"
            >
              API
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
