// SPDX-License-Identifier: AGPL-3.0-only
import { NotesPage } from '../../../../components/apps/notes-page';
import { appPageMetadata } from '../../../../components/root-document';
import { notesEn } from '../../../../content/notes-en';
import { APP_PAGES } from '../../../../content/site';

export const metadata = appPageMetadata(notesEn, 'en', APP_PAGES.notes);

export default function NotesEnPage() {
  return <NotesPage lang="en" />;
}
