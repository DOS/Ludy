// SPDX-License-Identifier: AGPL-3.0-only
// English copy of the Ludy CRM page (/en/crm), in the shape of crm-vi.ts. The example company, its customers, people,
// amounts and dates are the home page's and stay as they are in Vietnamese where they are names.
import type { CrmCopy } from './crm-vi';

export const crmEn: CrmCopy = {
  appName: 'Ludy CRM',
  meta: {
    title: 'Ludy CRM: customers, deals and bookings in one place',
    description:
      'Ludy CRM keeps your contact list, your sales deals on a board by stage and a public booking page where clients pick their own time. Open source, and it shares its customer list with Ludy Accounting.',
  },
  ogTitle: 'Customers, deals and bookings in one place.',
  crumbLabel: 'Breadcrumb',
  hero: {
    title: 'Customers, deals and bookings in one place.',
    lead: 'Ludy CRM keeps your contact list, follows each sales deal through its stages and lets clients pick a time to meet you. A contact is the same customer or vendor that Ludy Accounting already uses.',
    primary: 'Self-host for free',
    secondary: 'Sign in',
    note: 'Open source under the AGPL. Ludy CRM is in the self-hosted edition. On Ludy Cloud: coming soon.',
  },
  how: {
    title: 'Four steps from contact to close',
    lead: 'Each step is its own screen, and they share one list of customers.',
    steps: [
      { name: 'Add a contact', body: 'Create contacts one by one, or import an Excel or CSV file after previewing every row.', outcome: 'In the list', tone: 'neutral' },
      { name: 'Open a deal', body: 'Pick the customer, enter the amount and the expected close date.', outcome: 'At the first stage', tone: 'accent' },
      { name: 'Book a meeting', body: 'Send the booking page, and the client picks a free time.', outcome: 'Booking confirmed', tone: 'ok' },
      { name: 'Close', body: 'Move the deal through the stages until Won or Lost.', outcome: 'Won or Lost', tone: 'ok' },
    ],
  },
  groups: {
    title: 'What Ludy CRM does today',
    lead: 'Four jobs: keep contacts, follow deals, take bookings, connect your calendar.',
    items: [
      {
        id: 'contacts',
        title: 'Contacts',
        lead: 'One list for customers and vendors, shared with Ludy Accounting.',
        points: [
          'A contact is a person or a company, the same party that the invoices in Ludy Accounting use',
          'Search by name, email, phone or tax code, typed without diacritics',
          'Each contact has its deals, its notes (when Ludy Notes is on) and its own timeline',
          'Import from an Excel or CSV file: preview every row as new, duplicate or invalid before importing, and nothing already on file is overwritten. An import cannot be undone',
          'Saved views, private or shared',
        ],
      },
      {
        id: 'deals',
        title: 'Deals and the sales pipeline',
        lead: 'Follow each deal through stages that you set.',
        points: [
          'Each deal has a customer, an amount in dong, an owner, an expected close date and a reason if it is lost',
          'A drag and drop board by stage, with a card count and a total in each column. On a phone or from the keyboard, use the stage selector on the card',
          'Owners and admins name, add, remove and reorder the stages',
          'Filter by status, owner, close date and amount, then save it as a private or shared view',
          'If two people edit at once, the second to save is told and nothing is overwritten. The board does not update for other people’s changes, so reload to see them',
        ],
      },
      {
        id: 'booking',
        title: 'A booking page for clients',
        lead: 'Clients pick a free time themselves, with no account.',
        points: [
          'Each type of meeting has a public booking page, with times shown in the client’s time zone',
          'Team meeting types: round robin for whoever is free, or only the times when the whole team is free',
          'Working hours and days off for each person; public holidays and Tet are built in through 2028',
          'A confirmation email with a calendar file, reminders 24 hours and 1 hour before, and a single-use link for the client to reschedule or cancel. It needs a mail server that the installer has configured',
          'A client who books is matched to a contact or created as one, and it lands on the timeline',
        ],
      },
      {
        id: 'calendar-and-vy',
        title: 'Google Calendar and Vy',
        lead: 'Connect your calendar so busy times are never double booked.',
        points: [
          'Connect Google Calendar: busy times block bookings, and only times are read, never titles. It needs Google keys that the installer has configured',
          'You can turn on writing new bookings to Google Calendar; the title holds the meeting type and the client’s name',
          'A subscription address to see your bookings in Google Calendar, Outlook or Apple Calendar',
          'Vy reads a client’s message, picks real free times and drafts a reply with the booking link. You read it and send it yourself. It needs an AI model that the installer has configured',
        ],
      },
    ],
  },
  assistant: {
    title: 'What Vy does in Ludy CRM',
    lead: 'Vy helps with scheduling. The contact list and the deals are yours to manage.',
    doesTitle: 'Vy does',
    does: [
      'Suggests meeting times from a client’s message and drafts the reply',
      'When a client cancels, the scheduler agent (if you hire it) writes the 3 nearest free times into a task for the person in charge',
    ],
    doesNotTitle: 'Vy does not',
    doesNot: ['Book a meeting or send an email on its own', 'Write to the contact list or the deals'],
  },
  audience: {
    title: 'Who Ludy CRM is for',
    lead: 'For people who sell and take appointments with clients.',
    items: [
      {
        title: 'Solo founders and small businesses',
        body: 'Customers, deals and bookings in one place, instead of spreadsheets and scattered messages.',
      },
      {
        title: 'Accountants and accounting firms',
        body: 'A customer here is also a customer in Ludy Accounting, so invoices and contacts share one list.',
      },
      {
        title: 'People who self-host',
        body: 'Open source under the AGPL, and the data stays on your server. You need a mail server to send confirmation emails.',
      },
    ],
  },
  faq: {
    title: 'Questions about Ludy CRM',
    items: [
      {
        q: 'Is Ludy CRM as complete as a big CRM?',
        a: 'Not yet. Ludy CRM has contacts, deals, a board by stage and bookings. It has no email capture, no sales forecast and no automated email sequences.',
      },
      {
        q: 'Do my customers from Ludy Accounting show up in the CRM?',
        a: 'Yes. A contact is the same party the invoices use, so the customers and vendors you already have appear in the contact list.',
      },
      {
        q: 'Does importing contacts overwrite what I already have?',
        a: 'No. A duplicate row is skipped or only fills empty fields. You preview every row before importing, and an import cannot be undone.',
      },
      {
        q: 'Do I need Google Calendar?',
        a: 'No. The booking page works without Google. Connecting Google Calendar only blocks your busy times, and it needs Google keys that the installer has configured.',
      },
      {
        q: 'Does Ludy email confirmations to clients?',
        a: 'Yes, once the installer has configured a mail server. Without one, Ludy sends no email.',
      },
    ],
  },
  cta: {
    title: 'Try Ludy CRM with your own customers',
    body: 'Self-host for free with a single docker compose command. If you already have an account, sign in.',
    primary: 'See how to self-host',
    secondary: 'Sign in',
  },
  fragments: {
    sample: 'Example data',
    board: {
      label: 'The deal board by stage for Gạo Sạch Mekong',
      closeOn: 'Expected close',
      cards: 'deals',
      empty: 'No deals',
      stages: [
        { name: 'New', tone: 'neutral', sum: '₫18,000,000', deals: [{ title: 'Fragrant rice for a restaurant', party: 'Nhà hàng Sen Vàng', amount: '₫18,000,000', close: '30/11/2026' }] },
        {
          name: 'Contacted',
          tone: 'neutral',
          sum: '₫292,000,000',
          deals: [
            { title: 'ST25 rice, 100 tonnes', party: 'Đại lý Phương Nam', amount: '₫250,000,000', close: '15/11/2026' },
            { title: 'Weekly rice delivery', party: 'Cửa hàng Bình An', amount: '₫42,000,000', close: '20/11/2026' },
          ],
        },
        { name: 'Quote sent', tone: 'neutral', sum: '₫120,000,000', deals: [{ title: 'Wholesale rice, winter crop', party: 'Gạo Sạch Miền Tây', amount: '₫120,000,000', close: '10/11/2026' }] },
        { name: 'Negotiation', tone: 'neutral', sum: '₫480,000,000', deals: [{ title: 'Q4 supply contract', party: 'Hợp tác xã Tân Hồng', amount: '₫480,000,000', close: '05/11/2026' }] },
        { name: 'Won', tone: 'ok', sum: '₫96,000,000', deals: [{ title: 'ST25 rice, October batch', party: 'Đại lý Phương Nam', amount: '₫96,000,000', close: '12/10/2026' }] },
        { name: 'Lost', tone: 'neutral', sum: '₫0', deals: [] },
      ],
    },
    import: {
      title: 'Import contacts from a file',
      file: 'khach-hang.xlsx',
      steps: ['Choose a file', 'Map columns', 'Preview', 'Done'],
      current: 2,
      hint: 'Nothing has been written to the contact list yet. Look it over, then press Import.',
      counts: [
        { label: '2 new rows', tone: 'ok' },
        { label: '1 duplicate row', tone: 'warn' },
        { label: '1 invalid row', tone: 'warn' },
      ],
      head: ['Row', 'Name', 'Result'],
      rows: [
        { n: '2', name: 'Nhà hàng Sen Vàng', result: 'New', tone: 'ok', note: '' },
        { n: '3', name: 'Cửa hàng Bình An', result: 'New', tone: 'ok', note: '' },
        { n: '4', name: 'Hợp tác xã Tân Hồng', result: 'Duplicate', tone: 'warn', note: 'Same tax code' },
        { n: '5', name: 'Đại lý Phương Nam', result: 'Invalid', tone: 'warn', note: 'Invalid email' },
      ],
      choiceLabel: 'A row that matches an existing contact:',
      choice: 'Skip it and keep the existing contact',
      button: 'Import 2 new contacts',
    },
    pipeline: {
      title: 'The stages of the sales pipeline',
      hint: 'Won and Lost always come last and cannot be deleted.',
      stageLabel: 'Stage',
      stages: ['New', 'Contacted', 'Quote sent', 'Negotiation'],
      won: 'Won stage: Won',
      lost: 'Lost stage: Lost',
      viewsLabel: 'Saved views',
      views: [
        { name: 'Mine', shared: false },
        { name: 'In negotiation', shared: true },
      ],
      private: 'Private',
      shared: 'Shared',
      filtersLabel: 'Filter deals',
      filters: ['Open', 'Me', 'Due soon (next 7 days)'],
    },
  },
};
