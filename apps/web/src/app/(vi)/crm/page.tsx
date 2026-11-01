// SPDX-License-Identifier: AGPL-3.0-only
import { CrmPage } from '../../../components/apps/crm-page';
import { appPageMetadata } from '../../../components/root-document';
import { crmVi } from '../../../content/crm-vi';
import { APP_PAGES } from '../../../content/site';

export const metadata = appPageMetadata(crmVi, 'vi', APP_PAGES.crm);

export default function CrmViPage() {
  return <CrmPage lang="vi" />;
}
