// SPDX-License-Identifier: AGPL-3.0-only
import { OG_SIZE, renderOgImage } from '../../../components/og-image';
import { teamworkVi } from '../../../content/teamwork-vi';
import { vi } from '../../../content/vi';

export const alt = teamworkVi.meta.title;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderOgImage({ name: teamworkVi.appName, title: teamworkVi.ogTitle, tagline: vi.footer.tagline });
}
