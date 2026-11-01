import { OG_SIZE, renderOgImage } from '../../../components/og-image';
import { accountingVi } from '../../../content/accounting-vi';
import { vi } from '../../../content/vi';

export const alt = accountingVi.meta.title;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderOgImage({ name: accountingVi.appName, title: accountingVi.ogTitle, tagline: vi.footer.tagline });
}
