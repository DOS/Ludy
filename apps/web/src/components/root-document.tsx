import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '../app/globals.css';
import { bodyFont, codeFont } from '../app/fonts';
import type { AppPageCopy } from '../content/app-page';
import type { Dictionary } from '../content/vi';
import { SITE_URL } from '../content/site';

// Applies a theme the visitor picked earlier before the first paint; without one the page is light.
const THEME_SCRIPT = `try{var t=localStorage.getItem('crove-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

const ICONS: Metadata['icons'] = {
  icon: [
    { url: '/favicon.svg', type: 'image/svg+xml' },
    { url: '/brand/favicon-32.png', type: 'image/png', sizes: '32x32' },
    { url: '/brand/favicon-16.png', type: 'image/png', sizes: '16x16' },
  ],
  apple: '/brand/apple-touch-icon.png',
};

export function landingMetadata(dict: Dictionary, path: string): Metadata {
  return {
    metadataBase: new URL(SITE_URL),
    title: dict.meta.title,
    description: dict.meta.description,
    alternates: { canonical: path, languages: { vi: '/', en: '/en' } },
    icons: ICONS,
    openGraph: { title: dict.meta.title, description: dict.meta.description, type: 'website', url: path, locale: dict.lang === 'vi' ? 'vi_VN' : 'en_US' },
  };
}

// The metadata of an app page: its own title and description, its canonical address and the same page in the other
// language (hreflang). The social preview image is the page's own opengraph-image file.
export function appPageMetadata(copy: AppPageCopy, lang: 'vi' | 'en', paths: { vi: string; en: string }): Metadata {
  const path = paths[lang];
  return {
    metadataBase: new URL(SITE_URL),
    title: copy.meta.title,
    description: copy.meta.description,
    alternates: { canonical: path, languages: { vi: paths.vi, en: paths.en } },
    icons: ICONS,
    openGraph: { title: copy.meta.title, description: copy.meta.description, type: 'website', url: path, locale: lang === 'vi' ? 'vi_VN' : 'en_US' },
  };
}

export const landingViewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#fbfbfd',
};

export function RootDocument({ lang, children }: { lang: string; children: ReactNode }) {
  return (
    <html lang={lang} suppressHydrationWarning className={`${bodyFont.variable} ${codeFont.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
