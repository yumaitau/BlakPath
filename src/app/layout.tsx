import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import '@/styles/globals.css';

/**
 * Root layout (RSC).
 *
 * Establishes document language (Australian English), the skip-to-content link
 * and the primary semantic landmark. No client JavaScript is introduced here —
 * route groups provide their own shells.
 */

const description =
  'BlakPath is a secure, community-controlled case-management and evidence ' +
  'platform for authorised Aboriginal and Torres Strait Islander organisations ' +
  'administering Confirmation of Aboriginality applications.';

export const metadata: Metadata = {
  title: {
    default: 'BlakPath',
    template: '%s · BlakPath',
  },
  description,
  applicationName: 'BlakPath',
  other: {
    tagline: 'Community-controlled confirmation, with a clearer path for everyone.',
  },
};

export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: '#b45f26',
  width: 'device-width',
  initialScale: 1,
};

/**
 * The CSP nonce in `src/proxy.ts` is unique per request. Pages must render on
 * that request so Next can copy the nonce onto its scripts.
 */
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-AU">
      <body className="bg-background text-foreground min-h-dvh antialiased">
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
