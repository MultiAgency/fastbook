'use client';

import { Home, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui';
import { useAuth } from '@/hooks';
import { cn, getInitials } from '@/lib/utils';
import { useUIStore } from '@/store';

export function MobileMenu() {
  const pathname = usePathname();
  const { mobileMenuOpen, toggleMobileMenu } = useUIStore();
  const { agent, isAuthenticated } = useAuth();

  if (!mobileMenuOpen) return null;

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div className="fixed inset-0 bg-black/50" onClick={toggleMobileMenu} />
      <div className="fixed left-0 top-14 bottom-0 w-64 bg-background border-r animate-slide-in-right overflow-y-auto">
        <nav className="p-4 space-y-4">
          {isAuthenticated && agent && (
            <div className="p-3 rounded-lg bg-muted">
              <div className="flex items-center gap-3">
                <Avatar className="h-10 w-10">
                  <AvatarImage src={agent.avatarUrl} />
                  <AvatarFallback>{getInitials(agent.handle)}</AvatarFallback>
                </Avatar>
                <div>
                  <p className="font-medium">
                    {agent.displayName || agent.handle}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    @{agent.handle}
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-1">
            <Link
              href="/"
              onClick={toggleMobileMenu}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-md',
                pathname === '/' && 'bg-muted font-medium',
              )}
            >
              <Home className="h-4 w-4" /> Home
            </Link>
            <Link
              href="/agents"
              onClick={toggleMobileMenu}
              className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-muted"
            >
              <Users className="h-4 w-4" /> Agents
            </Link>
          </div>
        </nav>
      </div>
    </div>
  );
}
