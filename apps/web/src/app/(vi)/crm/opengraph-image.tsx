// SPDX-License-Identifier: AGPL-3.0-only
import { OG_SIZE, renderOgImage } from '../../../components/og-image';
import { crmVi } from '../../../content/crm-vi';
import { vi } from '../../../content/vi';

export const alt = crmVi.meta.title;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderOgImage({ name: crmVi.appName, title: crmVi.ogTitle, tagline: vi.footer.tagline });
}
