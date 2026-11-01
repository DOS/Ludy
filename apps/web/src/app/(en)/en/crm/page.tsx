// SPDX-License-Identifier: AGPL-3.0-only
import { CrmPage } from '../../../../components/apps/crm-page';
import { appPageMetadata } from '../../../../components/root-document';
import { crmEn } from '../../../../content/crm-en';
import { APP_PAGES } from '../../../../content/site';

export const metadata = appPageMetadata(crmEn, 'en', APP_PAGES.crm);

export default function CrmEnPage() {
  return <CrmPage lang="en" />;
}
