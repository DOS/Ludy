// SPDX-License-Identifier: AGPL-3.0-only
// English copy of the Ludy Accounting page (/en/accounting), in the shape of accounting-vi.ts. The example company, its
// vendors, people, amounts and document numbers are the home page's and stay as they are in Vietnamese.
import type { AccountingCopy } from './accounting-vi';

export const accountingEn: AccountingCopy = {
  appName: 'Ludy Accounting',
  meta: {
    title: 'Ludy Accounting: invoices in, Ludy drafts the entry, you approve before anything posts',
    description:
      'Ludy Accounting reads e-invoices, checks every number with fixed rules and proposes a journal entry under Circular 133. VAT, a tax calendar, period locks, year-end closing and Excel exports in the MISA SME import layouts are included. Open source, and nothing posts until a person approves.',
  },
  ogTitle: 'Invoices in, Ludy drafts the entry. You approve before anything posts.',
  crumbLabel: 'Breadcrumb',
  hero: {
    title: 'Invoices in, Ludy drafts the entry. You approve before anything posts.',
    lead: 'Ludy Accounting reads e-invoices, checks every number with fixed rules and proposes a journal entry under Circular 133. An entry reaches the books only when a person with the authority approves it with a two-factor code.',
    primary: 'Self-host for free',
    secondary: 'Sign in',
    note: 'Open source under the AGPL. Ludy Accounting is in the self-hosted edition. On Ludy Cloud: coming soon.',
  },
  how: {
    title: 'Four steps from the inbox to the ledger',
    lead: 'Ludy does the first three steps and records each one. The last step is always approved by a person with the authority, with a two-factor code.',
    steps: [
      { name: 'Receive', body: 'Upload, or forward an email. XML is read directly; PDFs and photos are read by Vy.', outcome: 'Received', tone: 'neutral' },
      { name: 'Check', body: 'Fixed rules compare the totals, the VAT, the tax code and duplicates. An error in the totals stops the invoice.', outcome: 'Passed or held', tone: 'ok' },
      { name: 'Propose', body: 'A TT133 entry lands in the inbox of documents to approve, with the reason for the accounts. Nothing is posted yet.', outcome: 'Proposed, not posted', tone: 'accent' },
      { name: 'Approve', body: 'The approver looks, changes an account if needed and enters the two-factor code. Only then does the entry reach the books.', outcome: 'Posted', tone: 'ok' },
    ],
  },
  groups: {
    title: 'What Ludy Accounting does today',
    lead: 'Grouped by the job you have, from the moment an invoice arrives to closing the year.',
    items: [
      {
        id: 'receive-and-check',
        title: 'Receive and check documents',
        lead: 'Invoices come in by upload or by forwarded email. The checks are fixed rules, not AI, and when something does not add up the invoice stops and waits for a person.',
        points: [
          'E-invoice XML under Decree 254/2026 and Circular 91/2026, and invoices under Decree 123/2020, is read directly from its XML structure, with no AI',
          'PDFs and photos are read by an OpenAI-compatible model the person installing Ludy configures. A PDF that holds only a scanned image cannot be read yet',
          'Upload single files or a whole ZIP. Forwarding an email to the company’s own invoice address works too, once the installer has connected a mail domain to Ludy',
          'The checks cover line totals, the grand total, the VAT table, the invoice date and duplicates. XML invoices are also checked for the digital signature and the tax-authority code. The check digit of the tax code is looked at too',
          'A mismatch in the totals blocks approval outright. Other failed checks, or a digital signature that could not be verified, can be approved only after the approver confirms they compared the invoice with the original. A tax code with a wrong check digit or a missing tax-authority code is only a warning',
        ],
      },
      {
        id: 'post-with-control',
        title: 'Draft entries and post with control',
        lead: 'Ludy proposes a debit and credit entry under Circular 133 and says why it chose the accounts. Until someone with the authority approves it, it is only a proposal.',
        points: [
          'Approving an entry needs a fresh two-factor code, no older than 5 minutes. Every decision lands in a change log that cannot be edited or deleted through the app',
          'The account is remembered per vendor and item, with who approved it, when, and the document it came from',
          'A line that matches no rule is marked unclassified. Ludy does not post until a person picks the account, and it does not guess quietly',
          'When a replacement invoice is approved, the original is voided and its entry reversed. An adjustment invoice is linked to the original',
          'A posted ledger cannot be edited or deleted. A mistake is fixed with a reversing entry',
        ],
      },
      {
        id: 'tax',
        title: 'VAT and the tax calendar',
        lead: 'Ludy works out VAT from the books, shows what to look at before you file, and reminds you client by client.',
        points: [
          'Input and output VAT by month or by quarter, as the company files',
          'An XML file of the 01/GTGT return. Ludy fills the indicators it can compute from the books; the tax office, the signer and some indicators are left for you to finish. Whether HTKK and eTax accept the file is still being checked with a partner accountant',
          'Missing numbers in the sales invoice series are shown before you file. Only invoices already in the books count',
          'An owner, an admin or a chief accountant marks the return as filed. That is a record in Ludy; Ludy does not file with the tax portal for you',
          'A tax calendar for each client and each legal entity: due dates and done marks. The table of due dates has not been confirmed by an accountant yet, and the screen in the app says so',
          'Missing purchase invoices: upload the list exported from the tax portal, Ludy compares it with the books and emails the client to ask for them, once the installer has configured a mail server',
        ],
      },
      {
        id: 'books',
        title: 'Books, period locks and exports',
        lead: 'The general journal, the ledger and the reports come from one source. At period end you lock the books so nobody posts more; at year end you close and keep the package.',
        points: [
          'The general journal, the ledger, cash vouchers, fixed assets with monthly depreciation, and opening balances imported from Excel',
          'Import bank statements from an Excel file or a CSV file, or send them by email; a member confirms the lines before they reach the books. A direct bank connection is not available yet',
          'Months lock one at a time, in order. Unlocking starts from the last locked month and needs an owner or a chief accountant, a two-factor code and a written reason',
          'At year end: revenue and expenses move to 911, then the result to 4212, as one proposed entry that needs approval with a two-factor code. After it is approved and all 12 months are locked, an owner builds the financial-year archive with the original files of the documents',
          'Excel export in the MISA SME import layouts for service purchases, goods purchases, sales, receipts and payments; the vendor and customer codes are left for the accountant to fill in, while item and warehouse codes are set in Settings. Importing into a real MISA is still being checked with a partner accountant',
          'The B01-DNN and B02-DNN statements are drafts: their account mapping has not been checked by an accountant. Each legal entity has its own books, document numbers, period locks and returns, on the Circular 133 chart of accounts',
          'Search by name, tax code, invoice number or amount, typed without diacritics',
        ],
      },
    ],
  },
  soon: {
    title: 'Coming soon',
    lead: 'The two items below have not run against the real tax portal or a real bank, so Ludy does not count them as available.',
    label: 'Coming soon',
    items: [
      { title: 'Pull the invoice list from the tax portal', body: 'Today you upload the Excel file exported from the portal, and Ludy compares it with the books.' },
      { title: 'A direct bank connection', body: 'Today statements are imported from an Excel file, a CSV file or an email.' },
    ],
  },
  assistant: {
    title: 'What Vy does in Ludy Accounting',
    lead: 'Vy is the AI assistant of Ludy. In accounting Vy does the reading; whether a number is right is decided by fixed rules and by people.',
    doesTitle: 'Vy does',
    does: [
      'Reads PDF and photo invoices into structured data',
      'Puts the result in the inbox of documents to approve, marked as read by AI and needing a person’s check',
      'An owner presses "Stop AI", with a two-factor code, to switch off all AI work of the company; new PDF and photo reads wait until it is turned back on',
    ],
    doesNotTitle: 'Vy does not',
    doesNot: [
      'Post to the books or approve in place of a person',
      'Decide whether an invoice is right: fixed rules do that',
      'Pick the account for an unclassified line',
    ],
  },
  audience: {
    title: 'Who Ludy Accounting is for',
    lead: 'One set of data, three ways to use it.',
    items: [
      {
        title: 'Solo founders and small businesses',
        body: 'No accounting knowledge needed. Upload a photo of an invoice, or forward the email once the company has an invoice address, look at the vendor and the amount, and approve. Wherever information is missing, Ludy points it out.',
      },
      {
        title: 'Accountants and accounting firms',
        body: 'Approve a month of documents from the keyboard. See many clients in one place, each with its own tax calendar. Invite an outside accountant to work on the legal entities you assign. Export Excel and files in the MISA SME import layouts.',
      },
      {
        title: 'People who self-host',
        body: 'Open source under the AGPL, runs with docker compose, and the data stays on your server. Choose any AI model, including one running on your own machine.',
      },
    ],
  },
  faq: {
    title: 'Questions about Ludy Accounting',
    items: [
      {
        q: 'Can I use it without knowing accounting?',
        a: 'Yes. Ludy drafts the entry and says why it chose those accounts. You look at the vendor, the amount and the checks, and approve. If someone does your books, invite them into the same company or send them the journal and ledger as Excel.',
      },
      {
        q: 'Does Ludy file my tax returns?',
        a: 'No. Ludy exports an XML file of the 01/GTGT return with the indicators it can compute from the books; you finish and file it with the tax authority’s tools. Whether HTKK and eTax accept the file is still being checked with a partner accountant. Marking a return as filed in Ludy is only a record.',
      },
      {
        q: 'Does Ludy issue sales invoices, run payroll or manage stock?',
        a: 'Not yet. Ludy reads and records invoices and shows gaps in the number series, but issuing e-invoices is still done in your invoicing software. There is no payroll, stock card or cash-flow statement yet.',
      },
      {
        q: 'How does data get into MISA?',
        a: 'Ludy exports Excel files in the MISA SME import layouts, with the catalogue columns left for you to fill. Importing into a real MISA is still being checked with a partner accountant, and there is no direct connection to MISA yet.',
      },
      {
        q: 'Where does my data live?',
        a: 'With a self-hosted install, your data stays on your own server and storage. Each company’s data is kept apart. You can export the journal, the ledger and Excel files at any time; all of a company’s data is exported when the organization is closed.',
      },
    ],
  },
  cta: {
    title: 'Try Ludy Accounting on your own invoices',
    body: 'Self-host for free with a single docker compose command. If you already have an account, sign in.',
    primary: 'See how to self-host',
    secondary: 'Sign in',
  },
  fragments: {
    sample: 'Example data',
    hero: {
      label: 'A purchase invoice is read, checked and drafted into a proposed entry',
      invoiceTitle: 'Invoice as read',
      checksTitle: 'Checked by rules',
      entryTitle: 'Proposed entry, TT133',
      proposal: 'Proposed',
      learned: 'By a learned rule: the same item from this vendor',
      approveNote: 'Enter the two-factor code to post',
    },
    intake: {
      title: 'Documents to approve',
      sub: 'Gạo Sạch Mekong',
      sourcesLabel: 'Documents arrive by',
      sources: [
        { label: 'Upload', body: 'XML, PDF, photo or ZIP file' },
        { label: 'Invoice email', body: 'Forward to the company’s own receiving address' },
      ],
      held: {
        party: 'Hợp tác xã Tân Hồng',
        sub: 'Rice purchase slip',
        amount: '₫148,500,000',
        state: 'Held, cannot be approved yet',
        failed: 'Line totals do not match the goods total',
        passed: 'Passed: VAT table, tax code, no duplicate',
      },
    },
    posting: {
      ruleTitle: 'Learned rule',
      ruleHead: ['Vendor', 'Item', 'Account'],
      rule: { party: 'Bao Bì Phú Thịnh', item: '5-ply cartons', account: '152', by: 'Approved by Chị Lan at 16:05 on 14/10/2026' },
      unclassifiedTitle: 'Unclassified line',
      unclassified: { item: 'Other service fee', amount: '1,200,000', state: 'Pick an account before posting' },
      replaceTitle: 'Replacement invoice',
      replaceFrom: { name: 'Invoice 00001284', state: 'Voided, its entry reversed' },
      replaceTo: { name: 'Invoice 00001301', state: 'Replaces invoice 00001284' },
    },
    tax: {
      calendarTitle: 'Tax calendar',
      calendarSub: 'Gạo Sạch Mekong',
      calendar: [
        { name: 'Provisional corporate income tax, Q3/2026', due: '30/10/2026', note: '', state: 'Not marked', tone: 'neutral' },
        { name: 'VAT return, Q3/2026', due: '02/11/2026', note: '31/10 is a Saturday', state: 'Not marked', tone: 'neutral' },
        { name: 'VAT return, Q2/2026', due: '31/07/2026', note: '', state: 'Filed', tone: 'ok' },
      ],
      dueLabel: 'Due',
      calendarNote: 'The table of due dates has not been confirmed by an accountant yet.',
      returnTitle: '01/GTGT return, Q4/2026',
      returnFile: 'Export an XML file of the return',
      returnNote: 'Ludy fills the indicators it can compute. The tax office, the signer and some indicators are left for you to finish.',
      mailTitle: 'Email asking for missing invoices',
      mailSub: 'Drafted from the tax portal list you upload',
      mailSubject: 'Purchase invoices missing for September 2026',
      mailBody: 'The tax portal list shows 2 purchase invoices that are not in the books yet. Please send a copy of these invoices:',
      mailRows: [
        ['Công ty CP Bao Bì Phú Thịnh, invoice 00001297', '₫4,320,000'],
        ['EVN, electricity bill for September', '₫1,946,780'],
      ],
    },
    books: {
      closeTitle: 'Year end 2025',
      closeSub: 'Gạo Sạch Mekong',
      close: [
        { name: 'Close to 911 and 4212', state: 'Approved with a two-factor code', tone: 'ok' },
        { name: 'Lock all 12 months', state: 'Locked', tone: 'ok' },
        { name: 'Financial-year archive', state: 'Built by an owner, with the original files', tone: 'neutral' },
      ],
      exportsTitle: 'Export files',
      exports: [
        { name: 'MISA SME import layouts', body: 'Service purchases, goods purchases, sales, receipts, payments', format: 'Excel' },
        { name: 'General journal, ledger', body: 'For the period and legal entity chosen', format: 'Excel' },
        { name: '01/GTGT return', body: 'XML file of the indicators Ludy can compute', format: 'XML' },
        { name: 'Fixed assets', body: 'Asset register and depreciation', format: 'Excel' },
      ],
      draftNote: 'B01-DNN and B02-DNN are drafts.',
    },
  },
};
