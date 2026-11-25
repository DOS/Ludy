// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for strict Evernote (.enex) and Todoist (.csv) parsers, security sanitizers, priority inversion, and dry-run previews (#3564).
import { describe, expect, it } from 'vitest';
import { NOTE_ATTACHMENT_MAX_BYTES } from '../src/notes.ts';
import {
  ENEX_MAX_ENTITY_REFS,
  ENEX_MAX_NOTES,
  ENEX_MAX_RESOURCE_BASE64_CHARS,
  ENEX_MAX_XML_DEPTH,
  TODOIST_MAX_ROWS,
  TODOIST_MAX_TASKS,
  buildEnexDryRunPreview,
  buildTodoistDryRunPreview,
  convertEnmlToSafeMarkdown,
  decodeStrictBase64,
  deriveTodoistListNameFromFilename,
  invertTodoistPriority,
  md5Hex,
  parseCsvRecords,
  parseEnexImport,
  parseEnexTimestamp,
  parseTodoistCsv,
  parseTodoistDate,
  sanitizeSafeLinkUrl,
} from '../src/notes-import.ts';

function tinyPngBase64(): string {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  return Buffer.from(bytes).toString('base64');
}

describe('Evernote .enex importer', () => {
  it('parses valid ENEX with ENML CDATA DTD header, preserves timestamps, tags, notebook, resources, and converts ENML to safe Markdown', () => {
    const pngB64 = tinyPngBase64();
    const pngBytes = new Uint8Array(Buffer.from(pngB64, 'base64'));
    const hash = md5Hex(pngBytes);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<en-export export-date="20260401T080000Z" application="Evernote">
  <notebook>Work Projects</notebook>
  <note>
    <title>Q4 Launch Plan</title>
    <content><![CDATA[<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
<en-note>
  <h1>Overview</h1>
  <p>Meet with <strong>Alice</strong> &amp; review <a href="https://example.com/docs?a=1&amp;b=2">spec</a>.</p>
  <ul>
    <li><en-todo checked="true"/>Finalize pricing</li>
    <li><en-todo/>Publish notes</li>
  </ul>
  <p>Tracker: <img src="https://evil.example/pixel.png" alt="tracker" /></p>
  <p>Embedded asset: <en-media type="image/png" hash="${hash}" /></p>
  <script>alert('xss')</script>
  <style>body { color: red; }</style>
  <iframe src="https://evil.example/frame"></iframe>
  <a href="javascript:alert(1)" onclick="steal()">Bad Link</a>
  <pre><code>const total = 42;</code></pre>
</en-note>]]></content>
    <created>20250115T093000Z</created>
    <updated>20250201T144500Z</updated>
    <tag>Launch</tag>
    <tag>Q4</tag>
    <note-attributes>
      <source-url>https://evernote.example/note/1</source-url>
    </note-attributes>
    <resource>
      <data encoding="base64">${pngB64}</data>
      <mime>image/png</mime>
      <resource-attributes>
        <file-name>diagram.png</file-name>
      </resource-attributes>
    </resource>
  </note>
</en-export>`;

    const parsed = parseEnexImport(xml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.notes).toHaveLength(1);
    const note = parsed.notes[0]!;
    expect(note.title).toBe('Q4 Launch Plan');
    expect(note.notebookName).toBe('Work Projects');
    expect(note.createdAt).toBe('2025-01-15T09:30:00.000Z');
    expect(note.updatedAt).toBe('2025-02-01T14:45:00.000Z');
    expect(note.tags).toEqual(['launch', 'q4']);
    expect(note.sourceUrl).toBe('https://evernote.example/note/1');
    expect(note.strippedRemoteImages).toBe(1);
    expect(parsed.strippedRemoteImages).toBe(1);

    expect(note.body).toContain('# Overview');
    expect(note.body).toContain('**Alice**');
    expect(note.body).toContain('[spec](https://example.com/docs?a=1&b=2)');
    expect(note.body).toContain('- [x] Finalize pricing');
    expect(note.body).toContain('- [ ] Publish notes');
    expect(note.body).toContain('[Attachment: diagram.png]');
    expect(note.body).toContain('const total = 42;');
    expect(note.body).not.toContain('alert(');
    expect(note.body).not.toContain('<script');
    expect(note.body).not.toContain('<style');
    expect(note.body).not.toContain('color: red');
    expect(note.body).not.toContain('<iframe');
    expect(note.body).not.toContain('javascript:');
    expect(note.body).not.toContain('evil.example');

    expect(note.resources).toHaveLength(1);
    expect(note.resources[0]!.filename).toBe('diagram.png');
    expect(note.resources[0]!.declaredMime).toBe('image/png');
    expect(note.resources[0]!.md5Hex).toBe(hash);
    expect(Array.from(note.resources[0]!.bytes)).toEqual(Array.from(pngBytes));

    const preview = buildEnexDryRunPreview(parsed, [{ name: 'Personal' }], ['Q4 Launch Plan']);
    expect(preview).toMatchObject({
      notesCount: 1,
      attachmentsCount: 1,
      notebooksNew: ['Work Projects'],
      notebooksExisting: [],
      duplicateTitles: 1,
      strippedRemoteImages: 1,
      tagsCount: 2,
    });
  });

  it('fails closed on outer DOCTYPE, ENTITY, XXE, billion laughs, and unknown entities', () => {
    const xxeOuter = `<?xml version="1.0"?>
<!DOCTYPE en-export [
  <!ENTITY secret SYSTEM "file:///etc/passwd">
]>
<en-export><note><title>&secret;</title><content><![CDATA[<en-note>hi</en-note>]]></content></note></en-export>`;
    const res1 = parseEnexImport(xxeOuter);
    expect(res1.ok).toBe(false);
    if (!res1.ok) expect(res1.code).toBe('NOTE_IMPORT_UNSAFE_XML');

    const billionLaughs = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
]>
<en-export><note><title>&lol2;</title><content><![CDATA[<en-note>x</en-note>]]></content></note></en-export>`;
    const res2 = parseEnexImport(billionLaughs);
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.code).toBe('NOTE_IMPORT_UNSAFE_XML');

    const piOuter = `<?xml version="1.0"?><?php system('id'); ?><en-export><note><title>A</title><content><![CDATA[<en-note>x</en-note>]]></content></note></en-export>`;
    const res3 = parseEnexImport(piOuter);
    expect(res3.ok).toBe(false);
    if (!res3.ok) expect(res3.code).toBe('NOTE_IMPORT_UNSAFE_XML');

    const customInnerDtd = `<en-export><note><title>A</title><content><![CDATA[<!DOCTYPE en-note [<!ENTITY x SYSTEM "http://evil.invalid/xxe">]><en-note>&x;</en-note>]]></content></note></en-export>`;
    const res4 = parseEnexImport(customInnerDtd);
    expect(res4.ok).toBe(false);
    if (!res4.ok) expect(res4.code).toBe('NOTE_IMPORT_UNSAFE_XML');

    const unknownEntity = `<en-export><note><title>Test &xxe;</title><content><![CDATA[<en-note>ok</en-note>]]></content></note></en-export>`;
    const res5 = parseEnexImport(unknownEntity);
    expect(res5.ok).toBe(false);
    if (!res5.ok) expect(res5.code).toBe('NOTE_IMPORT_UNSAFE_XML');
  });

  it('rejects malformed XML, non-en-export roots, empty exports, excessive depth, entity ref floods, and note/resource count or size limits', () => {
    expect(parseEnexImport('<en-export><note><title>Unclosed').ok).toBe(false);
    const otherRoot = parseEnexImport('<other-root><note><title>x</title></note></other-root>');
    expect(otherRoot.ok).toBe(false);
    if (!otherRoot.ok) expect(otherRoot.code).toBe('NOTE_IMPORT_INVALID');
    const emptyExport = parseEnexImport('<en-export></en-export>');
    expect(emptyExport.ok).toBe(false);
    if (!emptyExport.ok) expect(emptyExport.code).toBe('NOTE_IMPORT_EMPTY');

    let deep = '<en-note>leaf</en-note>';
    for (let i = 0; i < ENEX_MAX_XML_DEPTH + 5; i += 1) deep = `<a>${deep}</a>`;
    const deepRes = parseEnexImport(`<en-export>${deep}</en-export>`);
    expect(deepRes.ok).toBe(false);
    if (!deepRes.ok) expect(deepRes.code).toBe('TOO_LARGE');

    const manyEntities = '&amp;'.repeat(ENEX_MAX_ENTITY_REFS + 5);
    const entityFlood = parseEnexImport(`<en-export><note><title>${manyEntities}</title></note></en-export>`);
    expect(entityFlood.ok).toBe(false);

    const tooManyNotes = `<en-export>${'<note><title>N</title><content><![CDATA[<en-note>x</en-note>]]></content></note>'.repeat(ENEX_MAX_NOTES + 1)}</en-export>`;
    const notesOver = parseEnexImport(tooManyNotes);
    expect(notesOver.ok).toBe(false);
    if (!notesOver.ok) expect(notesOver.code).toBe('TOO_LARGE');

    const hugeB64 = 'A'.repeat(ENEX_MAX_RESOURCE_BASE64_CHARS + 8);
    const hugeRes = parseEnexImport(
      `<en-export><note><title>Big</title><content><![CDATA[<en-note>x</en-note>]]></content><resource><data encoding="base64">${hugeB64}</data></resource></note></en-export>`,
    );
    expect(hugeRes.ok).toBe(false);
    if (!hugeRes.ok) expect(hugeRes.code).toBe('TOO_LARGE');
  });

  it('strips SVG data URLs, dangerous URL schemes, event handlers, and CSS expression/remote urls cleanly', () => {
    const html = `<en-note>
      <img src="data:image/svg+xml;base64,PHN2Zy8+" />
      <img src="http://tracking.local/open?id=1" />
      <object data="https://evil.test/x.swf"></object>
      <embed src="https://evil.test/x" />
      <a href="vbscript:msgbox(1)">VB</a>
      <a href="https://safe.example/path">Safe</a>
      <span onclick="fetch('http://evil.test')" style="background:url(http://evil.test)">Body</span>
    </en-note>`;
    const out = convertEnmlToSafeMarkdown(html, new Map());
    expect('markdown' in out).toBe(true);
    if (!('markdown' in out)) return;
    expect(out.markdown).toContain('[Safe](https://safe.example/path)');
    expect(out.markdown).toContain('Body');
    expect(out.markdown).not.toContain('vbscript:');
    expect(out.markdown).not.toContain('evil.test');
    expect(out.markdown).not.toContain('tracking.local');
    expect(out.strippedRemoteImages).toBe(2);

    expect(sanitizeSafeLinkUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(sanitizeSafeLinkUrl('mailto:team@example.com')).toBe('mailto:team@example.com');
    expect(sanitizeSafeLinkUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeSafeLinkUrl('data:text/html,<script>1</script>')).toBeNull();
  });

  it('validates base64 decoding and ENEX timestamps cleanly', () => {
    expect(() => decodeStrictBase64('!!!not-base64!!!')).not.toThrow();
    expect(decodeStrictBase64('SGVsbG8=')).not.toBeNull();
    expect(decodeStrictBase64('@@bad@@')).toBeNull();
    expect(decodeStrictBase64('A', NOTE_ATTACHMENT_MAX_BYTES)).toBeNull();

    expect(parseEnexTimestamp('20240615T123045Z')).toBe('2024-06-15T12:30:45.000Z');
    expect(parseEnexTimestamp('invalid')).toBeNull();
  });

  it('scopes dry-run duplicates per (notebook, title) while preserving legacy flat title list compatibility', () => {
    const multiBookXml = `<?xml version="1.0" encoding="UTF-8"?>
<en-export>
  <note>
    <title>Shared Title</title>
    <notebook>Work</notebook>
    <content><![CDATA[<en-note><p>Work copy</p></en-note>]]></content>
  </note>
  <note>
    <title>Shared Title</title>
    <notebook>Personal</notebook>
    <content><![CDATA[<en-note><p>Personal copy</p></en-note>]]></content>
  </note>
  <note>
    <title>Loose Note</title>
    <content><![CDATA[<en-note><p>Unfiled copy</p></en-note>]]></content>
  </note>
</en-export>`;
    const parsed = parseEnexImport(multiBookXml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const notebooks = [
      { id: 'nb-work', name: 'Work' },
      { id: 'nb-personal', name: 'Personal' },
    ];
    // Existing 'Shared Title' is only in Personal and 'Loose Note' is unfiled (notebookId: null).
    const existing = [
      { title: 'Shared Title', notebookId: 'nb-personal' },
      { title: 'Loose Note', notebookId: null },
      { title: 'Only In Work', notebookId: 'nb-work' },
    ];

    const autoPreview = buildEnexDryRunPreview(parsed, notebooks, existing);
    expect(autoPreview.duplicateTitles).toBe(2);
    expect(autoPreview.notebooksExisting).toEqual(['Work', 'Personal']);

    // Forcing all notes into 'Work' avoids colliding with Personal or unfiled, but intra-batch 'Shared Title' x2 counts 1 dup.
    const workPreview = buildEnexDryRunPreview(parsed, notebooks, existing, {
      targetNotebookId: 'nb-work',
      overrideNotebookName: 'Work',
    });
    expect(workPreview.duplicateTitles).toBe(1);
    expect(workPreview.notebooksExisting).toEqual([]);
    expect(workPreview.notebooksNew).toEqual([]);

    // Forcing unfiled matches only existing unfiled 'Loose Note' + intra-batch duplicate 'Shared Title' -> 2 dups.
    const unfiledPreview = buildEnexDryRunPreview(parsed, notebooks, existing, { unfiled: true });
    expect(unfiledPreview.duplicateTitles).toBe(2);

    // Existing unfiled note does not collide when targeting nb-work.
    const noMatchXml = `<en-export><note><title>Loose Note</title><notebook>Work</notebook><content><![CDATA[<en-note>x</en-note>]]></content></note></en-export>`;
    const noMatch = parseEnexImport(noMatchXml);
    expect(noMatch.ok).toBe(true);
    if (noMatch.ok) {
      expect(buildEnexDryRunPreview(noMatch, notebooks, existing).duplicateTitles).toBe(0);
      // Backwards-compatible legacy string[] matches globally as before.
      expect(buildEnexDryRunPreview(noMatch, notebooks, ['Loose Note']).duplicateTitles).toBe(1);
    }
  });

  it('normalizes trailing spaces/tabs before newlines in O(n) without polynomial regex backtracking', () => {
    const html = `<en-note><p>Line 1   \t </p><p>   </p><p>Line 2\t</p></en-note>`;
    const out = convertEnmlToSafeMarkdown(html, new Map());
    expect('markdown' in out).toBe(true);
    if ('markdown' in out) {
      expect(out.markdown).toBe('Line 1\n\nLine 2');
    }

    const hugeSpaces = `<en-note><p>${' '.repeat(80_000)}tail</p></en-note>`;
    const start = Date.now();
    const fastOut = convertEnmlToSafeMarkdown(hugeSpaces, new Map());
    expect(Date.now() - start).toBeLessThan(500);
    expect('markdown' in fastOut).toBe(true);
    if ('markdown' in fastOut) {
      expect(fastOut.markdown).toBe('tail');
    }
  });
});

describe('Todoist .csv importer', () => {
  it('parses UTF-8 BOM, quoted multiline descriptions, sections, checklist nesting, @labels, due dates, and inverts priorities 4->P1..1->P4', () => {
    const csv =
      '\uFEFFTYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,LABELS\r\n' +
      'section,Quarter Planning,,1,1,,,,,,\r\n' +
      'task,"Finalize Q4 ""Launch"" Plan @urgent","Line 1\nLine 2, with comma",4,1,,,2026-04-20T14:30,en,Asia/Ho_Chi_Minh,"Marketing, Launch"\r\n' +
      'task,Draft blog post,,2,2,,,,en,,\r\n' +
      'task,Publish social copy,,1,2,,,,en,,\r\n' +
      'note,Check legal disclaimer before publishing,,1,1,,,,en,,\r\n' +
      'task,Review invoice totals @finance,,3,1,,,2026-04-21,en,Asia/Ho_Chi_Minh,\r\n' +
      'task,Medium task @ops,,2,1,,,,,en,,\r\n' +
      'task,Lowest priority task,,1,1,,,,,en,,\r\n';

    const parsed = parseTodoistCsv(csv, {
      defaultListName: deriveTodoistListNameFromFilename('Team Work [123456].csv'),
      fallbackTimeZone: 'Asia/Ho_Chi_Minh',
      fallbackYear: 2026,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.lists).toHaveLength(1);
    const list = parsed.lists[0]!;
    expect(list.name).toBe('Team Work');
    expect(list.sections).toEqual(['Quarter Planning']);
    expect(list.tasks).toHaveLength(4);

    const first = list.tasks[0]!;
    expect(first.title).toBe('Finalize Q4 "Launch" Plan');
    expect(first.priority).toBe(1); // Todoist CSV 4 -> P1
    expect(first.details).toContain('Line 1\nLine 2, with comma');
    expect(first.details).toContain('Check legal disclaimer before publishing');
    expect(first.dueOn).toBe('2026-04-20');
    expect(first.dueTime).toBe('14:30');
    expect(first.timeZone).toBe('Asia/Ho_Chi_Minh');
    expect(first.sectionName).toBe('Quarter Planning');
    expect(first.tags).toEqual(['urgent', 'marketing', 'launch']);
    expect(first.checklist).toEqual([
      { text: 'Draft blog post', done: false },
      { text: 'Publish social copy', done: false },
    ]);

    expect(list.tasks[1]!.priority).toBe(2); // Todoist CSV 3 -> P2
    expect(list.tasks[1]!.dueOn).toBe('2026-04-21');
    expect(list.tasks[1]!.dueTime).toBeNull();
    expect(list.tasks[1]!.tags).toEqual(['finance']);

    expect(list.tasks[2]!.priority).toBe(3); // Todoist CSV 2 -> P3
    expect(list.tasks[3]!.priority).toBe(4); // Todoist CSV 1 -> P4

    const preview = buildTodoistDryRunPreview(parsed, [{ id: '1', name: 'Personal' }], ['Medium task']);
    expect(preview).toMatchObject({
      tasksCount: 4,
      checklistStepsCount: 2,
      sectionsCount: 1,
      listsNew: ['Team Work'],
      listsExisting: [],
      priorityCounts: { p1: 1, p2: 1, p3: 1, p4: 1 },
      duplicateTitles: 1,
    });
  });

  it('inverts Todoist priorities and safely defaults unknown inputs', () => {
    expect(invertTodoistPriority('4')).toEqual({ priority: 1, valid: true });
    expect(invertTodoistPriority('3')).toEqual({ priority: 2, valid: true });
    expect(invertTodoistPriority('2')).toEqual({ priority: 3, valid: true });
    expect(invertTodoistPriority('1')).toEqual({ priority: 4, valid: true });
    expect(invertTodoistPriority('')).toEqual({ priority: 4, valid: true });
    expect(invertTodoistPriority('9')).toEqual({ priority: 4, valid: false });
    expect(invertTodoistPriority('urgent')).toEqual({ priority: 4, valid: false });
  });

  it('parses Todoist date formats and RFC4180 quotes accurately', () => {
    expect(parseTodoistDate('2026-11-25', 'Asia/Ho_Chi_Minh', 2026)).toEqual({ dueOn: '2026-11-25', dueTime: null, valid: true });
    expect(parseTodoistDate('2026-11-25T09:15', 'Asia/Ho_Chi_Minh', 2026)).toEqual({ dueOn: '2026-11-25', dueTime: '09:15', valid: true });
    expect(parseTodoistDate('Mar 5 2026 6:45pm', 'Asia/Ho_Chi_Minh', 2026)).toEqual({ dueOn: '2026-03-05', dueTime: '18:45', valid: true });
    expect(parseTodoistDate('not a date', 'Asia/Ho_Chi_Minh', 2026)).toEqual({ dueOn: null, dueTime: null, valid: false });

    const unclosedQuote = parseCsvRecords('TYPE,CONTENT\ntask,"unclosed');
    expect(unclosedQuote.unterminated).toBe(true);
    expect(parseTodoistCsv('TYPE,CONTENT\ntask,"unclosed').ok).toBe(false);

    const multiWordLabel = parseTodoistCsv('TYPE,CONTENT,LABELS\ntask,Call @vip,"Khách VIP, Ops Review"\n');
    expect(multiWordLabel.ok).toBe(true);
    if (multiWordLabel.ok) {
      expect(multiWordLabel.lists[0]!.tasks[0]!.tags).toEqual(['vip', 'khách vip', 'ops review']);
    }

    expect(deriveTodoistListNameFromFilename('C:\\exports\\Roadmap [4567].csv')).toBe('Roadmap');
    expect(deriveTodoistListNameFromFilename(`folder/Tabs ${'\t'.repeat(500)} [12].csv`)).toBe('Tabs');
    expect(deriveTodoistListNameFromFilename('Sprint [Q4].csv')).toBe('Sprint [Q4]');
    expect(deriveTodoistListNameFromFilename('blob.csv')).toBeNull();
  });

  it('supports multiple explicit lists via TYPE=list, rejects missing headers, empty files, and enforces row/task caps', () => {
    const multiListCsv = [
      'TYPE,CONTENT,PRIORITY,INDENT',
      'list,Sales Ops,,',
      'task,Call lead,4,1',
      'list,Product,,',
      'section,Bugfix,,',
      'task,Fix crash,3,1',
    ].join('\n');
    const multi = parseTodoistCsv(multiListCsv);
    expect(multi.ok).toBe(true);
    if (multi.ok) {
      expect(multi.lists.map((l) => l.name)).toEqual(['Sales Ops', 'Product']);
      expect(multi.lists[0]!.tasks[0]!.priority).toBe(1);
      expect(multi.lists[1]!.tasks[0]!.sectionName).toBe('Bugfix');
      expect(multi.lists[1]!.tasks[0]!.priority).toBe(2);
    }

    const badHeaders = parseTodoistCsv('FOO,BAR\n1,2');
    expect(badHeaders.ok).toBe(false);
    if (!badHeaders.ok) expect(badHeaders.code).toBe('NOTE_IMPORT_INVALID');

    const emptyTasks = parseTodoistCsv('TYPE,CONTENT\nsection,Only Section');
    expect(emptyTasks.ok).toBe(false);
    if (!emptyTasks.ok) expect(emptyTasks.code).toBe('NOTE_IMPORT_EMPTY');

    const tooManyRows = `TYPE,CONTENT\n${'task,X\n'.repeat(TODOIST_MAX_ROWS + 1)}`;
    const rowOver = parseTodoistCsv(tooManyRows);
    expect(rowOver.ok).toBe(false);
    if (!rowOver.ok) expect(rowOver.code).toBe('TOO_LARGE');

    const tooManyTasks = `TYPE,CONTENT\n${'task,X\n'.repeat(TODOIST_MAX_TASKS + 1)}`;
    const taskOver = parseTodoistCsv(tooManyTasks);
    expect(taskOver.ok).toBe(false);
    if (!taskOver.ok) expect(taskOver.code).toBe('TOO_LARGE');
  });

  it('scopes Todoist dry-run duplicates per (list, title) while preserving legacy flat title list compatibility', () => {
    const csv = [
      'TYPE,CONTENT',
      'list,Work',
      'task,Standup',
      'list,Personal',
      'task,Standup',
      'task,Pay rent',
    ].join('\n');
    const parsed = parseTodoistCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const lists = [
      { id: 'list-work', name: 'Work' },
      { id: 'list-personal', name: 'Personal' },
    ];
    const existing = [
      { title: 'Standup', listId: 'list-personal' },
      { title: 'Pay rent', listId: null },
    ];

    // Only Personal has 'Standup'; Work 'Standup' and Personal 'Pay rent' (existing is in Inbox) do not collide.
    const preview = buildTodoistDryRunPreview(parsed, lists, existing);
    expect(preview.duplicateTitles).toBe(1);

    // Explicit targetListId or useInbox for file without explicit TYPE=list scopes accurately.
    const plain = parseTodoistCsv('TYPE,CONTENT\ntask,Pay rent\ntask,New thing\n', {
      defaultListName: 'Personal',
    });
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect(buildTodoistDryRunPreview(plain, lists, existing).duplicateTitles).toBe(0);
      expect(buildTodoistDryRunPreview(plain, lists, existing, { targetListId: 'list-work' }).duplicateTitles).toBe(0);
      expect(buildTodoistDryRunPreview(plain, lists, existing, { useInbox: true }).duplicateTitles).toBe(1);
      expect(buildTodoistDryRunPreview(plain, lists, ['Pay rent']).duplicateTitles).toBe(1);
    }
  });
});
