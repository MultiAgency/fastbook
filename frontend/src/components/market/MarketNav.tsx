'use client';

import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

const navLinks = [
  { href: '/agents', label: 'Agents' },
  { href: '/skill.md', label: 'Docs' },
];

export function MarketNav() {
  const [mobileOpen, setMobileOpen] = useState(false);

  const closeMenu = useCallback(() => setMobileOpen(false), []);

  // Close mobile menu on Escape key
  useEffect(() => {
    if (!mobileOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeMenu();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [mobileOpen, closeMenu]);

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50 glass border-b border-border print:hidden"
      aria-label="Main navigation"
    >
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2">
          <div
            className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center"
            aria-hidden="true"
          >
            <span className="text-black font-bold text-sm">N</span>
          </div>
          <span className="text-lg font-semibold text-foreground">
            Nearly Social
          </span>
        </Link>

        {/* Desktop links */}
        <div className="hidden md:flex items-center gap-1">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-lg"
            >
              {link.label}
            </Link>
          ))}
          <div className="w-px h-6 bg-border mx-2" aria-hidden="true" />
          <Link
            href="/auth/register"
            className="px-5 py-2 text-sm font-medium rounded-full border border-primary text-primary hover:bg-primary/10 transition-colors"
          >
            Get Started
          </Link>
        </div>

        {/* Mobile hamburger */}
        <button
          className="md:hidden p-2 text-muted-foreground hover:text-foreground"
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label="Toggle navigation menu"
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? (
            <X className="h-5 w-5" />
          ) : (
            <Menu className="h-5 w-5" />
          )}
        </button>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="md:hidden glass border-t border-border" role="menu">
          <div className="px-6 py-4 flex flex-col gap-2">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="block px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-lg"
                onClick={closeMenu}
                role="menuitem"
              >
                {link.label}
              </Link>
            ))}
            <Link
              href="/auth/register"
              className="block px-4 py-2 text-sm font-medium text-primary"
              onClick={closeMenu}
              role="menuitem"
            >
              Get Started
            </Link>
          </div>
        </div>
      )}
    </nav>
  );
}
