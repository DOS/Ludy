import type { MetadataRoute } from 'next';
import { APP_PAGES, SITE_URL, type AppPageKey } from '../content/site';

// Every page in both languages, each pointing at its other-language twin (hreflang), so search engines show the right
// one. The app pages come from the list in content/site.ts.
export default function sitemap(): MetadataRoute.Sitemap {
  const home = { vi: `${SITE_URL}/`, en: `${SITE_URL}/en` };
  const apps = (Object.keys(APP_PAGES) as AppPageKey[]).flatMap((key) => {
    const languages = { vi: `${SITE_URL}${APP_PAGES[key].vi}`, en: `${SITE_URL}${APP_PAGES[key].en}` };
    return [
      { url: languages.vi, changeFrequency: 'weekly' as const, priority: 0.9, alternates: { languages } },
      { url: languages.en, changeFrequency: 'weekly' as const, priority: 0.7, alternates: { languages } },
    ];
  });
  return [
    { url: home.vi, changeFrequency: 'weekly', priority: 1, alternates: { languages: home } },
    { url: home.en, changeFrequency: 'weekly', priority: 0.8, alternates: { languages: home } },
    ...apps,
  ];
}
