import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'Mergecrew',
  description: 'Autonomous product team in a box.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased min-h-screen">{children}</body>
    </html>
  );
}
