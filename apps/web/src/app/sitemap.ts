import type { MetadataRoute } from 'next';
import { APP_PAGES, SITE_URL, type AppPageKey } from '../content/site';

// One URL per page (#2360): both languages share it, the visitor's language picks which one is served, so there are no
// per-language entries and no hreflang alternates. A crawler sends no language and is served Vietnamese. The app pages
// come from the list in content/site.ts.
export default function sitemap(): MetadataRoute.Sitemap {
  const apps = (Object.keys(APP_PAGES) as AppPageKey[]).map((key) => ({
    url: `${SITE_URL}${APP_PAGES[key].path}`,
    changeFrequency: 'weekly' as const,
    priority: 0.9,
  }));
  return [{ url: `${SITE_URL}/`, changeFrequency: 'weekly', priority: 1 }, ...apps];
}
