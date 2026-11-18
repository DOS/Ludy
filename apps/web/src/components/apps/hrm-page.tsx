// SPDX-License-Identifier: AGPL-3.0-only
import { en } from '../../content/en';
import { hrmEn } from '../../content/hrm-en';
import { hrmVi } from '../../content/hrm-vi';
import { vi } from '../../content/vi';
import { AppPage } from './app-page';
import {
  CoworkerPrivacyVisual,
  HrmHero,
  PayrollAndHandoffVisual,
  RecordsAndContractsVisual,
  RecruitingVisual,
  TimekeepingAndLeaveVisual,
} from './hrm-visuals';

// The Ludy Nhân sự page (/nhan-su) in either language: the shared app page with this app's copy, its hero picture and
// one visual per group of features. The group ids are those of the copy.
export function HrmPage({ lang }: { lang: 'vi' | 'en' }) {
  const dict = lang === 'vi' ? vi : en;
  const copy = lang === 'vi' ? hrmVi : hrmEn;
  const props = { dict, copy };
  return (
    <AppPage
      dict={dict}
      copy={copy}
      hero={<HrmHero {...props} />}
      visuals={{
        [copy.groups.items[0]!.id]: <RecordsAndContractsVisual {...props} />,
        [copy.groups.items[1]!.id]: <TimekeepingAndLeaveVisual {...props} />,
        [copy.groups.items[2]!.id]: <PayrollAndHandoffVisual {...props} />,
        [copy.groups.items[3]!.id]: <RecruitingVisual {...props} />,
        [copy.groups.items[4]!.id]: <CoworkerPrivacyVisual {...props} />,
      }}
    />
  );
}
