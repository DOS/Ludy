// SPDX-License-Identifier: AGPL-3.0-only
// English copy of the Ludy eSign page (/esign), in the shape of esign-vi.ts. The example company and vendors stay
// Vietnamese only where they are already allowed proper names in test/vietnamese.ts.
import type { EsignCopy } from './esign-vi';
import { N } from './roster';

export const esignEn: EsignCopy = {
  appName: 'Ludy eSign',
  meta: {
    title: 'Ludy eSign: sign PDFs via Zalo or email, seal with SHA-256 and verify offline',
    description:
      'Ludy eSign inspects PDFs in a zero-egress sandbox, lets you place fields manually or ask your AI coworker for suggestions, sends no-referrer Zalo links or emails with optional OTP, seals with SHA-256 and an audit certificate, and verifies files in the browser. Open source AGPL.',
  },
  ogTitle: 'Sign PDFs via Zalo or email, sealed with SHA-256.',
  crumbLabel: 'Breadcrumb',
  hero: {
    title: 'Sign PDFs via Zalo or email, sealed with SHA-256.',
    lead: `Upload a PDF or hand off from a Ludy Engage quote, inspect it safely and place fields with suggestions from ${N.gm}. Send Zalo links or email with optional OTP, seal with SHA-256 and verify files offline in the browser.`,
    primary: 'Self-host for free',
    secondary: 'Sign in',
    note: 'Open source under the AGPL. Ludy eSign is in the self-hosted edition. On Ludy Cloud: coming soon.',
  },
  how: {
    title: 'Four steps from a PDF to a sealed record',
    lead: 'Runs out of the box when you self-host with docker compose, with no paid keys or external provider accounts.',
    steps: [
      {
        name: 'Upload & inspect',
        body: 'Accepts PDFs (up to 25 MB, 200 pages) or one-click handoffs from a Ludy Engage quote. A zero-egress sandbox checks structure and rejects encryption or active scripts.',
        outcome: 'PDF passed',
        tone: 'neutral',
      },
      {
        name: 'Place fields & check clauses',
        body: `Place signature, initial, date, text and checkbox fields by hand, or ask ${N.gm} to suggest boxes and flag risky clauses within your AI budget.`,
        outcome: 'Proposed, human-approved',
        tone: 'accent',
      },
      {
        name: 'Send via Zalo link or email',
        body: 'Parallel or sequential routing. Copy a fragment-only Zalo link (no-referrer) or send an email with optional 6-digit OTP. Signers sign on any phone without an account.',
        outcome: 'Sent to signers',
        tone: 'ok',
      },
      {
        name: 'Seal & verify',
        body: 'Flattens signatures and Vietnamese text into the PDF, appends an audit certificate page with certificate.json and lets anyone verify SHA-256 offline.',
        outcome: 'Sealed with SHA-256',
        tone: 'ok',
      },
    ],
  },
  groups: {
    title: 'What Ludy eSign does today',
    lead: 'Built for everyday service agreements, delivery acceptance minutes and quotes: safe PDF checks, field placement, mobile signing, SHA-256 sealing and offline verification.',
    items: [
      {
        id: 'inspect-and-place',
        title: 'Safe PDF inspection, field placement and quote handoff',
        lead: 'Envelopes accept direct PDF uploads or a one-click handoff from a Ludy Engage quote, always running safety checks before sending.',
        points: [
          'Accepts PDFs up to 25 MB and 200 pages inside a zero-egress sandbox: verifies PDF structure and rejects password-encrypted files, embedded scripts, auto-open actions and embedded attachments',
          'Stores eSign contracts under a dedicated document purpose so uploaded agreements never trigger Finance invoice OCR',
          'Pure-JS browser PDF viewer (zero .wasm assets) with keyboard and drag placement for 5 field types (Signature, Initials, Date, Name/Title, Checkbox) assigned to signers or approvers in parallel or sequential order, plus CC recipients who receive the sealed copy upon completion',
          'One-click handoff from Ludy Engage quotes (draft, sent or non-expired accepted): exports the quote PDF, creates the linked eSign envelope, pre-fills the buyer and shows live signing status back on the quote',
          'Per-organization app switch: switching eSign off hides the app from the switcher, returns 404 on app APIs and returns an identical generic 404 on every public signing and verify route',
        ],
      },
      {
        id: 'zalo-link-and-otp',
        title: 'No-referrer Zalo links, optional email OTP and mobile signing',
        lead: 'Recipients open the link on a phone from 360px wide to draw, type their signature or confirm approval, with no account signup and no CAPTCHA.',
        points: [
          'Each 32-byte signing token lives only in the URL fragment (/-/sign#<token>): the server stores only its SHA-256 hash, the page strips the fragment on load and every response sends Referrer-Policy: no-referrer',
          'Supports both one-click Zalo/chat links and email invitations; in sequential routing, later signers cannot download PDF bytes until earlier turns finish, with rate-limited reminders',
          'Optional 6-digit email OTP (10-minute TTL, max 5 guesses, max 3 sends per hour): the PDF remains locked until the recipient enters the code from their mailbox',
          'Mobile-first ceremony lets signers draw by touch/mouse or type their name as a validated PNG (SVG/XML rejected) and gives approvers a dedicated one-click approval screen without drawing a signature, backed by an atomic single-use guard and zero CAPTCHA friction',
        ],
      },
      {
        id: 'sealing-and-verification',
        title: 'SHA-256 sealing, audit certificates and offline verification',
        lead: 'Once all signers finish, Ludy seals the final PDF and creates a verifiable evidence bundle anyone can check locally.',
        points: [
          'Inside the sandbox, Ludy flattens prior form fields and annotations, stamps validated PNG signatures and Vietnamese text (Be Vietnam Pro), strips interactive scripts and appends an Audit Certificate summary page',
          'Every envelope keeps an append-only, SHA-256 hash-chained event ledger (protected against updates and deletes at the database level) alongside canonical certificate.json and a CS-XXXX-XXXX-XXXX code',
          'The Verify PDF screen (/sign/verify) computes SHA-256 locally in the browser with Web Crypto so zero document bytes leave the device, matching against certificate.json offline or looking up the certificate code',
          'Upon sealing, Ludy emails the completed sealed PDF and certificate.json to the sender, signers, approvers and CC recipients (attaching files up to 18 MB, and always including certificate.json, the certificate code and the SHA-256 digest when a larger PDF is omitted)',
        ],
      },
      {
        id: 'vy-suggestions',
        title: `${N.gm} suggests fields and flags risky clauses`,
        lead: `When AI is on, ${N.gm} reads extracted PDF text to suggest field boxes and highlight clauses worth checking; when AI is off, manual placement and sending work identically.`,
        points: [
          `Field proposals and clause summaries run through the monthly AI budget in Ludy AI with zero tool access, treating extracted PDF text as untrusted data and checking box bounds and quote excerpts deterministically per page`,
          `Suggested fields render as dashed proposal overlays labeled "Proposed"; only a human click on Apply or Apply all promotes them into real fields, and ${N.gm} can never send an envelope`,
          `When AI is switched off, the kill switch is tripped or the monthly budget runs out, ${N.gm} shows a clear notice while PDF upload, manual field placement, Zalo/email links, OTP, sealing and verification keep running`,
        ],
      },
    ],
  },
  soon: {
    title: 'Coming soon',
    lead: 'These three items belong to Slice 2 or await live provider credentials and legal sign-off, so Ludy does not count them as usable out of the box today.',
    label: 'Coming soon',
    items: [
      {
        title: 'Vietnam public CA connections (VNPT SmartCA, Viettel MySign, MISA WeSign) and PAdES-LTV envelope signing',
        body: 'Provider adapter and PAdES-LTV CMS embedding primitives are built in the repository; wiring them into envelope signing, the per-organization setup screen, live provider test credentials and legal compliance review under Law 20/2023/QH15, Decree 23/2025/ND-CP and PDPL 91/2025/QH15 are coming next.',
      },
      {
        title: 'Reusable document templates and permanent direct signing links',
        body: 'Save role presets and field layouts to start new envelopes in one step, plus permanent direct links for frequently signed forms.',
      },
      {
        title: 'Contract renewal reminders and HR labor contract handoff',
        body: 'Expiration and renewal reminders on sealed agreements, plus direct envelope creation from employee contracts in Ludy HR.',
      },
    ],
  },
  coworker: {
    title: `What ${N.gm} does in Ludy eSign`,
    lead: `${N.gm} is the AI general manager coordinating across Ludy apps. In Ludy eSign, ${N.gm} reads PDF text only when asked and budget allows; a person always approves fields and clicks send.`,
    doesTitle: `${N.gm} does`,
    does: [
      'Reads extracted PDF text to propose signature, initial, date and text field coordinates per recipient',
      'Summarizes key terms and flags clauses worth checking (auto-renewal, penalty caps, unilateral termination) with page-verified quotes',
      'Respects monthly AI budgets and the Stop AI switch in Ludy AI; manual signing works identically when AI is off',
    ],
    doesNotTitle: `${N.gm} does not`,
    doesNot: [
      'Never promotes proposed boxes into fields on its own or moves fields you placed',
      'Never mints signing links, emails invitations, sends reminders or voids an envelope',
      "Never replaces legal advice or an authorized person's decision to sign",
    ],
  },
  audience: {
    title: 'Who Ludy eSign is for',
    lead: 'Use standalone for daily agreements, or connected straight to quotes and archiving.',
    items: [
      {
        title: 'Solo founders and small businesses',
        body: 'Send service contracts, NDAs or delivery acceptance minutes over a compact Zalo link so counterparties sign on their phone in seconds instead of printing and scanning.',
      },
      {
        title: 'Sales teams using Ludy Engage',
        body: 'Hand off draft, sent or accepted quotes directly into an eSign envelope without downloading and re-uploading PDFs, and track signing status right on the quote.',
      },
      {
        title: 'People who self-host',
        body: 'Open source under the AGPL, running inside docker compose with all PDFs, signatures and audit evidence stored on your own server and storage.',
      },
    ],
  },
  faq: {
    title: 'Questions about Ludy eSign',
    items: [
      {
        q: 'What legal standing do Ludy eSign signatures have today?',
        a: 'Today Ludy eSign ships self-contained electronic signatures with a hash-chained event ledger, optional email OTP and SHA-256 PDF sealing, suited for commercial contracts and acceptance minutes where parties agree on electronic authentication. Documents that legally require certified Vietnam public digital signatures (such as VAT e-invoices or tax filings) wait for live CA setup after test credentials and legal review.',
      },
      {
        q: 'Do signers need a Ludy account or a CAPTCHA check?',
        a: 'No. Recipients open the Zalo or email link on a phone or desktop browser, verify an optional 6-digit email OTP if enabled, draw or type their signature, confirm consent and submit.',
      },
      {
        q: 'Why do signing links put the token after # instead of a query string?',
        a: 'Browsers never send the #fragment to servers or Referer headers. Ludy also enforces Referrer-Policy: no-referrer, clears the fragment from the address bar on load and stores only the SHA-256 hash of each single-use token.',
      },
      {
        q: 'Does Ludy eSign still work when AI is turned off?',
        a: `Yes. PDF upload, sandbox safety checks, manual field placement, Zalo and email links, email OTP, mobile signing, SHA-256 sealing and offline verification all run without AI. ${N.gm} is strictly optional for field proposals and clause checks.`,
      },
      {
        q: 'How can anyone verify a signed PDF without uploading it to a server?',
        a: 'Open Verify PDF (/sign/verify) and drop the sealed PDF. Your browser computes SHA-256 locally via Web Crypto so no file bytes leave your device, and checks it offline against certificate.json or via the certificate code lookup.',
      },
    ],
  },
  cta: {
    title: 'Try Ludy eSign with your next contract',
    body: 'Self-host for free with a single docker compose command. Already have an account? Sign in.',
    primary: 'See how to self-host',
    secondary: 'Sign in',
  },
  fragments: {
    sample: 'Example data',
    hero: {
      label: 'A Ludy eSign envelope showing recipients, a proposed field and clause review',
      docTitle: 'Q4/2026 packaging supply contract',
      sourceChip: 'From quote BG-2026-018',
      routingChip: 'Sequential',
      inspectBadge: 'PDF passed, 4 pages',
      signersTitle: 'Recipients (2)',
      signers: [
        { order: 'Turn #1', name: 'Tuan', detail: 'Party A, Zalo link', state: 'Pending', tone: 'accent' },
        { order: 'Turn #2', name: 'Hoa', detail: 'Party B (Bao Bì Phú Thịnh), email + OTP', state: 'Waiting', tone: 'neutral' },
      ],
      pageLabel: 'Page 4 / 4',
      partyA: 'Party A: Gạo Sạch Mekong',
      partyB: 'Party B: Công ty CP Bao Bì Phú Thịnh',
      placedField: 'Signature, Tuan',
      proposalBadge: `Proposed by ${N.gm}`,
      proposalField: 'Signature, Hoa',
      applyBtn: 'Apply',
      dismissBtn: 'Dismiss',
      vyTitle: `${N.gm} contract review`,
      vyClause: 'Clause 5.2: Late delivery penalty of 8% of the delayed batch value',
      vyRisk: 'Needs review, Page 3',
      sendBtn: 'Send for signature',
      sendNote: 'Only a person locks fields and sends',
    },
    intake: {
      title: 'PDF safety inspection & source handoff',
      sub: 'Isolated zero-egress sandbox',
      checks: [
        'Up to 25 MB and 200 pages, PDF structure verified',
        'Rejects encrypted files, embedded scripts and auto-open actions',
        'Isolated from Finance invoice OCR queues',
      ],
      handoffTitle: 'Hand off from Ludy Engage quote',
      handoffFrom: 'Quote BG-2026-018, Gạo Sạch Miền Tây',
      handoffTo: 'Draft eSign envelope (buyer pre-filled)',
      paletteTitle: '5 field types assigned to signers or approvers',
      fieldTypes: ['Signature', 'Initials', 'Date', 'Name / Title', 'Checkbox'],
    },
    ceremony: {
      title: 'Public mobile signing ceremony (360px)',
      urlNote: '/-/sign#<token> · Referrer-Policy: no-referrer',
      otpBadge: 'Protected by 6-digit email OTP',
      docTitle: 'Q4/2026 packaging supply contract',
      remainingBadge: '1 required field left',
      tabs: ['Draw', 'Type name'],
      activeTab: 1,
      typedName: 'Tran Thi Hoa',
      consent: 'I agree to use an electronic signature and confirm the contents of this document.',
      submitBtn: 'Finish signing',
      declineBtn: 'Decline',
    },
    sealing: {
      title: 'Sealed evidence & Offline verification',
      certCodeLabel: 'Certificate code',
      certCode: 'CS-7F3A-91C2-04B8',
      sourceLabel: 'Original SHA-256',
      sourceHash: '4a9c2e81b04f...7d31e5082a19',
      sealedLabel: 'Sealed SHA-256',
      sealedHash: '8f3a1c04d92b...c61e4b902f7a',
      chainBadge: 'Hash chain intact (7 events)',
      verifyTitle: 'Verify PDF offline (/sign/verify)',
      verifyNote: 'Computes SHA-256 locally via Web Crypto; file never leaves your browser',
      verifyResult: 'Intact - matches the original sealed file',
      caBadge: 'Emails the sealed PDF & certificate.json to signers, approvers and CC',
    },
    vyReview: {
      title: `${N.gm} clause review & AI-off fallback`,
      summaryLabel: 'Clause summary',
      summaryBody: '12-month supply contract for 5-ply carton boxes, payment within 15 days after acceptance minutes.',
      riskLabel: 'Clauses worth checking',
      risks: [
        { title: 'Auto-renews unless notified 30 days ahead', level: 'Needs review', page: 'Page 2', tone: 'warn' },
        { title: 'Late delivery penalty 8% of delayed batch', level: 'Needs review', page: 'Page 3', tone: 'warn' },
      ],
      aiOffTitle: 'When AI is off or monthly budget runs out',
      aiOffBody: `${N.gm} pauses: PDF upload, manual field placement, Zalo links, OTP and sealing keep working identically.`,
    },
  },
};
