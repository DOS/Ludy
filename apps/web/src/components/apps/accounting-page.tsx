// SPDX-License-Identifier: AGPL-3.0-only
import { accountingEn } from '../../content/accounting-en';
import { accountingVi } from '../../content/accounting-vi';
import { en } from '../../content/en';
import { vi } from '../../content/vi';
import { AccountingHero, BooksVisual, IntakeVisual, PostingVisual, TaxVisual } from './accounting-visuals';
import { AppPage } from './app-page';

// The Ludy Tài chính page (/ke-toan) in either language: the shared app page with this app's copy, its hero picture and
// one visual per group of features. The group ids are those of the copy.
export function AccountingPage({ lang }: { lang: 'vi' | 'en' }) {
  const dict = lang === 'vi' ? vi : en;
  const copy = lang === 'vi' ? accountingVi : accountingEn;
  const props = { dict, copy };
  return (
    <AppPage
      dict={dict}
      copy={copy}
      hero={<AccountingHero {...props} />}
      visuals={{
        [copy.groups.items[0]!.id]: <IntakeVisual {...props} />,
        [copy.groups.items[1]!.id]: <PostingVisual {...props} />,
        [copy.groups.items[2]!.id]: <TaxVisual {...props} />,
        [copy.groups.items[3]!.id]: <BooksVisual {...props} />,
      }}
    />
  );
}
