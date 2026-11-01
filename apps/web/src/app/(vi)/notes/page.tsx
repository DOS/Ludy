// SPDX-License-Identifier: AGPL-3.0-only
import { NotesPage } from '../../../components/apps/notes-page';
import { appPageMetadata } from '../../../components/root-document';
import { notesVi } from '../../../content/notes-vi';
import { APP_PAGES } from '../../../content/site';

export const metadata = appPageMetadata(notesVi, 'vi', APP_PAGES.notes);

export default function NotesViPage() {
  return <NotesPage lang="vi" />;
}
