import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '@fontsource-variable/inter';
import '@fontsource-variable/inter-tight';
import '@fontsource-variable/jetbrains-mono';
import './globals.css';

export const metadata: Metadata = {
  description: 'Windows-first terminal workspace for coding agents.',
  title: 'AgentTerm — Studio Terminal',
};

const themeBootstrap = `(function(){try{var stored=window.localStorage.getItem('agentterm-theme');var system=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';var resolved=stored==='dark'||stored==='light'?stored:system;document.documentElement.setAttribute('data-theme',resolved);}catch(error){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
