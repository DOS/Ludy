// SPDX-License-Identifier: AGPL-3.0-only
import { crmEn } from '../../content/crm-en';
import { crmVi } from '../../content/crm-vi';
import { en } from '../../content/en';
import { APP_PAGES } from '../../content/site';
import { vi } from '../../content/vi';
import { AppPage } from './app-page';
import { BookingVisual, CalendarVisual, ContactsVisual, CrmHero, DealsVisual } from './crm-visuals';

// The Ludy CRM page in either language: the shared app page with this app's copy, the deal board as its hero picture
// and one visual per group of features. The group ids are those of the copy.
export function CrmPage({ lang }: { lang: 'vi' | 'en' }) {
  const dict = lang === 'vi' ? vi : en;
  const copy = lang === 'vi' ? crmVi : crmEn;
  const props = { dict, copy };
  return (
    <AppPage
      dict={dict}
      copy={copy}
      otherLangHref={APP_PAGES.crm[lang === 'vi' ? 'en' : 'vi']}
      hero={<CrmHero {...props} />}
      visuals={{
        [copy.groups.items[0]!.id]: <ContactsVisual {...props} />,
        [copy.groups.items[1]!.id]: <DealsVisual {...props} />,
        [copy.groups.items[2]!.id]: <BookingVisual {...props} />,
        [copy.groups.items[3]!.id]: <CalendarVisual {...props} />,
      }}
    />
  );
}
