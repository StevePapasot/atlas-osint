import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { cookies, headers } from 'next/headers';
import { Providers } from '@/components/providers';
import './globals.css';

const inter = localFont({
  src: '../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  variable: '--font-inter',
  display: 'swap',
  weight: '100 900',
});

const mono = localFont({
  src: '../../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
  variable: '--font-mono-face',
  display: 'swap',
  weight: '100 800',
});

export const metadata: Metadata = {
  title: { default: 'ATLAS OSINT', template: '%s · ATLAS OSINT' },
  description: 'Evidence-centric open-source intelligence investigation workbench.',
  applicationName: 'ATLAS OSINT',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icons/icon.svg', apple: '/icons/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'ATLAS', statusBarStyle: 'black-translucent' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f7fa' },
    { media: '(prefers-color-scheme: dark)', color: '#090d14' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const theme = store.get('atlas_theme')?.value;
  const density = store.get('atlas_density')?.value === 'compact' ? 'density-compact' : '';
  const themeClass = theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'system';
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" className={`${themeClass} ${density} ${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        <Providers nonce={nonce}>{children}</Providers>
      </body>
    </html>
  );
}
