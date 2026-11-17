// SPDX-License-Identifier: AGPL-3.0-only
// English copy of the Ludy HR page (/nhan-su), in the shape of hrm-vi.ts. The sample company name (Gạo Sạch Mekong)
// stays Vietnamese as listed in test/vietnamese.ts; all other strings use English without Vietnamese diacritics.
import type { HrmCopy } from './hrm-vi';
import { N } from './roster';

export const hrmEn: HrmCopy = {
  appName: 'Ludy HR',
  meta: {
    title: 'Ludy HR: employee records, timekeeping, payroll and lightweight recruiting for small teams',
    description:
      'Ludy HR brings together per-person encrypted employee records, optional departments, labor contracts, timekeeping and annual leave, monthly payroll, declaration sheets and lightweight recruiting for small teams. Your AI coworker flags changes on pseudonymized figures; people decide. Open source AGPL.',
  },
  ogTitle: 'Employee records, timekeeping, payroll and recruiting in one place.',
  crumbLabel: 'Breadcrumb',
  hero: {
    title: 'Employee records, timekeeping, payroll and recruiting in one place.',
    lead: `Ludy HR keeps individual salaries restricted to owners and admins, calculates monthly pay with fixed rules and lets your AI coworker ${N.finance} flag changes on pseudonymized figures before handing aggregate entries to Ludy Finance.`,
    primary: 'Self-host for free',
    secondary: 'Sign in',
    note: 'Open source under the AGPL. Ludy HR is in the self-hosted edition. On Ludy Cloud: coming soon.',
  },
  how: {
    title: 'Four steps from employee records to monthly payroll',
    lead: 'Ready out of the box for teams of 3 to 30 people, with no org-chart setup required before adding your first employee.',
    steps: [
      {
        name: 'Records & contracts',
        body: 'Add employees, dependents and employment terms. National IDs, tax codes, social insurance numbers and bank accounts are encrypted under each person’s own key.',
        outcome: 'Sealed per person',
        tone: 'neutral',
      },
      {
        name: 'Timekeeping & leave',
        body: 'Paste rows from a spreadsheet or upload .csv, .tsv or .txt files to import unpaid leave, night work and overtime. Fixed rules warn over the 40-hour monthly overtime cap and accrue annual leave.',
        outcome: 'Hours checked',
        tone: 'ok',
      },
      {
        name: 'Calculate & review',
        body: `Fixed rules compute insurance, personal income tax and 13th-month pay; ${N.finance} flags pay swings on pseudonymized aliases for your review.`,
        outcome: 'Draft pay run',
        tone: 'accent',
      },
      {
        name: 'Declare & hand off',
        body: 'Export the Labor Management Register and 01/PLI report today; two-factor approval, bank files and aggregate accounting entries wait for partner accountant rule sign-off.',
        outcome: 'Individual pay stays private',
        tone: 'ok',
      },
    ],
  },
  groups: {
    title: 'What Ludy HR does today',
    lead: 'Four items in the HR menu restricted to owners and admins: Employees, Recruiting, Payroll (with the Bank salary templates tab) and Declarations.',
    items: [
      {
        id: 'employees-and-contracts',
        title: 'Employee records, lightweight departments and labor contracts',
        lead: 'Manage staff per legal entity, protect identity numbers with per-person encryption keys and track contract and probation limits under the 2019 Labor Code.',
        points: [
          'Per-person envelope encryption for national ID or passport numbers, personal tax codes, social insurance numbers and bank account numbers; stores zero ID card scans and supports Personal Data Protection Law (PDPL) key shredding after the 10-year accounting retention window',
          'Optional lightweight departments per legal entity with default expense roles (administration, sales, production) and job titles, never required before adding your first employee',
          'Append-only employment history so raises never rewrite past months: supports indefinite contracts, fixed-term contracts (1 to 36 months, tracking the 2-renewal statutory limit) or no written labor contract (10% flat PIT withholding), while rejecting abolished seasonal contracts',
          'Validates statutory probation caps by role tier (6 working days or 30, 60 or 180 calendar days), enforces the 85% probation wage floor and raises alerts before contracts expire or must convert to indefinite',
          'Exports the Labor Management Register and semiannual 01/PLI labor usage report as .xlsx or .json (carrying a clear draft notice while our partner accountant confirms the layout row)',
        ],
      },
      {
        id: 'timekeeping-and-leave',
        title: 'Lightweight timekeeping and automatic annual leave accrual',
        lead: 'Bring attendance into a pay run in seconds by pasting from a spreadsheet or editing hours straight on a draft line.',
        points: [
          'Paste directly from spreadsheets or upload .csv, .tsv or .txt files to batch-import unpaid leave days, days not employed, night-work hours and weekday, rest-day or holiday overtime hours with preview validation before applying; allowances and bonuses stay preserved or editable per line',
          'Checks the statutory 40-hour monthly overtime cap under the Labor Code on import, flags lines above the cap and requires explicit sign-off before approving the pay run',
          'Monthly leave ledger (opening balance, annual leave taken, paid personal leave and unpaid leave) with a one-click Sync leave button that pulls approved unpaid leave days into open draft pay runs',
          'Computes prorated annual leave entitlement by months worked plus 1 extra seniority day for every 5 years with the company',
        ],
      },
      {
        id: 'payroll-and-handoff',
        title: 'Monthly payroll, 13th-month bonus, severance and four-eyes handoff',
        lead: 'Every amount is computed with exact decimal arithmetic under fixed rules. Owners see per-person pay, while accountants only receive account-level totals.',
        points: [
          'Calculates gross pay, employee and employer shares across all 5 mandatory insurance funds (BHXH, BHYT, BHTN), trade union fees, dependent deductions, progressive or 10% flat PIT, net pay and per-person payslips',
          'Previews and applies 13th-month salary prorated by completed calendar months worked, alongside an Article 46 statutory severance calculator (0.5 month per qualifying year, excluding unemployment-insured months)',
          'Database-enforced salary isolation: only owners and admins can open Ludy HR, and every sensitive query writes an audit log entry before reading any figure',
          'Complete post-approval pipeline built in code (currently held behind a safety lock awaiting partner accountant confirmation of the statutory rule table): two-factor run freeze, per-bank .xlsx salary files with customizable Bank salary templates, D02-LT, 05/KK-TNCN, 05/QTT-TNCN and 03/TNCN workbooks, and four-eyes aggregate journal and payment voucher handoff to Ludy Finance (flagging cash net pay of ₫5,000,000 or above)',
        ],
      },
      {
        id: 'lightweight-recruiting',
        title: 'Lightweight recruiting from first note to one-click hire',
        lead: 'Track open roles and candidates right inside Ludy without paying for a separate applicant tracking system.',
        points: [
          'Create job openings with optional department, contract type, wage region and pay band, or add a candidate immediately even before creating an opening',
          'Clear 6-stage pipeline (Applied, Screening, Interview, Offer, Hired, Rejected) with validated stage transitions',
          'Ranks open interview slots against company working hours, Vietnam public holidays and busy calendar blocks; calendar event titles show only the role title, never candidate names or phone numbers',
          'One-click Hire creates the employee record and initial employment contract in a single transaction; owners can erase completed or rejected candidate records (wiping name, email, phone number and notes) under the PDPL',
        ],
      },
      {
        id: 'ai-coworker',
        title: `AI coworker ${N.finance} flags changes on pseudonymized figures`,
        lead: `${N.finance} is your AI CFO working across both Ludy Finance and Ludy HR. Every model call runs through your monthly AI budget and never receives real names or identity numbers.`,
        points: [
          'Before calling the model, the server replaces employee and candidate names with fresh random aliases (such as E1, E2 or C1) and blocks the request with a second-wall leak check if any real name, ID number, tax code, bank account, address or raw candidate wage appears',
          `${N.finance} highlights pay-run anomalies (net pay swings above 20% from last month, new hires, leavers and lines flagged over the overtime cap), explains individual payslips, checks missing fields before 01/PLI exports and drafts candidate screening briefs with interview questions`,
          'Every number in AI-written text is verified against stored figures before display; when AI is turned off, stopped via the kill switch or out of monthly budget, payroll, timekeeping, exports and recruiting keep working identically',
        ],
      },
    ],
  },
  soon: {
    title: 'Coming soon',
    lead: 'These three items await partner accountant rule sign-off, legal review or cross-app wiring, so Ludy keeps them clearly locked rather than overpromising.',
    label: 'Coming soon',
    items: [
      {
        title: 'Unlocking live pay-run approval and payroll voucher posting',
        body: 'The calculation engine, two-factor freeze, per-bank bulk salary .xlsx export, D02-LT / 05/KK-TNCN / 05/QTT-TNCN sheets and four-eyes aggregate handoff to Ludy Finance are built in code. Live approval stays safely locked until our partner accountant verifies each statutory insurance, tax and account-mapping row against primary legal texts.',
      },
      {
        title: 'Official HTKK tax XML export and payslip email delivery',
        body: 'Awaiting legal review on Personal Data Protection Law (PDPL) retention rules, HTKK XSD schema licensing and authenticated payslip delivery. Today payslips are viewed in the app and tax and insurance schedules export as .xlsx workbooks.',
      },
      {
        title: 'Direct labor contract handoff to Ludy eSign',
        body: 'One-step handoff from an employee’s employment contract into a Ludy eSign envelope, paired with renewal reminders ahead of contract expiry.',
      },
    ],
  },
  coworker: {
    title: `What ${N.finance} does in Ludy HR`,
    lead: `${N.finance} is the AI CFO, your coworker in Ludy HR and Ludy Finance, coordinated by ${N.gm}. ${N.finance} only reads deterministic flags and pseudonymized figures within your AI budget; fixed rules compute every amount and people make every decision.`,
    doesTitle: `${N.finance} does`,
    does: [
      'Flags net-pay swings over 20%, new hires, leavers and overtime caps, and explains payslip lines in plain words from pseudonymized amounts',
      'Checks missing compliance fields (missing ID or social insurance numbers, upcoming probation end dates, expiring contracts) before exporting the Labor Management Register or 01/PLI report',
      'Summarizes candidate readiness against opening requirements and suggests 3 to 5 tailored interview questions without receiving real names or raw salary numbers',
    ],
    doesNotTitle: `${N.finance} does not`,
    doesNot: [
      'Never calculates wages, insurance contributions or personal income tax: deterministic rules compute every figure',
      'Never receives employee or candidate names, national IDs, tax codes, bank account numbers or street addresses',
      'Never approves a pay run, posts a journal entry, exports a bank file or hires or rejects a candidate',
    ],
  },
  audience: {
    title: 'Who Ludy HR is for',
    lead: 'Built for small businesses in Vietnam that want clear labor compliance, strict salary privacy and clean accounting handoffs.',
    items: [
      {
        title: 'Small business owners with 3 to 30 staff',
        body: 'Keep employment contracts, annual leave, monthly pay sheets and hiring in the same workspace you run the company from, without exposing individual salaries to other team members.',
      },
      {
        title: 'Companies working with an in-house or outside accountant',
        body: 'Owners and admins manage per-person salaries in Ludy HR, while accountants in Ludy Finance review and approve only aggregate expense totals by account.',
      },
      {
        title: 'People who self-host',
        body: 'Open source under the AGPL, launched with a single docker compose command, keeping encrypted employee records on your own server and working in full even with AI off.',
      },
    ],
  },
  faq: {
    title: 'Questions about Ludy HR',
    items: [
      {
        q: 'Can our company accountant see individual employee salaries?',
        a: 'No, unless you also make that person an organization owner or admin. Members with the accountant role work in Ludy Finance and approve aggregate payroll entries grouped by expense account (administration, sales, production), with zero visibility into individual names or pay lines.',
      },
      {
        q: 'Why is live pay-run approval still locked behind a safety check today?',
        a: 'Ludy refuses to freeze or post tax and insurance figures until a licensed accountant has verified every statutory rule row against primary regulations. Today you can manage employees, departments, contracts, timekeeping, annual leave, recruiting, export the Labor Management Register and 01/PLI report, and run full draft monthly pay sheets; once our partner accountant signs off the rule table, two-factor approval, bank salary files and Ludy Finance posting unlock.',
      },
      {
        q: 'How are national IDs, bank accounts and candidate records protected?',
        a: 'National IDs, tax codes, social insurance numbers and bank account numbers are encrypted under each employee’s own key, with zero ID card images stored. Every sensitive read writes an audit entry first. Unhired candidates can be erased immediately under the PDPL, while ended employees support cryptographic key shredding after the 10-year accounting retention period.',
      },
      {
        q: 'Does Ludy initiate bank transfers or submit BHXH and tax filings automatically?',
        a: 'No. Ludy never moves money or submits filings on your behalf. Once live pay-run approval unlocks, it exports per-bank .xlsx salary files formatted to your saved column templates for e-banking upload, plus D02-LT, 05/KK-TNCN and 05/QTT-TNCN workbooks (alongside 01/PLI exported today) for you to review and file on official portals.',
      },
      {
        q: 'Does Ludy HR work in full when AI is turned off?',
        a: `Yes. Employee records, contract and probation checks, timekeeping imports, annual leave balances, payroll tax and insurance math, declaration exports and the recruiting pipeline all run on fixed deterministic rules. ${N.finance} is strictly optional when AI is enabled.`,
      },
    ],
  },
  cta: {
    title: 'Try Ludy HR with your team',
    body: 'Self-host for free with a single docker compose command. Already have an account? Sign in.',
    primary: 'See how to self-host',
    secondary: 'Sign in',
  },
  fragments: {
    sample: 'Example data',
    hero: {
      label: 'A draft October 2026 pay run in Ludy HR showing fixed-rule checks, pseudonymized AI notes and isolated accounting handoff',
      runTitle: 'October 2026 pay run',
      runState: 'Draft',
      roleBadge: 'Owners & Admins only',
      employeesCount: '12 employees · 26 standard days',
      rows: [
        { name: 'Nguyen Minh Duc', dept: 'Production · Indefinite contract', gross: '₫18,500,000', net: '₫16,557,500', tag: 'Overtime 18h / 40h', tone: 'ok' },
        { name: 'Tran Thi Mai', dept: 'Sales · 12-month contract (term 1)', gross: '₫15,200,000', net: '₫13,604,000', tag: '9 leave days left', tone: 'neutral' },
        { name: 'Le Hoang Nam', dept: 'Admin · 60-day probation', gross: '₫11,900,000', net: '₫10,710,000', tag: '85% base wage', tone: 'accent' },
      ],
      grossLabel: 'Total gross pay',
      grossTotal: '₫186,400,000',
      netLabel: 'Total net pay',
      netTotal: '₫167,120,000',
      lyTitle: `${N.finance} anomaly check (pseudonymized)`,
      lyBadge: 'Proposed',
      lyNote: 'Alias E1 overtime pay rose 24% vs 09/2026 while staying within the 40h/month cap. Alias E3 probation ends in 9 days.',
      privacyBadge: 'Zero real names, IDs or bank accounts sent to AI',
      handoffTitle: 'Handoff to Ludy Finance',
      handoffSub: 'Aggregate voucher by department, four-eyes approval',
      handoffLines: [
        ['Wages & employer insurance by department', '₫222,748,000'],
        ['Net wages payable (₫167,120,000), insurance & PIT (₫55,628,000)', '₫222,748,000'],
      ],
      gateNote: 'Live approval locked pending partner accountant rule sign-off',
    },
    records: {
      title: 'Per-person encryption & labor contract checks',
      sub: 'Gạo Sạch Mekong',
      sealedTitle: 'Fields encrypted under each employee’s own key',
      sealedFields: ['National ID / passport', 'Personal tax code', 'Social insurance number', 'Bank account number'],
      contractsTitle: 'Automatic contract & probation checks',
      alerts: [
        { person: 'Tran Thi Mai · Sales', detail: '12-month fixed-term contract (1 of 2), expires 30/11/2026', badge: 'Expiring soon', tone: 'warn' },
        { person: 'Le Hoang Nam · Admin', detail: 'College-tier probation max 60 calendar days, at 85% wage', badge: 'Labor Code pass', tone: 'ok' },
      ],
      exportsTitle: 'Ready to export from employee records',
      exports: ['Labor Management Register (.xlsx, .json)', 'Semiannual 01/PLI report (.xlsx, .json)'],
    },
    timekeeping: {
      title: 'Timekeeping import & annual leave ledger',
      sub: 'Paste from spreadsheets or upload .csv, .tsv, .txt',
      importBadge: '12/12 rows validated',
      otTitle: '40-hour monthly overtime cap check',
      otRows: [
        { name: 'Nguyen Minh Duc', regular: '26 days', ot: '18h overtime', status: 'Pass (under 40h)', tone: 'ok' },
        { name: 'Pham Thu Ha', regular: '25 days · 1 unpaid leave', ot: '42h overtime', status: 'Warning: over 40h cap', tone: 'warn' },
      ],
      leaveTitle: 'Accrued annual leave & 5-year seniority',
      leavePerson: 'Nguyen Minh Duc · 6 years tenure (+1 seniority day)',
      leaveStats: [
        ['Annual entitlement', '13 days'],
        ['Taken this year', '4 days'],
        ['Remaining balance', '9 days'],
      ],
    },
    payroll: {
      title: 'Payroll math, settlements & accountant isolation',
      sub: 'Exact decimal math, zero rounding drift',
      calcItems: [
        { label: 'Mandatory insurance (5 funds)', value: 'Employee & employer BHXH, BHYT, BHTN shares' },
        { label: 'Personal income tax', value: 'Progressive brackets or 10% flat withholding' },
        { label: '13th-month & severance', value: 'Completed calendar months & Labor Code Art. 46' },
      ],
      splitTitle: 'Visibility boundary between Owners and Accountants',
      ownerBoxTitle: 'Owners & Admins (Ludy HR)',
      ownerBoxBody: 'See individual pay lines, payslips, per-bank salary templates and D02-LT, 05/KK-TNCN, 05/QTT-TNCN sheets.',
      accountantBoxTitle: 'Four-eyes Accountant (Ludy Finance)',
      accountantBoxBody: 'Sees only aggregate totals by admin, sales and production accounts plus cash warnings at or above ₫5,000,000.',
    },
    recruiting: {
      title: 'Lightweight recruiting & one-click hire',
      sub: 'Add candidates with or without an opening',
      openingTitle: 'Channel sales representative · Region I',
      stages: [
        { stage: 'Screening', count: '3' },
        { stage: 'Interview', count: '2' },
        { stage: 'Offer', count: '1' },
      ],
      calendarTitle: 'Work calendar interview event',
      calendarEvent: 'Interview: Channel sales representative · 14:00 22/10/2026',
      calendarPrivacy: 'Calendar title never exposes candidate name or phone number',
      hireAction: 'One-click Hire: creates employee record and employment contract',
      eraseAction: 'Closed candidate: erases name, contact details and notes under PDPL',
    },
    coworker: {
      title: `${N.finance} reads aliases only & AI-off fallback`,
      sub: 'Metered by monthly budget in Ludy AI',
      shieldTitle: 'Prompt privacy wall before any model call',
      keptInServer: 'Kept on server: names, national IDs, tax codes, BHXH numbers, bank accounts, addresses, raw candidate pay',
      sentToModel: 'Sent to model: random aliases E1, E2, C1 plus percentage deltas and rule flags',
      briefTitle: `${N.finance} screening brief for alias C1`,
      briefBody: 'Matches 4/4 required skills; expected pay sits within opening band. Suggests asking about regional distributor onboarding.',
      aiOffTitle: 'When AI is off or monthly budget runs out',
      aiOffBody: `${N.finance} pauses: payroll math, timekeeping, leave balances, 01/PLI exports and recruiting keep running identically.`,
    },
  },
};
