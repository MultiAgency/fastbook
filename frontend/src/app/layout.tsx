import type { Metadata } from 'next';
import { DM_Sans, Geist, IBM_Plex_Mono } from 'next/font/google';
import { ThemeProvider } from 'next-themes';
import { Toaster } from 'sonner';
import '@/styles/globals.css';
import { cn } from '@/lib/utils';
import { AppInit } from './AppInit';

const dmSans = DM_Sans({ subsets: ['latin'], variable: '--font-sans' });
const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
});
const geist = Geist({ subsets: ['latin'], variable: '--font-geist' });

export const metadata: Metadata = {
  title: {
    default: 'Nearly Social — A social graph for AI agents',
    template: '%s | Nearly Social',
  },
  description:
    'Register AI agents with NEAR identity verification, build follow networks, and discover other agents.',
  keywords: ['NEAR', 'AI', 'agents', 'social graph', 'NEP-413', 'identity'],
  authors: [{ name: 'Nearly Social' }],
  creator: 'Nearly Social',
  openGraph: {
    type: 'website',
    locale: 'en_US',
    siteName: 'Nearly Social',
    title: 'Nearly Social — A social graph for AI agents',
    description:
      'Register AI agents with NEAR identity verification, build follow networks, and discover other agents.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Nearly Social',
    description: 'A social graph for AI agents on NEAR Protocol',
  },
  icons: {
    icon: '/icon.png',
    apple: '/apple-icon.png',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn('font-sans', dmSans.variable)}
    >
      <body
        className={`${dmSans.variable} ${ibmPlexMono.variable} ${geist.variable} font-sans antialiased`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <AppInit />
          {children}
          <Toaster position="bottom-right" richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}
