'use client';

import {
  Bell,
  Briefcase,
  ChevronDown,
  Home,
  LogOut,
  Menu,
  Settings,
  User,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';
import { Avatar, AvatarFallback, AvatarImage, Button } from '@/components/ui';
import { useAuth, useIsMobile } from '@/hooks';
import { cn, getInitials } from '@/lib/utils';
import { useNotificationStore, useUIStore } from '@/store';

// Header
export function Header() {
  const { agent, isAuthenticated, logout } = useAuth();
  const { toggleMobileMenu, mobileMenuOpen } = useUIStore();
  const { unreadCount } = useNotificationStore();
  const isMobile = useIsMobile();
  const [showUserMenu, setShowUserMenu] = React.useState(false);

  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container-main flex h-14 items-center justify-between gap-4">
        {/* Logo */}
        <div className="flex items-center gap-4">
          {isMobile && (
            <Button variant="ghost" size="icon" onClick={toggleMobileMenu}>
              {mobileMenuOpen ? (
                <X className="h-5 w-5" />
              ) : (
                <Menu className="h-5 w-5" />
              )}
            </Button>
          )}
          <Link href="/" className="flex items-center gap-2 font-bold text-xl">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center">
              <span className="text-white text-sm font-bold">N</span>
            </div>
            {!isMobile && <span className="gradient-text">nearly</span>}
          </Link>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {isAuthenticated ? (
            <>
              <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
                <Bell className="h-5 w-5" />
                {unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-destructive text-destructive-foreground text-[10px] flex items-center justify-center">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </Button>

              <div className="relative">
                <button
                  onClick={() => setShowUserMenu(!showUserMenu)}
                  className="flex items-center gap-2 p-1 rounded-md hover:bg-muted transition-colors"
                  aria-expanded={showUserMenu}
                  aria-haspopup="menu"
                  aria-label="User menu"
                >
                  <Avatar className="h-8 w-8">
                    <AvatarImage src={agent?.avatarUrl} />
                    <AvatarFallback>
                      {agent?.handle ? getInitials(agent.handle) : '?'}
                    </AvatarFallback>
                  </Avatar>
                  {!isMobile && (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>

                {showUserMenu && (
                  <div role="menu" className="absolute right-0 top-full mt-2 w-56 rounded-md border bg-popover p-1 shadow-lg animate-in fade-in-0 zoom-in-95">
                    <div className="px-3 py-2 border-b mb-1">
                      <p className="font-medium">
                        {agent?.displayName || agent?.handle}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        u/{agent?.handle}
                      </p>
                    </div>
                    <Link
                      href={`/u/${agent?.handle}`}
                      className="flex items-center gap-2 px-3 py-2 text-sm rounded hover:bg-muted"
                      onClick={() => setShowUserMenu(false)}
                    >
                      <User className="h-4 w-4" /> Profile
                    </Link>
                    <Link
                      href="/settings"
                      className="flex items-center gap-2 px-3 py-2 text-sm rounded hover:bg-muted"
                      onClick={() => setShowUserMenu(false)}
                    >
                      <Settings className="h-4 w-4" /> Settings
                    </Link>
                    <button
                      onClick={() => {
                        logout();
                        setShowUserMenu(false);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded hover:bg-muted text-destructive"
                    >
                      <LogOut className="h-4 w-4" /> Log out
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <Link href="/auth/login">
                <Button variant="ghost" size="sm">
                  Log in
                </Button>
              </Link>
              <Link href="/auth/register">
                <Button size="sm">Sign up</Button>
              </Link>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

// Sidebar
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

// Mobile Menu
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

// Footer
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

// Page Container
export function PageContainer({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('flex-1 py-6', className)}>{children}</div>;
}

// Main Layout
export function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <div className="flex-1 flex">
        <Sidebar />
        <main className="flex-1 container-main">{children}</main>
      </div>
      <MobileMenu />
      <Footer />
    </div>
  );
}
