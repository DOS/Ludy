// SPDX-License-Identifier: AGPL-3.0-only
// The extension's words in Vietnamese (the default and the fallback) and English, chosen once from the browser's interface language (#3008). The English consent text is the app
// recorder's (apps/app/src/i18n/messages, meetings.form); the Vietnamese method labels are the extension's own short forms. No dependency and no remote file: both sets ship in the package.
const VI = {
  title: 'Ludy',
  setupTitle: 'Kết nối với Ludy',
  cloud: 'Ludy Cloud (app.ludy.vn)',
  selfHosted: 'Máy chủ riêng',
  addressPlaceholder: 'ludy.congty.vn',
  save: 'Lưu địa chỉ',
  addressInvalid: 'Địa chỉ không hợp lệ.',
  addressInsecure: 'Chỉ nhận địa chỉ https (hoặc localhost).',
  addressDenied: 'Chưa cho phép tiện ích nói chuyện với địa chỉ này.',
  signIn: 'Đăng nhập Ludy',
  signingIn: 'Đang mở trang đăng nhập...',
  signInFailed: 'Đăng nhập không thành công. Hãy thử lại.',
  signInDenied: 'Bạn đã không cho phép tiện ích.',
  org: 'Tổ chức',
  addOrg: 'Kết nối tổ chức khác',
  signOut: 'Đăng xuất khỏi tiện ích',
  signOutNote: 'Thu hồi hẳn ở Cài đặt, mục thiết bị đã kết nối, trong Ludy.',
  changeAddress: 'Đổi địa chỉ',
  noFeatures: 'Tổ chức này chưa bật tính năng nào dùng được với tiện ích.',
  loadFailed: 'Không lấy được thông tin từ Ludy. Hãy đăng nhập lại.',
  meetings: 'Ghi cuộc họp',
  meetingsOn: 'Bật ghi cuộc họp',
  meetingsOff: 'Tắt và trả lại quyền',
  meetingsNote: 'Ghi âm tab họp (Google Meet, Teams, Zoom trên trình duyệt) cùng micro của bạn. Tiện ích chỉ ghi tab bạn đang mở khi bấm Bắt đầu.',
  permissionDenied: 'Chưa có quyền ghi tab. Hãy bấm lại và chọn "Cho phép".',
  consentTitle: 'Xác nhận đồng ý ghi âm (Bắt buộc)',
  consentNotice: 'Trước khi bắt đầu, người chủ trì phải thông báo cho tất cả người tham gia rằng cuộc họp được ghi âm và xử lý theo chính sách quyền riêng tư.',
  consentSpoken: 'Câu thông báo mẫu: "Cuộc họp này được ghi lại để phục vụ lưu trữ và tóm tắt công việc. Nếu có ý kiến, vui lòng trao đổi trước khi tiếp tục."',
  meetingTitle: 'Tên cuộc họp',
  consentMethod: 'Đã báo cho người tham gia bằng cách nào',
  consentMethods: { told_at_start: 'Nói ở đầu cuộc họp', in_invite: 'Ghi trong lời mời', in_writing: 'Bằng văn bản' },
  consentChoose: 'Chọn...',
  consentConfirm: 'Tôi xác nhận đã thông báo và nhận được sự đồng thuận của tất cả người tham dự theo đúng quy định.',
  withVideo: 'Ghi cả video',
  start: 'Bắt đầu ghi',
  stop: 'Dừng và tải lên',
  recording: 'Đang ghi',
  uploading: 'Đang tải lên...',
  uploaded: 'Đã tải lên. Ludy đang xử lý cuộc họp.',
  uploadFailed: 'Chưa tải lên được. Bản ghi còn trên máy này, bạn có thể tải lại bên dưới.',
  micMissing: 'Micro chưa được cho phép: bản ghi chỉ có âm thanh của tab, không có giọng bạn.',
  pending: 'Bản ghi còn trên máy này',
  retry: 'Tải lên lại',
  discard: 'Xóa khỏi máy',
  recordingTitle: 'Ludy đang ghi',
  micTitle: 'Cho phép micro cho Ludy',
  micHeading: 'Cho phép micro cho tiện ích Ludy',
  micPrompt: 'Trình duyệt sẽ hỏi quyền dùng micro. Chọn "Cho phép" để Ludy ghi cả giọng của bạn.',
  micDone: 'Xong. Bạn có thể đóng tab này.',
  micDenied: 'Micro chưa được cho phép. Ludy vẫn ghi âm thanh của tab họp, nhưng không có giọng của bạn. Bạn có thể cho phép micro trong cài đặt trình duyệt.',
  blockers: {
    invalid: 'Yêu cầu không hợp lệ.',
    title: 'Vui lòng nhập tên cuộc họp.',
    consentMethod: 'Vui lòng chọn cách đã báo cho người tham gia.',
    consentAgreed: 'Bạn phải xác nhận người tham gia đã đồng ý.',
    permission: 'Chưa có quyền ghi tab. Hãy tắt rồi bật lại tính năng.',
    busy: 'Đang có một bản ghi khác.',
    signedOut: 'Hãy đăng nhập và bật ghi cuộc họp trước.',
    device: 'Không mở được âm thanh của tab. Hãy mở tab họp, bấm biểu tượng Ludy trên tab đó rồi thử lại.',
    store: 'Không lưu được bản ghi trên máy này.',
    setup: 'Không bắt đầu được. Hãy thử lại.',
  },
} as const;

