// SPDX-License-Identifier: AGPL-3.0-only
// The words of the app, Vietnamese first and English (issue #4880). A small catalog of its own: the first slice has five
// screens' worth of text, and the web app's catalog (apps/app/src/i18n) is written for a browser and far larger. Both
// languages have the same keys (a test checks it). {name} is replaced by a value; text is rendered as text, never as markup.
export const LOCALES = ['vi', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'vi';

const vi = {
  'app.name': 'Ludy',
  'signIn.title': 'Đăng nhập Ludy',
  'signIn.lead': 'Đăng nhập bằng tài khoản DOS ID của bạn trong trình duyệt của điện thoại.',
  'signIn.server': 'Địa chỉ máy chủ Ludy',
  'signIn.serverHint': 'Chỉ cần với Ludy tự cài đặt, ví dụ https://ludy.congty.vn',
  'signIn.button': 'Tiếp tục với DOS ID',
  'signIn.working': 'Đang đăng nhập...',
  'signIn.error.unsupported-server': 'Máy chủ này không dùng đăng nhập DOS ID hoặc địa chỉ chưa đúng. Kiểm tra lại địa chỉ (phải bắt đầu bằng https://).',
  'signIn.error.server-unreachable': 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.',
  'signIn.error.no-device-lock': 'Hãy đặt khóa màn hình (mật khẩu, vân tay hoặc khuôn mặt) cho điện thoại rồi đăng nhập lại. Ludy cần nó để bảo vệ phiên đăng nhập.',
  'signIn.error.cancelled': 'Đăng nhập đã bị hủy.',
  'signIn.error.storage': 'Không lưu được phiên đăng nhập vào kho bảo mật của điện thoại. Hãy thử lại.',
  'signIn.error.generic': 'Đăng nhập chưa hoàn tất. Hãy thử lại.',
  'signIn.notice.revoked': 'Phiên đăng nhập trên điện thoại này đã bị thu hồi. Hãy đăng nhập lại.',
  'signIn.notice.expired': 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.',
  'lock.title': 'Ludy đang khóa',
  'lock.lead': 'Mở khóa bằng vân tay, khuôn mặt hoặc mật khẩu điện thoại.',
  'lock.prompt': 'Mở Ludy',
  'lock.button': 'Mở khóa',
  'lock.working': 'Đang mở khóa...',
  'lock.offline': 'Chưa kết nối được máy chủ. Kiểm tra mạng rồi mở khóa lại.',
  'lock.signOut': 'Đăng xuất',
  'home.title': 'Xin chào, {name}',
  'home.org': 'Công ty đang dùng: {org}',
  'home.pickOrg': 'Chọn công ty để làm việc trên điện thoại này:',
  'home.noOrg': 'Tài khoản này chưa thuộc công ty nào. Hãy tạo hoặc nhận lời mời trên bản web.',
  'home.stub': 'Đây là bản đầu tiên của ứng dụng. Duyệt chi và hộp thư khách hàng sẽ có ở các bản sau.',
  'home.loading': 'Đang tải...',
  'home.error.mfa': 'Tài khoản cần xác minh hai bước. Hãy mở Ludy trên web để hoàn tất.',
  'home.error.generic': 'Chưa tải được dữ liệu. Kéo xuống để thử lại.',
  'home.retry': 'Thử lại',
  'home.signOut': 'Đăng xuất',
  'home.signOutHint': 'Xóa phiên đăng nhập khỏi điện thoại này.',
  'stepUp.prompt': 'Xác nhận việc này',
  'stepUp.kernel': 'Việc này cần xác minh hai bước. Hãy mở Ludy trên web để hoàn tất.',
} as const;

export type MessageKey = keyof typeof vi;

const en: Record<MessageKey, string> = {
  'app.name': 'Ludy',
  'signIn.title': 'Sign in to Ludy',
  'signIn.lead': 'Sign in with your DOS ID account in your phone\'s browser.',
  'signIn.server': 'Ludy server address',
  'signIn.serverHint': 'Only for self-hosted Ludy, for example https://ludy.yourcompany.com',
  'signIn.button': 'Continue with DOS ID',
  'signIn.working': 'Signing in...',
  'signIn.error.unsupported-server': 'This server does not use DOS ID sign-in, or the address is wrong. Check the address (it must start with https://).',
  'signIn.error.server-unreachable': 'Could not reach the server. Check your connection and try again.',
  'signIn.error.no-device-lock': 'Set a screen lock (passcode, fingerprint or face) on this phone, then sign in again. Ludy needs it to protect your session.',
  'signIn.error.cancelled': 'Sign-in was cancelled.',
  'signIn.error.storage': 'Could not save the session in the phone\'s secure storage. Try again.',
  'signIn.error.generic': 'Sign-in did not complete. Try again.',
  'signIn.notice.revoked': 'The session on this phone was revoked. Sign in again.',
  'signIn.notice.expired': 'The session has expired. Sign in again.',
  'lock.title': 'Ludy is locked',
  'lock.lead': 'Unlock with your fingerprint, face or phone passcode.',
  'lock.prompt': 'Open Ludy',
  'lock.button': 'Unlock',
  'lock.working': 'Unlocking...',
  'lock.offline': 'Could not reach the server. Check your connection and unlock again.',
  'lock.signOut': 'Sign out',
  'home.title': 'Hello, {name}',
  'home.org': 'Company in use: {org}',
  'home.pickOrg': 'Choose the company to work in on this phone:',
  'home.noOrg': 'This account does not belong to a company yet. Create one or accept an invite on the web.',
  'home.stub': 'This is the first version of the app. Approvals and the customer inbox come in later versions.',
  'home.loading': 'Loading...',
  'home.error.mfa': 'This account needs two-step verification. Open Ludy on the web to finish.',
  'home.error.generic': 'Could not load your data. Try again.',
  'home.retry': 'Try again',
  'home.signOut': 'Sign out',
  'home.signOutHint': 'Removes the session from this phone.',
  'stepUp.prompt': 'Confirm this action',
  'stepUp.kernel': 'This action needs two-step verification. Open Ludy on the web to finish.',
};

export const MESSAGES: Record<Locale, Record<MessageKey, string>> = { vi, en };

export type Translate = (key: MessageKey, values?: Record<string, string>) => string;

// The first supported language of the phone ("en-US" counts as "en"), then Vietnamese.
export function resolveLocale(tags: readonly string[]): Locale {
  for (const tag of tags) {
    const language = tag.toLowerCase().split(/[-_]/)[0];
    if (language === 'vi' || language === 'en') return language;
  }
  return DEFAULT_LOCALE;
}

export function createTranslator(locale: Locale): Translate {
  const catalog = MESSAGES[locale];
  return (key, values) => (values ? catalog[key].replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match) : catalog[key]);
}

export function deviceLocale(): Locale {
  try {
    return resolveLocale([Intl.DateTimeFormat().resolvedOptions().locale]);
  } catch {
    return DEFAULT_LOCALE;
  }
}
