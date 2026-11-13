// SPDX-License-Identifier: AGPL-3.0-only
// The privacy policy in English: the twin of privacy-vi.ts, with the same sections, the same lists and the same tables,
// typed from it. The Vietnamese text is the source; keep the two in step (privacy-page.test.ts checks the shape).
import type { PrivacyCopy } from './privacy';
import { N } from './roster';
import { PRIVACY_OPERATOR } from './site';

export const privacyEn: PrivacyCopy = {
  meta: {
    title: 'Privacy policy | Ludy',
    description:
      'What Ludy records, stores, who can read it and how long it is kept when you use the Ludy browser extension, and how Ludy Cloud handles account and ledger data. No selling data, no ads, no tracking.',
  },
  ogTitle: 'Privacy policy',
  crumbLabel: 'Breadcrumb',
  title: 'Privacy policy',
  lead: 'This page explains how Ludy handles data when you use the Ludy browser extension and when you use Ludy Cloud. The extension comes first, because it is the part to read before you press record.',
  versionLine: 'Version 1.0, effective 13 November 2026.',
  reviewNotice: 'This policy is being reviewed and may be updated.',
  contentsTitle: 'Contents',
  sections: [
    {
      id: 'summary',
      title: 'Summary',
      blocks: [
        {
          kind: 'list',
          items: [
            'The extension records only when you press "Start recording" on the meeting tab, after you confirm that everyone taking part was told and agreed.',
            'A recording goes to one Ludy address that you chose: app.ludy.vn, or your company\'s own Ludy server.',
            'The audio and video of each meeting are stored encrypted with their own key. When the retention period ends the key is destroyed and the recording can no longer be read; the text is deleted at its own date.',
            'Ludy does not sell data, run ads, track you, or use data to decide credit or lending.',
            'You can revoke the extension at any time in Ludy, under connected devices.',
          ],
        },
        {
          kind: 'p',
          text: `Ludy is open-source software. Ludy Cloud (app.ludy.vn) is operated by ${PRIVACY_OPERATOR}. Ludy can also run on a company's own server. The organization that records a meeting decides to record and must tell the participants; on Ludy Cloud, Ludy processes that data on the organization's instructions. A company that runs Ludy on its own server is responsible for the data on that server. This page describes the extension and Ludy Cloud, and does not replace that company's own policy.`,
        },
      ],
    },
    {
      id: 'extension',
      title: 'The Ludy browser extension',
      blocks: [
        {
          kind: 'p',
          text: 'The Ludy extension (Chrome and Edge) has one purpose: to record the audio of a meeting open in a browser tab, together with your microphone, and upload it as a meeting in your Ludy workspace when you stop. A recording holds the voices of the participants, and their faces if you record video too. That is personal data.',
        },
        {
          kind: 'table',
          caption: 'What the extension handles',
          head: ['Data', 'When', 'What it is for'],
          rows: [
            ['Audio of the meeting tab and of your microphone', 'Only after you confirm and press "Start recording"', 'To create the meeting recording in Ludy'],
            ['Video of the meeting tab', 'Only when you tick "Record video too" for that meeting', 'To look back at a shared screen'],
            ['The meeting title, how participants were told, your confirmation', 'Before recording', 'To keep the proof that participants were told, with the meeting'],
            ['The extension\'s sign-in token', 'After you sign in to Ludy and allow the extension', 'So Ludy knows the extension works for you, in one organization'],
            ['A device name, for example "Tiện ích Ludy, Chrome trên Windows"', 'When you connect the extension', 'So you can see and revoke the device in Ludy. It holds the browser and the operating system only, never a network address or serial number'],
            ['The Ludy address and the features you turned on', 'When you set the extension up', 'Kept in the extension\'s own storage on your computer'],
          ],
        },
        {
          kind: 'p',
          text: 'The extension does not read the content, address, title or selected text of any web page. It does not collect browsing history, location, financial or health information, and it has no analytics, telemetry or advertising identifier.',
        },
        { kind: 'p', text: 'The consent step comes before any recording:' },
        {
          kind: 'list',
          items: [
            'Before any recording device is opened, the extension asks you to enter the meeting title, choose how the participants were told (said at the start of the meeting, stated in the invitation, or in writing) and confirm that everyone was told and agreed.',
            'Ludy stores this confirmation with the meeting and refuses audio without it.',
            'The extension records only the tab you have open when you press "Start recording". It does not record other tabs and never starts by itself.',
          ],
        },
        { kind: 'p', text: 'Where the data goes:' },
        {
          kind: 'list',
          items: [
            'The extension talks to one address only: app.ludy.vn (Ludy Cloud), or the address of your company\'s own Ludy server that you type at setup. For your own server, the browser asks for permission for exactly that address. The extension contacts no other address and accepts only https addresses (or localhost).',
            'A recording that is not uploaded yet stays on your computer, in the extension\'s own storage, and is deleted once the upload is done. If the upload fails it stays until you retry or remove it from the device.',
            'Sign-in happens on the Ludy sign-in page, opened in a browser window. The extension never sees your password or the app\'s session.',
            'The extension\'s token is valid for one organization, one member and the features you turned on. It expires after 90 days, stops working at once if you are removed from the organization, and every use leaves a row in the audit log.',
          ],
        },
        { kind: 'p', text: 'The browser permissions the extension asks for, and why:' },
        {
          kind: 'list',
          items: [
            'Storage: keeps the Ludy address, the token and the features you turned on, and keeps a recording on the device until it is uploaded.',
            'Identity: opens the Ludy sign-in page so you can sign in and allow the extension.',
            'The address app.ludy.vn: sends the recording and the meeting details to Ludy Cloud, and gets the list of features.',
            'Tab capture and offscreen document: asked for only when you turn on "Record meetings", and given back when you turn it off. They record the audio of the tab where you pressed record, and never another tab.',
            'One own-server address: only for companies that run Ludy themselves, and only the single address you type. The extension never asks for permission on a site you are viewing.',
          ],
        },
        { kind: 'p', text: 'The extension uses no remote code: all of its code is in the installed package.' },
      ],
    },
    {
      id: 'storage',
      title: 'After the upload: storage',
      blocks: [
        {
          kind: 'list',
          items: [
            'A recording reaches Ludy over an https connection.',
            'The audio and video of each meeting are encrypted (AES-256-GCM) with their own key before they sit in storage. That key is wrapped under the system\'s key. The original upload is deleted once it has been normalized; the normalized audio stays. The transcript, summary, decisions and action items are text in the database and are deleted when their period ends.',
            'Video is kept only when you tick "Record video too". Without the tick the picture is dropped during processing and never stored. Video has its own key, so it can be destroyed earlier than the audio, and never later.',
            'Checking and converting files runs in a separate container with no network and no secrets.',
          ],
        },
      ],
    },
    {
      id: 'readers',
      title: 'Who can read a meeting',
      blocks: [
        {
          kind: 'list',
          items: [
            'Readers: the person who recorded it, and the members named as attendees. The recorder can share the meeting with the whole organization.',
            'Owners and admins see that a meeting exists (date, length, recorder) to manage budgets and retention, but do not read the content of a meeting shared only with its attendees. An owner can delete a meeting to answer a personal-data request without reading it.',
            'Viewers, the AI coworkers of the org chart and the system read nothing from a meeting.',
            `${N.gm}, working for the recorder, reads what the recorder reads, only within the meeting being processed. ${N.gm}'s output (transcript, summary, decisions, action items) is a draft that only the recorder sees, until the recorder publishes it to the readers of the meeting. A draft that is never published expires after 30 days. ${N.gm} does not create tasks, send mail or send notifications from a meeting's content on its own.`,
          ],
        },
      ],
    },
    {
      id: 'transcription',
      title: 'AI transcript and summary',
      blocks: [
        {
          kind: 'list',
          items: [
            'It runs only when your organization has turned it on and the deployment has an AI model configured. With AI off, the recording is still stored and nothing is sent to any AI provider.',
            'When it is on, the transcription provider that the workspace is set to receives the audio in segments (each at most 10 minutes) and a language hint, and nothing else. The provider\'s name and where it processes are a setting of each deployment.',
            'The summary uses the deployment\'s text model: it receives the transcript text, the meeting date and the names of the attendees of that meeting.',
            'A company that runs Ludy on its own server can point transcription at a model on its own machine; then the audio never leaves the company\'s machine.',
            'A provider outside Vietnam is a transfer of data abroad, which the organization must assess itself.',
            'AI output is unverified content. The recorder reviews it and decides whether to publish it.',
          ],
        },
      ],
    },
    {
      id: 'retention',
      title: 'How long it is kept',
      blocks: [
        {
          kind: 'table',
          caption: 'How long a meeting is kept',
          head: ['Data', 'Default', 'What the organization can choose'],
          rows: [
            ['Audio', '30 days after the transcript is ready', 'Deleted right after the transcript, or 7, 30 or 90 days'],
            ['Video (if kept)', '7 days', '7 or 30 days, never longer than the audio'],
            ['Transcript, summary, decisions, action items', '12 months', '3, 12 or 24 months, or until deleted'],
          ],
        },
        {
          kind: 'list',
          items: [
            'An owner or admin changes these settings. A change applies only to meetings recorded afterwards, so the period the participants were told stays true.',
            'If the transcript is never ready (AI off, AI budget spent), the audio and video still get an end date counted from the recording, so no recording waits forever.',
            'When the period ends, or when the meeting is deleted, the encryption key is destroyed. The audio and video can no longer be read at that moment. If the system has to restore an old backup, a meeting that was destroyed is deleted again by the next nightly run or when its deletion record is replayed. The unencrypted upload is removed from staging within one day.',
            'Text (transcript, summary, decisions, action items) is deleted by the nightly job when its period ends, and disappears from database backups when those backups expire.',
            'A task created from an action item is the organization\'s work record: it stays with the text the person confirmed, and its link back to the meeting reads "Meeting deleted".',
            'When an organization is deleted from Ludy, all of its meetings and keys are deleted.',
          ],
        },
      ],
    },
    {
      id: 'rights',
      title: 'Your rights and how to use them',
      blocks: [
        {
          kind: 'list',
          items: [
            'Stop recording: turn off "Record meetings" in the extension to give the tab permission back, or remove the extension at any time.',
            'Revoke the extension: in Ludy go to Settings, connected devices, and revoke the device. The extension\'s token stops working at once.',
            'Delete a meeting: the recorder deletes their own meeting in Ludy. Deleting destroys the audio key at once. The owner of an organization can delete any meeting of the organization (after a fresh sign-in check) without reading it.',
            'You took part in a meeting but do not use Ludy (a customer, a supplier, a candidate): tell the person who recorded it, or their company. They decide on recording, can stop the recording, and can delete the meeting if you object.',
            'To see, copy, correct or delete your data in an organization\'s books: contact that organization\'s owner or admin in Ludy first, because the organization decides on the processing. Ludy helps the organization carry out your request.',
            'Under Law 91/2025/QH15 on Personal Data Protection you have the right to be informed, to consent or withdraw consent, to see and correct your data, to ask for deletion, to restrict or object to processing, to receive a copy, and to complain, denounce and claim compensation. Some rights are limited where the law requires the data to be kept, for example accounting records.',
          ],
        },
      ],
    },
    {
      id: 'cloud',
      title: 'Ludy Cloud in general',
      blocks: [
        {
          kind: 'p',
          text: `Ludy Cloud (app.ludy.vn) is the Ludy that ${PRIVACY_OPERATOR} operates. This part is a summary and does not replace the extension part above. The policy is written under Law 91/2025/QH15 on Personal Data Protection and Decree 356/2025/NĐ-CP.`,
        },
        {
          kind: 'list',
          items: [
            'Account data: name, email, password (stored only as a hash), two-factor method; and activity such as sign-in times, IP address, browser and an action log. For this data Ludy is the data controller.',
            'Data in an organization\'s books (documents, invoices, bank statements, journal entries, and meetings): the organization decides why it is processed. Ludy is the processor and acts only on the organization\'s instructions.',
            'Google Calendar: only when a member connects their own calendar. Ludy reads busy time slots, not titles or attendees. Every member of the organization sees these busy slots (without any content).',
            'Purposes: to provide the service, security (sign-in checks, two-factor, audit log), support and operations, and answering valid requests from public authorities.',
            'Ludy does not sell personal data, does not use your documents or books for advertising, and does not use them to train AI models.',
            'AI with documents: e-invoices in XML are read directly, without AI. PDFs and photos of documents are sent to the deployment\'s AI provider to be read. The result is always checked by rules and approved by a person before it is booked.',
            'Security: data is isolated between organizations at the database level; encryption in transit; two-factor for approving documents; an audit log that cannot be edited; daily backups with restore tests; a limit on sign-in attempts.',
            'When a personal-data breach happens, Ludy tells the competent authority and your organization within 72 hours of discovery at the latest, as the rules require.',
            'Retention: an organization\'s data is kept while the organization uses Ludy. When an organization closes, it exports its data first, and then the data is deleted. Recipient email addresses and subjects in the mail log are deleted after 13 months, keeping only a hash to block sending again to an address that refused. The audit log is kept with the organization\'s books, because it is the proof of who approved what. The organization keeps its documents and accounting books for as long as the Law on Accounting requires, using its own export.',
          ],
        },
      ],
    },
    {
      id: 'changes',
      title: 'Changes to this policy',
      blocks: [
        {
          kind: 'p',
          text: 'This policy is being reviewed and may be updated. When the extension changes its browser permissions or the kind of data it handles, this page is updated at the same time, and the version and date at the top change with it.',
        },
      ],
    },
  ],
  contact: { emailLead: 'To ask for deletion or export of your data, or with a question about personal data, email' },
};
