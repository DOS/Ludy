// SPDX-License-Identifier: AGPL-3.0-only
import { AccountingPage } from '../../../../components/apps/accounting-page';
import { accountingEn } from '../../../../content/accounting-en';
import { APP_PAGES } from '../../../../content/site';
import { appPageMetadata } from '../../../../components/root-document';

export const metadata = appPageMetadata(accountingEn, 'en', APP_PAGES.accounting);

export default function AccountingEnPage() {
  return <AccountingPage lang="en" />;
}
