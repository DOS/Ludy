// SPDX-License-Identifier: AGPL-3.0-only
// English copy of the Ludy Teamwork page (/en/teamwork), in the shape of teamwork-vi.ts. The example company, its
// vendors and customers stay in Vietnamese only where they are allowed proper names.
import type { TeamworkCopy } from './teamwork-vi';
import { N } from './roster';

export const teamworkEn: TeamworkCopy = {
  appName: 'Ludy Teamwork',
  meta: {
    title: 'Ludy Teamwork: my work, team tasks, notes and meetings in one app',
    description:
      'Ludy Teamwork brings together My work, Team tasks, Markdown Notes right next to your customers and documents, and consent-first Meetings with optional AI draft transcripts and summaries. Open source, and search works without diacritics.',
  },
  ogTitle: 'My work, team tasks, notes and meetings, in one app.',
  crumbLabel: 'Breadcrumb',
  hero: {
    title: 'My work, team tasks, notes and meetings, in one app.',
    lead: `Ludy Teamwork brings four everyday screens into one place: My work, Team tasks, Notes and Meetings. Notes sit right on the screens of your customers, vendors and documents; meeting recordings can get an optional draft transcript and summary from ${N.gm}, private to the recorder until published.`,
    primary: 'Self-host for free',
    secondary: 'Sign in',
    note: 'Open source under the AGPL. Ludy Teamwork is in the self-hosted edition. On Ludy Cloud: coming soon.',
  },
  how: {
    title: 'Four screens in Ludy Teamwork',
    lead: 'From your own to-do list to tasks assigned across positions, contextual notes and meeting minutes.',
    steps: [
      { name: 'My work', body: 'Add personal to-dos with due dates, reminders and steps.', outcome: 'Only you see it', tone: 'neutral' },
      { name: 'Team tasks', body: 'Assign work to a position on the org chart, held by a person or an AI coworker.', outcome: 'Tracked by the team', tone: 'accent' },
      { name: 'Notes', body: 'Write in Markdown, keep it private or share it with the organization, attached right to a customer or document.', outcome: 'Shown right there', tone: 'ok' },
      { name: 'Meetings', body: 'Upload a file or record from the browser extension once everyone has agreed; review minutes, decisions and action items.', outcome: 'Minutes ready', tone: 'ok' },
    ],
  },
  groups: {
    title: 'What Ludy Teamwork does today',
    lead: 'Four items in the Teamwork menu: My work, Team tasks, Notes and Meetings.',
    items: [
      {
        id: 'my-work-and-team-tasks',
        title: 'My work and Team tasks',
        lead: 'A private to-do list with due dates and reminders, kept separate from team tasks assigned to positions.',
        points: [
          'Each item in My work has a due date, a time, steps and a reminder box, grouped from Overdue to the next 7 days. Only you see it, not even owners and admins',
          'Reminders show in Ludy’s notification bell at 8:00 on the due day or 30 minutes before the time you set',
          'Handing a personal to-do to a position opens a dialog so you can edit its title and description before creating a Team task; every member can read a Team task, and the position may be held by an AI coworker',
          'Download all of your own notes and personal to-dos as Markdown or JSON any time. When a member leaves the organization, their private notes and to-dos stay sealed for 30 days and are then deleted',
        ],
      },
      {
        id: 'notes',
        title: 'Private and shared Notes',
        lead: 'Quick to write in Markdown, and you choose whether a note stays private or is shared with the organization.',
        points: [
          'A note created on the Notes screen starts private. Only its author edits the text',
          'A private note can be read by you alone in this organization, not even by owners and admins. Make it shared and every member except viewers can read it',
          'Write in Markdown: headings, lists, check boxes and links',
          'Tags, pin, archive and trash (emptied after 30 days), with an Undo button when you archive or delete',
        ],
      },
      {
        id: 'where-you-work',
        title: 'Notes where you work',
        lead: 'The Notes panel sits on the very screens where you handle customers and documents.',
        points: [
          'A Notes panel is on the screens of customers, vendors, purchase documents, journal entries, bookings, CRM contacts and the overview',
          'A note written from a panel is attached to that record (starting shared, with a box to keep it just for you). Each panel shows only the notes you may read',
          'Search notes by title, tag or content, typed without diacritics, also in Ctrl K',
        ],
      },
      {
        id: 'meetings',
        title: 'Meetings: recordings, draft transcripts and minutes',
        lead: 'Keep recordings when everyone has consented, link them to a customer or deal, and print clean minutes when done.',
        points: [
          'Upload an audio or video file on the Meetings screen, record directly in the app, or record a browser tab and microphone with the Ludy extension on Chrome or Edge (connected through the Ludy sign-in page and revocable any time under connected devices in Settings); recording or uploading always asks you to confirm everyone in the meeting agreed first',
          'Audio is encrypted per meeting and kept for 30 days by default (an organization can set it to delete right after the transcript, or after 7, 30 or 90 days); the optional Record video too setting is off by default and keeps video for 7 days by default (configurable to 7 or 30 days, never longer than the audio)',
          `When AI is switched on, the recorder can ask ${N.gm} to transcribe the recording and draft a summary, decisions and action items privately for the recorder; other readers see them only after the recorder reviews and shares them with the attendees (or the organization), and unshared drafts expire after 30 days`,
          'Link a meeting to a customer, vendor, CRM deal or booking; search across transcripts without typing diacritics; open View minutes for an A4 print layout',
        ],
      },
    ],
  },
  coworker: {
    title: `What ${N.gm} does in Ludy Teamwork`,
    lead: `${N.gm} works for the recorder in Meetings when asked, and AI positions take Team tasks when assigned. Your Notes and My work stay strictly yours.`,
    doesTitle: `${N.gm} and AI positions do`,
    does: [
      `In Meetings, when AI is on and the recorder asks, ${N.gm} transcribes and drafts the summary, decisions and action items privately for the recorder to review before sharing`,
      'In Team tasks, a position held by an AI coworker takes a task you assign after you confirm its title and description',
    ],
    doesNotTitle: `${N.gm} and AI positions do not`,
    doesNot: [
      'Never read, write or edit your Notes or your My work items',
      'Never record a meeting on their own or share an AI meeting draft before the recorder shares it',
    ],
  },
  audience: {
    title: 'Who Ludy Teamwork is for',
    lead: 'For teams and solo founders who want tasks, notes and meeting minutes right next to their customers and books.',
    items: [
      {
        title: 'Solo founders and small businesses',
        body: 'Personal to-dos, team tasks, what you need to remember about each customer, and meeting minutes live in one app linked to CRM and Finance.',
      },
      {
        title: 'Accountants and accounting firms',
        body: 'Leave notes on a client’s invoice or journal entry, assign follow-up tasks for missing documents, and keep minutes of period-end reviews.',
      },
      {
        title: 'People who self-host',
        body: 'Open source under the AGPL, with your data and recordings on your own server and storage; AI transcription and summaries use an OpenAI-compatible model you configure and can be switched off.',
      },
    ],
  },
  faq: {
    title: 'Questions about Ludy Teamwork',
    items: [
      {
        q: 'What happened to Ludy Notes?',
        a: 'Ludy Notes now lives alongside My work, Team tasks and Meetings in Ludy Teamwork in the app switcher. The old /notes address redirects permanently to this /cong-tac page.',
      },
      {
        q: 'Who can read my notes and My work?',
        a: 'My work and private notes can be read by you alone in this organization, not even by owners and admins. Shared notes and Team tasks can be read by every member (except viewers for notes). Only the author moves a note between private and shared.',
      },
      {
        q: 'Who can see a meeting recording and its AI draft?',
        a: 'An AI draft transcript and summary are visible only to the person who uploaded or recorded the meeting; once the recorder shares them with the attendees (or widens access to the organization), the meeting’s readers can see them. Audio is kept for 30 days by default (configurable to delete right after the transcript, or after 7, 30 or 90 days) and video, when Record video too is enabled, is kept for 7 days by default (configurable to 7 or 30 days, never longer than the audio).',
      },
      {
        q: 'Does Ludy Teamwork remind me by email?',
        a: 'No. Reminders from My work show in Ludy’s notification bell, at 8:00 on the due day or 30 minutes before the time you set.',
      },
      {
        q: 'Why do I not see Notes or Meetings in the menu?',
        a: 'Notes and Meetings are modules that whoever installs Ludy can turn off individually; when one is off, its menu item and attached panels are hidden.',
      },
    ],
  },
  cta: {
    title: 'Try Ludy Teamwork with your everyday work',
    body: 'Self-host for free with a single docker compose command. If you already have an account, sign in.',
    primary: 'See how to self-host',
    secondary: 'Sign in',
  },
  fragments: {
    sample: 'Example data',
    screenLabel: 'The Ludy Teamwork app',
    menuItems: ['My work', 'Team tasks', 'Notes', 'Meetings'],
    activeMenuItem: 2,
    note: {
      label: 'An open note',
      title: 'Power bills arrive late, remind the client on the 5th',
      tabs: ['Write', 'Preview'],
      current: 1,
      heading: 'Electricity, September',
      bullets: ['The bill arrived on the 12th, 7 days late', 'Remind the client before the 5th of each month'],
      checks: [
        { text: 'Ask EVN about the meter reading date', done: true },
        { text: 'Send the price list to the client again', done: false },
      ],
      linkText: 'See EVN’s price list',
      tags: ['invoices', 'reminder'],
      saved: 'Saved',
      attachedLabel: 'Attached to',
      attached: 'Vendor: EVN',
    },
    share: {
      title: 'Make this note shared',
      body: 'Every member of the organization (except viewers) will be able to read this note. Make it shared?',
      confirm: 'Make shared',
      cancel: 'Cancel',
    },
    panel: {
      screen: 'Vendor: EVN',
      sub: 'Electricity, monthly invoices',
      title: 'Notes',
      pinned: 'Pinned',
      shared: 'Shared',
      private: 'Private',
      notes: [
        { title: 'Power bills arrive late, remind the client on the 5th', pinned: true, shared: true },
        { title: 'Send invoices to the accountant’s email instead', pinned: false, shared: false },
      ],
      paletteLabel: 'Search',
      query: 'invoice',
      group: 'Notes',
      results: ['Power bills arrive late, remind the client on the 5th', 'How we receive a client’s invoices'],
    },
    handover: {
      title: 'Hand this over as a team task',
      hint: 'Every member of the organization and the person holding the position (an AI coworker included) will be able to read the title and description below. Edit them before you hand it over.',
      positionLabel: 'Hand over to position',
      position: 'Chief accountant',
      taskLabel: 'Team task title',
      task: 'Reconcile payables with Bao Bì Phú Thịnh',
      descLabel: 'Description for the team',
      desc: 'Reconcile the balance up to 20/10/2026',
      button: 'Hand over',
    },
    data: {
      title: 'Download',
      note: 'Your own notes and to-dos in this organization, the whole set.',
      markdown: 'Download as Markdown',
      json: 'Download as JSON',
    },
    meeting: {
      label: 'A meeting in Ludy Teamwork',
      title: 'October wholesale rice delivery schedule',
      when: '20/10/2026, 14:00 (28 min)',
      linkedLabel: 'Linked to',
      linked: 'Customer: Gạo Sạch Miền Tây',
      consentBadge: 'Recording consent confirmed',
      retention: 'Encrypted audio, 30 days by default',
      draftBadge: `Draft by ${N.gm}, visible only to recorder`,
      summaryTitle: 'Draft summary and decisions',
      summaryPoints: [
        'Deliver 10 tonnes of ST25 rice in two batches on 24/10 and 31/10 at the Long An warehouse',
        'Send the draft invoice 1 day before each delivery so the customer can check it',
      ],
      actionsTitle: 'Action items noted',
      actions: [
        { text: 'Send two-batch delivery schedule to Gạo Sạch Miền Tây', who: 'Hoa, 21/10' },
        { text: 'Check receivable balance before batch 2', who: 'Lan, 28/10' },
      ],
      publishButton: 'Share with the attendees',
      minutesButton: 'View minutes',
    },
  },
};
