// SPDX-License-Identifier: AGPL-3.0-only
// English copy of the Ludy Engage page (/engage), in the shape of engage-vi.ts. The example company, its customers,
// people, amounts and dates are the home page's and stay as they are in Vietnamese where they are names.
import type { EngageCopy } from './engage-vi';
import { N } from './roster';

export const engageEn: EngageCopy = {
  appName: 'Ludy Engage',
  meta: {
    title: 'Ludy Engage: inbox, customers, sales and marketing in one app',
    description:
      'Ludy Engage brings a shared inbox for customers, your customer list and sales deals, bookings, posts and ads into one place, with a report for each part. Open source, and it shares its customer list with Ludy Accounting.',
  },
  ogTitle: 'Inbox, customers and marketing, in one app.',
  crumbLabel: 'Breadcrumb',
  hero: {
    title: 'Inbox, customers and marketing, in one app.',
    lead: `Ludy Engage brings your customers' messages, your customer list and sales deals, bookings, posts and ads into one place, each with its own report. ${N.sales} works the inbox, customers and sales, ${N.marketing} runs marketing, you approve.`,
    primary: 'Self-host for free',
    secondary: 'Sign in',
    note: 'Open source, AGPL. Ludy Engage is in the self-hosted edition. On Ludy Cloud: coming soon.',
  },
  how: {
    title: 'From a customer message to your report',
    lead: 'Four groups in the app menu, in the order the work usually happens.',
    steps: [
      { name: 'Receive', body: 'A customer message lands in the Inbox with a draft reply for you to review.', outcome: 'In the Inbox', tone: 'accent' },
      { name: 'Record the customer', body: 'Link the conversation to a contact, open a deal, or let the customer book a time.', outcome: 'In the customer list', tone: 'neutral' },
      { name: 'Close', body: 'Drag the deal through its stages until Won or Lost.', outcome: 'Won or Lost', tone: 'ok' },
      { name: 'Post and measure', body: 'Schedule posts for many channels, follow your ads, then read the numbers in Reports.', outcome: 'Numbers in Reports', tone: 'ok' },
    ],
  },
  groups: {
    title: 'What Ludy Engage does today',
    lead: 'Five jobs, in the four groups of the menu: Inbox, Customers & Sales, Marketing and Reports.',
    items: [
      {
        id: 'inbox',
        title: 'Inbox',
        lead: 'One shared inbox for your customers\' private messages. Comments are only on the demo channel for now.',
        points: [
          'Three tabs, New, Pending and Done; filter by kind, channel, owner and the customer\'s intent; search without typing accents',
          'The channel you can connect today is Zalo OA private messages, answered within Zalo\'s 48-hour window: built, not yet tried with a real OA. The installer registers the Zalo app first. A demo channel, with comments and messages, lets you try it on your own machine',
          'Assign an owner, keep internal notes, saved replies, and a "someone is replying" marker so two people do not answer twice',
          'Link a conversation to a contact or create one, see the same customer\'s other conversations, and erase a customer\'s data (owners and admins)',
          'Private messages are readable only by owners, admins and people with the Customer support role',
        ],
      },
      {
        id: 'customers',
        title: 'Customers and sales deals',
        lead: 'One contact list shared with Ludy Accounting, and deals by stages you set.',
        points: [
          'A contact is a person or a company, the same party the invoices in Ludy Accounting use; search by name, email, phone or tax code, without typing accents',
          'Import from an Excel (.xlsx) or CSV file: preview every row as new, duplicate or invalid before anything is written, and nothing already there is overwritten. An import cannot be undone',
          'Each deal has a customer, an amount in dong, an owner, an expected close date and a reason when lost',
          'A drag-and-drop board by stage, each column with its card count and total. Owners and admins name, add, remove and reorder the stages',
          'Filter by status, owner, close date and amount, then save the filter as a private or shared view',
        ],
      },
      {
        id: 'bookings',
        title: 'Bookings for customers',
        lead: 'Customers pick a free time on a public booking page, no account needed.',
        points: [
          'Each appointment type has its own booking page, with times in the customer\'s time zone; team types rotate between whoever is free, or show only the times the whole team is free',
          'Each person\'s working hours and days off; public holidays and Tet on their usual dates are built in through 2028, and you add compensatory days',
          'A confirmation email with a calendar file, reminders 24 hours and 1 hour before, and a one-time link for the customer to move or cancel. Needs a mail server the installer sets up',
          'Connect Google Calendar: busy times block bookings, and only the times are read, never the titles; new bookings can be written to Google Calendar. Needs a Google key the installer sets up',
          'A customer who books is matched to or created as a contact, and the booking goes on the contact\'s timeline',
        ],
      },
      {
        id: 'marketing',
        title: 'Marketing: posts and ads',
        lead: 'Schedule posts for many channels and watch your ads in one place, and every post goes through a person.',
        points: [
          'A post has one text and a variant for each channel, checked per channel, with a preview, and a calendar, board or list of what is coming',
          'Channels include Facebook, Instagram, Threads, TikTok, YouTube, LinkedIn, X, Zalo OA and many more. For the large platforms the installer registers that platform\'s app first',
          'Every post needs a person\'s approval before it goes out, with multi-step review, checklists and a review link clients can use without signing in',
          'Reports for clients as a shareable link, a printout, with your own branding, and they can be scheduled',
          'Ads: see spend, impressions, clicks and results of Facebook and Instagram ads by day, month and campaign, and compare spend with the books when you use Ludy Accounting. Needs a Meta key the installer sets up',
        ],
      },
      {
        id: 'reports',
        title: 'Reports',
        lead: 'The numbers of each part you use, in one place.',
        points: [
          'One tab for each part that is running: Conversations, Sales, Posts and Ads',
          'Conversations: how many are new, pending, done and unread',
          'Sales: the deals that are open, and those won or lost in the last 30 days, by stage, with totals',
          'Posts: posts, reach, reactions, comments and shares of the last 30 days against the 30 before',
          'Ads: this month\'s spend, impressions, clicks and results for each account, in the account\'s own currency with no conversion. Reports are read-only, and each part links to its own screen',
        ],
      },
    ],
  },
  soon: {
    title: 'Coming soon',
    lead: 'Not usable today.',
    label: 'Coming soon',
    items: [
      { title: 'Facebook and Instagram in the Inbox', body: 'Comments and private messages, and replying privately to a comment.' },
      { title: 'Customer email in the Inbox', body: 'Customers\' email in the same inbox as the other channels.' },
      { title: 'Running ads from Ludy', body: 'Today Ludy shows your ads. Creating and running campaigns, with spend caps, a stop switch and every spend approved by you: coming soon.' },
    ],
  },
  coworker: {
    title: `What ${N.sales} and ${N.marketing} do in Ludy Engage`,
    lead: `${N.sales} is the AI sales lead, working the inbox, customers and sales. ${N.marketing} is the AI marketing lead, working the posts. Both are your coworkers, under ${N.gm}'s coordination. They need an AI model the installer sets up; an owner or admin can stop the AI, and the monthly AI budget caps the cost.`,
    doesTitle: 'Does',
    does: [
      `${N.sales} drafts replies in the Inbox without inventing prices or links, and suggests the customer's intent and a matching contact`,
      `${N.sales} reads a message you paste into the Bookings screen, picks real free times and drafts a reply with a booking link`,
      `${N.marketing} drafts and rewrites posts, suggests hashtags, image descriptions, new post ideas and a summary of a period`,
    ],
    doesNotTitle: 'Does not',
    doesNot: [
      'Never sends a reply to a customer, books a time or sends a mail by itself',
      'Never publishes a post by itself: every post needs a person\'s approval',
      'Never runs ads or spends money, and never writes to the contact list or the deals',
    ],
  },
  audience: {
    title: 'Who Ludy Engage is for',
    lead: 'For whoever answers customers, sells and does the marketing.',
    items: [
      {
        title: 'One-person businesses and small businesses',
        body: 'Customer messages, the customer list, bookings and posts in one place, instead of spreadsheets and scattered chats.',
      },
      {
        title: 'Accountants and accounting services',
        body: 'The customers here are also the customers in Ludy Accounting, so invoices and contacts share one list.',
      },
      {
        title: 'People who self-host',
        body: 'Open source, AGPL, with your data on your own server. You need a mail server to send confirmation emails, and each platform\'s app to connect its channel.',
      },
    ],
  },
  faq: {
    title: 'Questions about Ludy Engage',
    items: [
      {
        q: 'What happened to Ludy CRM?',
        a: 'Ludy CRM has folded into Ludy Engage. Contacts, deals and bookings are in the Customers & Sales group, and the old address of the Ludy CRM page now leads here.',
      },
      {
        q: 'Which channels does the Inbox receive from?',
        a: 'Today it is Zalo OA private messages (built, not yet tried with a real OA), and the installer has to register the Zalo app first. A demo channel, with comments and messages, lets you try it on your own machine. Facebook, Instagram and email: coming soon.',
      },
      {
        q: 'Does Ludy answer customers or publish posts by itself?',
        a: `No. ${N.sales} only drafts a reply for you to read, edit and send, and every post needs a person's approval. The core keeps working with AI switched off.`,
      },
      {
        q: 'Can I run ads from Ludy yet?',
        a: 'Not yet. Today Ludy shows your Facebook and Instagram ads. Creating and running campaigns: coming soon.',
      },
      {
        q: 'Do the customers in Ludy Accounting show up in Ludy Engage?',
        a: 'Yes. A contact is the same party the invoices use, so the customers and vendors you already have appear in the contact list.',
      },
    ],
  },
  cta: {
    title: 'Try Ludy Engage with your customers',
    body: 'Self-host for free with a single docker compose command. Already have an account? Sign in.',
    primary: 'See how to self-host',
    secondary: 'Sign in',
  },
  fragments: {
    sample: 'Example data',
    menu: {
      label: 'The Ludy Engage menu',
      groups: [
        { name: 'Inbox', items: ['Conversations'] },
        { name: 'Customers & Sales', items: ['Contacts', 'Deals', 'Bookings'] },
        { name: 'Marketing', items: ['Posts', 'Ads'] },
        { name: 'Reports', items: ['Reports'] },
      ],
    },
    inbox: {
      label: 'The inbox of Gạo Sạch Mekong',
      tabs: ['New', 'Pending', 'Done'],
      channel: 'Zalo OA',
      intentLabel: 'Suggested',
      rows: [
        { who: 'Nhà hàng Sen Vàng', preview: 'Asks the price of ST25 rice, 10 tonnes', state: 'New', tone: 'accent', intent: 'Order or price' },
        { who: 'Cửa hàng Bình An', preview: 'Wants to see the goods at the warehouse, what time?', state: 'Pending', tone: 'neutral', intent: 'Question' },
        { who: 'Đại lý Phương Nam', preview: 'Thanks, goods received', state: 'Done', tone: 'ok', intent: '' },
      ],
    },
    board: {
      label: 'The deal board by stage of Gạo Sạch Mekong',
      closeOn: 'Expected close',
      cards: 'deals',
      empty: 'No deals',
      stages: [
        { name: 'New', tone: 'neutral', sum: '18,000,000 ₫', deals: [{ title: 'Fragrant rice for a restaurant', party: 'Nhà hàng Sen Vàng', amount: '18,000,000 ₫', close: '30/11/2026' }] },
        {
          name: 'Contacted',
          tone: 'neutral',
          sum: '292,000,000 ₫',
          deals: [
            { title: 'ST25 rice, 10 tonnes', party: 'Đại lý Phương Nam', amount: '250,000,000 ₫', close: '15/11/2026' },
            { title: 'Weekly rice delivery', party: 'Cửa hàng Bình An', amount: '42,000,000 ₫', close: '20/11/2026' },
          ],
        },
        { name: 'Quoted', tone: 'neutral', sum: '120,000,000 ₫', deals: [{ title: 'Winter-crop wholesale rice', party: 'Cửa hàng Hoa Mai', amount: '120,000,000 ₫', close: '10/11/2026' }] },
        { name: 'Negotiating', tone: 'neutral', sum: '480,000,000 ₫', deals: [{ title: 'Q4 supply contract', party: 'Công ty Thực phẩm An Phát', amount: '480,000,000 ₫', close: '05/11/2026' }] },
        { name: 'Won', tone: 'ok', sum: '96,000,000 ₫', deals: [{ title: 'ST25 rice, October batch', party: 'Đại lý Phương Nam', amount: '96,000,000 ₫', close: '12/10/2026' }] },
        { name: 'Lost', tone: 'neutral', sum: '0 ₫', deals: [] },
      ],
    },
    posts: {
      label: 'The posting calendar of Gạo Sạch Mekong',
      approval: 'Every post needs a person\'s approval before it goes out',
    },
    reports: {
      label: 'The reports of Gạo Sạch Mekong',
      tabs: ['Conversations', 'Sales', 'Posts', 'Ads'],
      current: 1,
      title: 'Sales: deals by stage',
      head: ['Stage', 'Deals', 'Total'],
      rows: [
        { stage: 'New', count: '1', sum: '18,000,000 ₫' },
        { stage: 'Contacted', count: '2', sum: '292,000,000 ₫' },
        { stage: 'Quoted', count: '1', sum: '120,000,000 ₫' },
        { stage: 'Negotiating', count: '1', sum: '480,000,000 ₫' },
      ],
      openLabel: 'Open',
      open: '5 deals, 910,000,000 ₫',
      wonLabel: 'Won in the last 30 days',
      won: '1 deal, 96,000,000 ₫',
      readOnly: 'Read-only. Open the Deals screen to edit.',
    },
  },
};
