// SPDX-License-Identifier: AGPL-3.0-only
import { en } from '../../content/en';
import { esignEn } from '../../content/esign-en';
import { esignVi } from '../../content/esign-vi';
import { vi } from '../../content/vi';
import { AppPage } from './app-page';
import {
  CeremonyVisual,
  EsignHero,
  HandoffsVisual,
  IntakeAndTemplatesVisual,
  IntegrationsVisual,
  ObligationsAndPlaybookVisual,
  SealingAndVerifyVisual,
} from './esign-visuals';

// The Ludy eSign page (/esign) in either language: the shared app page with this app's copy, its hero picture and one
// visual per group of features. The group ids are those of the copy.
export function EsignPage({ lang }: { lang: 'vi' | 'en' }) {
  const dict = lang === 'vi' ? vi : en;
  const copy = lang === 'vi' ? esignVi : esignEn;
  const props = { dict, copy };
  return (
    <AppPage
      dict={dict}
      copy={copy}
      hero={<EsignHero {...props} />}
      visuals={{
        [copy.groups.items[0]!.id]: <IntakeAndTemplatesVisual {...props} />,
        [copy.groups.items[1]!.id]: <HandoffsVisual {...props} />,
        [copy.groups.items[2]!.id]: <CeremonyVisual {...props} />,
        [copy.groups.items[3]!.id]: <SealingAndVerifyVisual {...props} />,
        [copy.groups.items[4]!.id]: <ObligationsAndPlaybookVisual {...props} />,
        [copy.groups.items[5]!.id]: <IntegrationsVisual {...props} />,
      }}
    />
  );
}
