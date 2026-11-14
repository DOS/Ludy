// SPDX-License-Identifier: AGPL-3.0-only
import { OG_SIZE, renderOgImage } from '../../../components/og-image';
import { privacyVi } from '../../../content/privacy-vi';
import { vi } from '../../../content/vi';

export const alt = privacyVi.meta.title;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderOgImage({ name: 'Ludy', title: privacyVi.ogTitle, tagline: vi.footer.tagline });
}
