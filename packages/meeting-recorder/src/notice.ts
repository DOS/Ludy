// SPDX-License-Identifier: AGPL-3.0-only
// The recording notice kit (Meetings A1, #3159; plan docs/plan/meetings-integrations.md section 4.1). One fixed, versioned
// text the recorder copies and pastes in the call's chat, so everyone is told before audio starts. This file is the only
// place the words live: the app and the extension both import it, and the version of the text that was copied is what the
// meeting row stores as `consent_notice_version`. Ludy never posts anything into a call, and nothing here calls a model:
// a notice is a legal act, not a draft.
//
// DRAFT, PENDING THE LAWYER'S READING (#2585). The wording is commentary until a lawyer confirms it against Law 91/2025
// and Decree 356/2025. It is not legal advice and the screens say so. Changing a word means a new version string.

export const RECORDING_NOTICE_LANGUAGES = ['vi', 'en'] as const;
export type RecordingNoticeLanguage = (typeof RECORDING_NOTICE_LANGUAGES)[number];

export interface RecordingNotice {
  // Stored on the meeting. Same string as the server's CONSENT_NOTICE_VERSION (a test ties the two).
  version: string;
  // Pending the lawyer's reading (#2585); the screens show it as a draft.
  reviewed: false;
  reviewIssue: 2585;
  text: Record<RecordingNoticeLanguage, string>;
}

export const RECORDING_NOTICE: RecordingNotice = {
  version: '2026-11-v1',
  reviewed: false,
  reviewIssue: 2585,
  text: {
    vi: 'Cuộc họp này đang được ghi âm để lập biên bản. Nếu ai không đồng ý, xin báo ngay để chúng tôi dừng ghi.',
    en: 'This meeting is being recorded to prepare the minutes. If anyone does not agree, please say so now and we will stop recording.',
  },
};

// The meeting's language is the default; anything else (automatic, unknown) falls back to Vietnamese.
export function noticeLanguageFor(meetingLanguage: string): RecordingNoticeLanguage {
  return meetingLanguage === 'en' ? 'en' : 'vi';
}

export function otherNoticeLanguage(language: RecordingNoticeLanguage): RecordingNoticeLanguage {
  return language === 'vi' ? 'en' : 'vi';
}

// What goes on the clipboard, and the version that goes with it: the caller sends that version when it creates the meeting.
export function noticeToCopy(language: RecordingNoticeLanguage): { text: string; version: string } {
  return { text: RECORDING_NOTICE.text[language], version: RECORDING_NOTICE.version };
}
