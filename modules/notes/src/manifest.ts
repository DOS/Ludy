// The notes module's manifest (plan §5.2, #1588, #1599; notes plan docs/plan/notes.md §3.4): the tables it owns and the
// class of every column. A migration that adds or drops a table or column of crove_notes changes this list in the same
// PR; apps/kernel/test/manifest.db.test.ts checks it against the catalog. A column is internal unless the second
// argument of columns() classifies it. The title, body, tags (and a to-do's details and checklist) and their folded search words are a member's free text,
// which may name people, so pii: audit rows keep a marker for them (auditValue), never the text.
import { MODULE_SCREENS, columns, defineModule } from '@crove/kernel-contract';

export const notesManifest = defineModule({
  id: 'notes',
  dependsOn: ['kernel'],
  tables: {
    crove_notes: {
      attachment: columns(
        ['org_id', 'id', 'note_id', 'author_user_id', 'content_type', 'size_bytes', 'sha256', 'storage_key', 'extract_status', 'created_at'],
        { filename: 'pii', extracted_text: 'pii', search: 'pii' },
      ),
      attachment_blob_doomed: columns(['storage_key', 'queued_at', 'not_before', 'claimed_until', 'attempts']),
      link: columns(['org_id', 'id', 'note_id', 'todo_id', 'target_type', 'target_id', 'party_id', 'file_id', 'task_id', 'created_by', 'created_at']),
      note: columns(
        ['org_id', 'id', 'author_user_id', 'notebook_id', 'visibility', 'pinned', 'tainted', 'summary_run_ids', 'revision', 'created_at', 'updated_at', 'archived_at', 'deleted_at'],
        { title: 'pii', body: 'pii', tags: 'pii', search: 'pii' },
      ),
      // Quick note templates (#3562), private to their author or shared with the org.
      note_template: columns(
        ['org_id', 'id', 'author_user_id', 'visibility', 'revision', 'created_at', 'updated_at'],
        { name: 'pii', title: 'pii', body: 'pii', tags: 'pii' },
      ),
      // Rolling 20-snapshot version history of a note (#3562), inheriting its parent note's visibility.
      note_version: columns(
        ['org_id', 'id', 'note_id', 'author_user_id', 'revision', 'tainted', 'created_at'],
        { title: 'pii', body: 'pii', tags: 'pii' },
      ),
      // Notebooks and 2-level stacks (#3559), private to their author or shared with the org: name and stack_name are free text, so pii.
      notebook: columns(
        ['org_id', 'id', 'author_user_id', 'visibility', 'pinned', 'sort_key', 'revision', 'created_at', 'updated_at'],
        { name: 'pii', stack_name: 'pii' },
      ),
      // A member's own to-do (#1673), always private: its title, details and checklist steps are free text, so pii.
      todo: columns(
        [
          'org_id', 'id', 'owner_user_id', 'status', 'priority', 'due_on', 'due_at', 'time_zone', 'remind_at', 'reminded_at', 'list_id', 'section_id', 'sort_key', 'source_note_id', 'source_run_id', 'source_run_seq', 'task_id', 'tainted',
          'recurrence', 'series_id', 'revision', 'created_at', 'updated_at', 'done_at', 'deleted_at',
        ],
        { title: 'pii', details: 'pii', checklist: 'pii', tags: 'pii', search: 'pii' },
      ),
      // A member's own to-do list (#3558), always private: its name and section names are free text, so pii.
      todo_list: columns(
        ['org_id', 'id', 'owner_user_id', 'color', 'sort_key', 'revision', 'created_at', 'updated_at', 'deleted_at'],
        { name: 'pii', sections: 'pii' },
      ),
    },
  },
  // It owns no permission: access comes from the base role (owners, admins and members write notes), and who reads a
  // note is the database's row policies (ADR-0037).
  permissions: [],
  // Its entities (#1656): the note, the to-do and the to-do list, which every command names as its audit target.
  entities: [
    { type: 'notes.attachment', table: 'attachment', legalEntityScoped: false, audit: 'command' },
    { type: 'notes.note', table: 'note', legalEntityScoped: false, audit: 'command' },
    { type: 'notes.notebook', table: 'notebook', legalEntityScoped: false, audit: 'command' },
    { type: 'notes.template', table: 'note_template', legalEntityScoped: false, audit: 'command' },
    { type: 'notes.todo', table: 'todo', legalEntityScoped: false, audit: 'command' },
    { type: 'notes.todo_list', table: 'todo_list', legalEntityScoped: false, audit: 'command' },
  ],
  // Its screens in the app and its menu items (#1652), kept with the other modules' in @crove/kernel-contract.
  ...MODULE_SCREENS.notes,
});
