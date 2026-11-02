import type { Dictionary } from '../../content/vi';
import { DOCS_URL, SIGN_IN_URL } from '../../content/site';
import { LANG_PARAM } from '../../lib/language';
import { MobileMenu } from './mobile-menu';
import { ThemeToggle } from './theme-toggle';
import { LudyMark } from './ui';

// The language switch is a plain link to the same address with `?lang=<other>`: the proxy remembers the choice in a
// cookie and sends the visitor back to the address without it, so both languages have one URL (#2360). On the home
// page the section links are anchors on the page itself; any other page points them at the home page's sections
// (`linkToHome`).
export function SiteHeader({ dict, linkToHome = false }: { dict: Dictionary; linkToHome?: boolean }) {
  const { nav } = dict;
  const home = '/';
  const base = linkToHome ? home : '';
  const otherLang = dict.lang === 'vi' ? 'en' : 'vi';
  const sections = [
    { label: nav.product, href: `${base}#san-pham` },
    { label: nav.openSource, href: `${base}#ma-nguon-mo` },
    { label: nav.pricing, href: `${base}#bang-gia` },
    { label: nav.docs, href: DOCS_URL },
  ];
  return (
    <header className="sticky top-[env(safe-area-inset-top,0px)] z-40 border-b border-line bg-bg">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm">
        {nav.skip}
      </a>
      <div className="wrap flex h-15 items-center gap-6">
        <a href={home} className="flex items-center gap-2 text-fg" aria-label="Ludy">
          <LudyMark className="size-6" />
          <span className="font-display text-lg font-semibold tracking-[-0.01em]">Ludy</span>
        </a>
        <nav aria-label={nav.label} className="hidden items-center gap-1 md:flex">
          {sections.map(({ label, href }) => (
            <a key={href} href={href} className="rounded-md px-3 py-2 text-sm text-muted transition-colors hover:text-fg">
              {label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <a
            href={`?${LANG_PARAM}=${otherLang}`}
            rel="nofollow"
            title={nav.otherLangLabel}
            className="inline-flex h-9 items-center rounded-md px-2 text-xs font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            {/* The accessible name starts with the visible text (WCAG 2.5.3, label in name). */}
            <span lang={otherLang}>{nav.otherLang}</span>
            <span className="sr-only">, {nav.otherLangLabel}</span>
          </a>
          <ThemeToggle toLight={nav.toLight} toDark={nav.toDark} />
          <a href={SIGN_IN_URL} className="hidden h-9 items-center rounded-md px-3 text-sm text-muted transition-colors hover:text-fg sm:inline-flex">
            {nav.signIn}
          </a>
          <a href={`${base}#tu-host`} className="hidden h-9 items-center rounded-md bg-fg px-3 text-sm font-medium whitespace-nowrap text-bg transition-colors hover:bg-fg/85 sm:inline-flex">
            {nav.cta}
          </a>
          <MobileMenu
            links={[...sections, { label: nav.signIn, href: SIGN_IN_URL }, { label: nav.cta, href: `${base}#tu-host` }]}
            openLabel={nav.openMenu}
            closeLabel={nav.closeMenu}
          />
        </div>
      </div>
    </header>
  );
}
