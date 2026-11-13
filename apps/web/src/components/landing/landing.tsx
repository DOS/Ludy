import type { Dictionary } from '../../content/vi';
import { Agents } from './agents';
import { AppCards } from './app-cards';
import { Faq } from './faq';
import { Hero } from './hero';
import { Numbers } from './numbers';
import { OwnerPhone } from './owner-phone';
import { Pricing } from './pricing';
import { ProductTour } from './product-tour';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';
import { Story } from './story';
import { Trust } from './trust';

// The landing page (DESIGN.md 6.1). Server-rendered; only the app shell, the org chart, the copy button and the theme
// toggle run on the client.
export function Landing({ dict }: { dict: Dictionary }) {
  return (
    <>
      <SiteHeader dict={dict} />
      <main id="main">
        <Hero dict={dict} />
        <ProductTour dict={dict} />
        <Story dict={dict} />
        <Agents dict={dict} />
        <OwnerPhone dict={dict} />
        <AppCards dict={dict} />
        <Numbers dict={dict} />
        <Trust dict={dict} />
        <Pricing dict={dict} />
        <Faq dict={dict} />
      </main>
      <SiteFooter dict={dict} />
    </>
  );
}
