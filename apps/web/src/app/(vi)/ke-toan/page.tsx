import { AccountingPage } from '../../../components/apps/accounting-page';
import { accountingVi } from '../../../content/accounting-vi';
import { APP_PAGES } from '../../../content/site';
import { appPageMetadata } from '../../../components/root-document';

export const metadata = appPageMetadata(accountingVi, 'vi', APP_PAGES.accounting);

export default function AccountingViPage() {
  return <AccountingPage lang="vi" />;
}
