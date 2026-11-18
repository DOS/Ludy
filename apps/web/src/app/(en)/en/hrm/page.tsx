// SPDX-License-Identifier: AGPL-3.0-only
import { HrmPage } from '../../../../components/apps/hrm-page';
import { appPageMetadata } from '../../../../components/root-document';
import { hrmEn } from '../../../../content/hrm-en';
import { APP_PAGES } from '../../../../content/site';

export const metadata = appPageMetadata(hrmEn, 'en', APP_PAGES.hr.path);

export default function HrmEnPage() {
  return <HrmPage lang="en" />;
}
