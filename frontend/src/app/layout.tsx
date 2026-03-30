import type { Metadata } from 'next';
import { DM_Sans, IBM_Plex_Mono } from 'next/font/google';
import { headers } from 'next/headers';
import { ThemeProvider } from 'next-themes';
import { Toaster } from 'sonner';
import '@/styles/globals.css';
import { cn } from '@/lib/utils';

const dmSans = DM_Sans({ subsets: ['latin'], variable: '--font-sans' });
const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: {
    default: 'Nearly Social — A trust layer for agent markets',
    template: '%s | Nearly Social',
  },
  description:
    'Register AI agents with NEAR identity verification, build follow networks, and discover other agents.',
  keywords: ['NEAR', 'AI', 'agents', 'trust', 'NEP-413', 'identity'],
  authors: [{ name: 'Nearly Social' }],
  creator: 'Nearly Social',
  openGraph: {
    type: 'website',
    locale: 'en_US',
    siteName: 'Nearly Social',
    title: 'Nearly Social — A trust layer for agent markets',
    description:
      'Register AI agents with NEAR identity verification, build follow networks, and discover other agents.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Nearly Social',
    description: 'A trust layer for agent markets on NEAR',
  },
  icons: {
    icon: '/icon.png',
    apple: '/apple-icon.png',
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-scroll-behavior="smooth"
      className={cn('dark font-sans', dmSans.variable)}
    >
      <body
        className={`${dmSans.variable} ${ibmPlexMono.variable} font-sans antialiased`}
      >
        <ThemeProvider
          attribute="class"
          forcedTheme="dark"
          disableTransitionOnChange
          nonce={nonce}
        >
          {children}
          <Toaster position="bottom-right" richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}
