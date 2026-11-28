// SPDX-License-Identifier: AGPL-3.0-only
import type { Dictionary } from '../../content/vi';
import { Agents } from './agents';
import { AppCards } from './app-cards';
import { Faq } from './faq';
import { Hero } from './hero';
import { Pricing } from './pricing';
import { ProductTour } from './product-tour';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';
import { Trust } from './trust';

// The landing page (7 visual sections): Hero with interactive workspace shell, 6-app visual Bento grid,
// 3-step approval flow + keyboard shortcuts, interactive AI org chart + safety rails, open-source proof,
// Cloud-first Pricing + in-page self-host dock, and concise FAQ + closing CTA.
export function Landing({ dict }: { dict: Dictionary }) {
  return (
    <>
      <SiteHeader dict={dict} />
      <main id="main">
        <Hero dict={dict} />
        <AppCards dict={dict} />
        <ProductTour dict={dict} />
        <Agents dict={dict} />
        <Trust dict={dict} />
        <Pricing dict={dict} />
        <Faq dict={dict} showClosingCta tinted={false} />
      </main>
      <SiteFooter dict={dict} />
    </>
  );
}
