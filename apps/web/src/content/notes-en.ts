// SPDX-License-Identifier: AGPL-3.0-only
// English copy of the Ludy Notes page (/en/notes), in the shape of notes-vi.ts. The example company, its vendors and
// people are the home page's and stay as they are in Vietnamese where they are names.
import type { NotesCopy } from './notes-vi';

export const notesEn: NotesCopy = {
  appName: 'Ludy Notes',
  meta: {
    title: 'Ludy Notes: your notes and to-dos, next to your customers and documents',
    description:
      'Ludy Notes keeps private or shared notes written in Markdown, right on the screens of your customers, vendors, documents and bookings, plus your own to-do list with due dates and reminders. Open source, and search works without diacritics.',
  },
  ogTitle: 'Your notes and to-dos, next to your customers and documents.',
  crumbLabel: 'Breadcrumb',
  hero: {
    title: 'Your notes and to-dos, next to your customers and documents.',
    lead: 'Ludy Notes keeps notes that are private or shared with the whole organization, and a to-do list of your own with due dates, reminders and steps. A note written on the screen of a customer, a vendor, a document or a booking is right there when you come back.',
    primary: 'Self-host for free',
    secondary: 'Sign in',
    note: 'Open source under the AGPL. Ludy Notes is in the self-hosted edition. On Ludy Cloud: coming soon.',
  },
  how: {
    title: 'Four things to do with notes and to-dos',
    lead: 'Notes and My work are two screens side by side, and the notes panel sits on the other screens.',
    steps: [
      { name: 'Write a note', body: 'Write in Markdown, private to you or shared with the whole organization.', outcome: 'Private at first', tone: 'neutral' },
      { name: 'Attach it to a record', body: 'Write from the Notes panel on the screen of a customer, a vendor, a document, a journal entry or a booking.', outcome: 'Shown right there', tone: 'accent' },
      { name: 'Add a to-do', body: 'Add to My work with a due date, a reminder and steps.', outcome: 'Only you see it', tone: 'ok' },
      { name: 'Hand it over', body: 'If someone else must do it, hand it to a position and it becomes a team task.', outcome: 'Handed over', tone: 'ok' },
    ],
  },
  groups: {
    title: 'What Ludy Notes does today',
    lead: 'Notes, notes where you work, your own to-dos, and your data.',
    items: [
      {
        id: 'notes',
        title: 'Notes',
        lead: 'Private to you or shared, quick to write and easy to find again.',
        points: [
          'A new note is always private. Only its author edits the text',
          'A private note can be read by you alone in this organization, not even by owners and admins. Make it shared and every member except viewers can read it',
          'Write in Markdown: headings, lists, check boxes and links',
          'Tags, pin, archive and trash (emptied after 30 days), with an Undo button when you archive or delete',
        ],
      },
      {
        id: 'where-you-work',
        title: 'Notes where you work',
        lead: 'The Notes panel sits on the very screens you work on.',
        points: [
          'A Notes panel is on the screens of customers, vendors, purchase documents, journal entries, bookings, CRM contacts and the overview',
          'A note written from a panel is attached to that record. Each panel shows only the notes you may read',
          'Search notes by title, tag or content, typed without diacritics, also in Ctrl K',
        ],
      },
      {
        id: 'my-work',
        title: 'My work',
        lead: 'Your own to-do list, with due dates and reminders.',
        points: [
          'Each to-do has a due date, a time, steps and a reminder box. Only you see it, not even owners and admins',
          'Grouped for you as Overdue, Today and Next 7 days',
          'The reminder shows in Ludy’s notification bell, at 8:00 on the due day or 30 minutes before the time you set',
          'Hand a to-do to a position and it becomes a team task. You edit its title and description first; every member can read a team task, and the position may be held by an AI agent',
        ],
      },
      {
        id: 'your-data',
        title: 'Your data',
        lead: 'Download it any time.',
        points: [
          'Download your notes and to-dos as Markdown or JSON, the whole set rather than one note',
          'When a member leaves the organization, their private notes and to-dos are kept sealed for 30 days and then deleted. Shared notes stay',
        ],
      },
    ],
  },
  assistant: {
    title: 'Vy and your notes',
    lead: 'Your notes stay with you.',
    doesTitle: 'Vy and the agents do',
    does: ['Take a to-do you hand to a position held by an AI agent, after you have edited its title and description'],
    doesNotTitle: 'Vy and the agents do not',
    doesNot: ['Read your notes', 'Write or edit notes'],
  },
  audience: {
    title: 'Who Ludy Notes is for',
    lead: 'For people who need to remember many small things about customers and work.',
    items: [
      {
        title: 'Solo founders and small businesses',
        body: 'Keep what you need to remember about each customer and vendor right on their screen, plus a to-do list of your own.',
      },
      {
        title: 'Accountants and accounting firms',
        body: 'Leave a note on a client’s invoice or journal entry. In a client’s organization, the overview shows the notes about that client.',
      },
      {
        title: 'People who self-host',
        body: 'Open source under the AGPL, and the data stays on your server.',
      },
    ],
  },
  faq: {
    title: 'Questions about Ludy Notes',
    items: [
      {
        q: 'Who can read my notes?',
        a: 'A private note can be read by you alone in this organization, not even by owners and admins. A shared note can be read by every member except viewers. Only the author moves a note between private and shared.',
      },
      {
        q: 'Does Ludy Notes remind me by email?',
        a: 'No. A reminder shows in Ludy’s notification bell, at 8:00 on the due day or 30 minutes before the time you set.',
      },
      {
        q: 'Who sees a to-do I hand to a position?',
        a: 'The person holding the position and every member of the organization can read a team task. The details and steps of your own to-do do not carry over; type them into the description if you need them.',
      },
      {
        q: 'I do not see Notes in the menu?',
        a: 'Ludy Notes is a module. Whoever installs Ludy can turn it off, and then there is no Notes menu, no notes panel and no note search.',
      },
    ],
  },
  cta: {
    title: 'Try Ludy Notes with your own work',
    body: 'Self-host for free with a single docker compose command. If you already have an account, sign in.',
    primary: 'See how to self-host',
    secondary: 'Sign in',
  },
  fragments: {
    sample: 'Example data',
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
      hint: 'Every member of the organization and the person holding the position (an AI agent included) will be able to read the title and description below. Edit them before you hand it over.',
      positionLabel: 'Hand over to position',
      position: 'Chief accountant, Chị Lan',
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
      leaveTitle: 'When a member leaves the organization',
      leave: 'Their private notes and to-dos are kept sealed for 30 days and then deleted. Shared notes stay.',
    },
  },
};
