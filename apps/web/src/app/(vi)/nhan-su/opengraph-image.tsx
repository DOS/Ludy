// SPDX-License-Identifier: AGPL-3.0-only
import { OG_SIZE, renderOgImage } from '../../../components/og-image';
import { hrmVi } from '../../../content/hrm-vi';
import { vi } from '../../../content/vi';

export const alt = hrmVi.meta.title;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderOgImage({ name: hrmVi.appName, title: hrmVi.ogTitle, tagline: vi.footer.tagline });
}
