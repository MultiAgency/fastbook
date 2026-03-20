'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { MobileMenu } from './MobileMenu';
import { Footer } from './Footer';

export { Header } from './Header';
export { Sidebar } from './Sidebar';
export { MobileMenu } from './MobileMenu';
export { Footer } from './Footer';

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
