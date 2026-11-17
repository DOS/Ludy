// SPDX-License-Identifier: AGPL-3.0-only
import { OG_SIZE, renderOgImage } from '../../../components/og-image';
import { esignVi } from '../../../content/esign-vi';
import { vi } from '../../../content/vi';

export const alt = esignVi.meta.title;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderOgImage({ name: esignVi.appName, title: esignVi.ogTitle, tagline: vi.footer.tagline });
}
