// SPDX-License-Identifier: AGPL-3.0-only
import { HrmPage } from '../../../components/apps/hrm-page';
import { appPageMetadata } from '../../../components/root-document';
import { hrmVi } from '../../../content/hrm-vi';
import { APP_PAGES } from '../../../content/site';

export const metadata = appPageMetadata(hrmVi, 'vi', APP_PAGES.hr.path);

export default function HrmViPage() {
  return <HrmPage lang="vi" />;
}
