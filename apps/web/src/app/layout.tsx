import './globals.css';
import type { ReactNode } from 'react';
import { Geist, Geist_Mono } from 'next/font/google';

const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
  display: 'swap',
});

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
});

export const metadata = {
  title: 'Mergecrew',
  description:
    "An autonomous product team that ships PRs every weekday — and stops at a human checkpoint before anything reaches production.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body className="antialiased min-h-screen">{children}</body>
    </html>
  );
}
