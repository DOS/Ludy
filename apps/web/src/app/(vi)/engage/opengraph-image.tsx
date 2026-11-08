// SPDX-License-Identifier: AGPL-3.0-only
import { OG_SIZE, renderOgImage } from '../../../components/og-image';
import { engageVi } from '../../../content/engage-vi';
import { vi } from '../../../content/vi';

export const alt = engageVi.meta.title;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderOgImage({ name: engageVi.appName, title: engageVi.ogTitle, tagline: vi.footer.tagline });
}