// The same keys with any text: English may not repeat Vietnamese's literals, but must have every key (a missing one fails the type check and strings.test.ts).
type Widen<V> = { readonly [K in keyof V]: V[K] extends string ? string : Widen<V[K]> };
export type Strings = Widen<typeof VI>;

export const VIETNAMESE: Strings = VI;

export const ENGLISH: Strings = {
  title: 'Ludy',
  setupTitle: 'Connect to Ludy',
  cloud: 'Ludy Cloud (app.ludy.vn)',
  selfHosted: 'Own server',
  addressPlaceholder: 'ludy.yourcompany.com',
  save: 'Save address',
  addressInvalid: 'The address is not valid.',
  addressInsecure: 'Only https addresses (or localhost) are accepted.',
  addressDenied: 'The extension has not been allowed to talk to this address.',
  signIn: 'Sign in to Ludy',
  signingIn: 'Opening the sign-in page...',
  signInFailed: 'Sign-in did not work. Please try again.',
  signInDenied: 'You did not allow the extension.',
  org: 'Organization',
  addOrg: 'Connect another organization',
  signOut: 'Sign out of the extension',
  signOutNote: 'To revoke it for good, go to Settings, connected devices, in Ludy.',
  changeAddress: 'Change address',
  noFeatures: 'This organization has not turned on any feature that works with the extension.',
  loadFailed: 'Could not get the information from Ludy. Please sign in again.',
  meetings: 'Record meetings',
  meetingsOn: 'Turn on meeting recording',
  meetingsOff: 'Turn off and give the permission back',
  meetingsNote: 'Records the audio of the meeting tab (Google Meet, Teams, Zoom in the browser) together with your microphone. The extension records only the tab you have open when you click Start.',
  permissionDenied: 'Tab recording is not allowed yet. Click again and choose "Allow".',
  consentTitle: 'Recording consent confirmation (Mandatory)',
  consentNotice: 'Before starting, the organizer must notify all participants that the meeting is recorded and processed according to privacy policy.',
  consentSpoken: 'Sample notice: "This meeting is being recorded for record keeping and summary. Please let us know if you have any questions before proceeding."',
  meetingTitle: 'Meeting title',
  consentMethod: 'How the participants were told',
  consentMethods: { told_at_start: 'Announced verbally at the start of the meeting', in_invite: 'Stated in the meeting invitation', in_writing: 'Notified in writing prior to the meeting' },
  consentChoose: 'Choose...',
  consentConfirm: 'I confirm that all participants have been notified and gave consent according to regulations.',
  withVideo: 'Record video too',
  start: 'Start recording',
  stop: 'Stop and upload',
  recording: 'Recording',
  uploading: 'Uploading...',
  uploaded: 'Uploaded. Ludy is processing the meeting.',
  uploadFailed: 'Could not upload yet. The recording is still on this device, and you can retry below.',
  micMissing: 'The microphone is not allowed: the recording has the tab audio only, not your voice.',
  pending: 'Recordings still on this device',
  retry: 'Upload again',
  discard: 'Delete from this device',
  recordingTitle: 'Ludy is recording',
  micTitle: 'Allow the microphone for Ludy',
  micHeading: 'Allow the microphone for the Ludy extension',
  micPrompt: 'The browser will ask for permission to use the microphone. Choose "Allow" so Ludy records your voice too.',
  micDone: 'Done. You can close this tab.',
  micDenied: 'The microphone is not allowed. Ludy still records the audio of the meeting tab, but not your voice. You can allow the microphone in the browser settings.',
  blockers: {
    invalid: 'The request is not valid.',
    title: 'Enter the meeting title.',
    consentMethod: 'Choose how the participants were told.',
    consentAgreed: 'You must confirm the participants consented.',
    permission: 'Tab recording is not allowed yet. Turn the feature off and on again.',
    busy: 'Another recording is in progress.',
    signedOut: 'Sign in and turn on meeting recording first.',
    device: 'Could not open the tab audio. Open the meeting tab, click the Ludy icon on that tab and try again.',
    store: 'Could not save the recording on this device.',
    setup: 'Could not start. Please try again.',
  },
};

// English for an English browser (en, en-US, en-GB...); Vietnamese for anything else, including no language at all.
export function chooseStrings(language: string | undefined | null): Strings {
  return typeof language === 'string' && /^en(-|_|$)/i.test(language.trim()) ? ENGLISH : VIETNAMESE;
}

// The browser's own language (the language of its interface), or the page's when there is no extension API (a unit test under Node).
function browserLanguage(): string | undefined {
  try {
    return chrome.i18n.getUILanguage();
  } catch {
    return typeof navigator === 'undefined' ? undefined : navigator.language;
  }
}

export const T: Strings = chooseStrings(browserLanguage());
