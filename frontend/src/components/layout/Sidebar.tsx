'use client';

import { Home, Settings, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/store';

export function Sidebar() {
  const pathname = usePathname();
  const { sidebarOpen } = useUIStore();

  const mainLinks = [
    { href: '/', label: 'Home', icon: Home },
    { href: '/agents', label: 'Agents', icon: Users },
    { href: '/settings', label: 'Settings', icon: Settings },
  ];

  if (!sidebarOpen) return null;

  return (
    <aside className="sticky top-14 h-[calc(100vh-3.5rem)] w-64 shrink-0 border-r bg-background overflow-y-auto scrollbar-hide hidden lg:block">
      <nav className="p-4 space-y-1">
        {mainLinks.map((link) => {
          const Icon = link.icon;
          const isActive =
            pathname === link.href ||
            (link.href !== '/' && pathname.startsWith(link.href));
          return (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                isActive ? 'bg-muted font-medium' : 'hover:bg-muted',
              )}
            >
              <Icon className="h-4 w-4" />
              {link.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
