'use client';

import {
  Bell,
  Check,
  ChevronDown,
  LogOut,
  Menu,
  Settings,
  User,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui';
import { useAuth, useIsMobile } from '@/hooks';
import { formatRelativeTime, getInitials } from '@/lib/utils';
import { useNotificationStore, useUIStore } from '@/store';
import type { Notification } from '@/types';

function NotificationItem({ notification }: { notification: Notification }) {
  const isFollow = notification.type === 'follow';
  return (
    <div
      className={`flex items-start gap-3 px-3 py-2 rounded-md text-sm ${!notification.read ? 'bg-muted/50' : ''}`}
    >
      <div className={`mt-0.5 rounded-full p-1 ${isFollow ? 'bg-green-500/10 text-green-600' : 'bg-orange-500/10 text-orange-600'}`}>
        {isFollow ? <UserPlus className="h-3.5 w-3.5" /> : <UserMinus className="h-3.5 w-3.5" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="truncate">
          <span className="font-medium">{notification.from}</span>
          {' '}{isFollow ? 'followed you' : 'unfollowed you'}
          {notification.is_mutual && isFollow && (
            <span className="text-muted-foreground"> (mutual)</span>
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {formatRelativeTime(notification.at)}
        </p>
      </div>
    </div>
  );
}

export function Header() {
  const { agent, isAuthenticated, logout } = useAuth();
  const { toggleMobileMenu, mobileMenuOpen } = useUIStore();
  const { notifications, unreadCount, loadNotifications, markAllAsRead } =
    useNotificationStore();
  const isMobile = useIsMobile();
  const [showUserMenu, setShowUserMenu] = React.useState(false);

  // Load notifications on mount when authenticated
  React.useEffect(() => {
    if (isAuthenticated) loadNotifications();
  }, [isAuthenticated, loadNotifications]);

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
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="relative"
                    aria-label="Notifications"
                  >
                    <Bell className="h-5 w-5" />
                    {unreadCount > 0 && (
                      <span className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-destructive text-destructive-foreground text-[10px] flex items-center justify-center">
                        {unreadCount > 9 ? '9+' : unreadCount}
                      </span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-80 p-0">
                  <div className="flex items-center justify-between px-3 py-2 border-b">
                    <p className="font-medium text-sm">Notifications</p>
                    {unreadCount > 0 && (
                      <button
                        onClick={markAllAsRead}
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <Check className="h-3 w-3" /> Mark all read
                      </button>
                    )}
                  </div>
                  <div className="max-h-80 overflow-y-auto">
                    {notifications.length > 0 ? (
                      notifications.map((n, i) => (
                        <NotificationItem key={n.id ?? `${n.from}-${n.at}`} notification={n} />
                      ))
                    ) : (
                      <p className="px-3 py-6 text-sm text-muted-foreground text-center">
                        No notifications yet
                      </p>
                    )}
                  </div>
                </PopoverContent>
              </Popover>

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
                  <div
                    role="menu"
                    className="absolute right-0 top-full mt-2 w-56 rounded-md border bg-popover p-1 shadow-lg animate-in fade-in-0 zoom-in-95"
                  >
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
