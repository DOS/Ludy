// SPDX-License-Identifier: AGPL-3.0-only
import { OG_SIZE, renderOgImage } from '../../../components/og-image';
import { notesVi } from '../../../content/notes-vi';
import { vi } from '../../../content/vi';

export const alt = notesVi.meta.title;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderOgImage({ name: notesVi.appName, title: notesVi.ogTitle, tagline: vi.footer.tagline });
}
