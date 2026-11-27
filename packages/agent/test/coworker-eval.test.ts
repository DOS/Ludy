// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic unit tests for the coworker eval runner, per-feature coverage, and injection-leak detection (#3977).
import { describe, expect, it } from 'vitest';
import {
  AI_FEATURE_KEYS,
  AdsCampaignWriter,
  AskBooksCoworker,
  ConversationWriter,
  ExpenseVarianceCoworker,
  InboxReader,
  PayrollCoworker,
  QuarterSummaryCoworker,
  SchedulingReader,
  SignAcceptanceReader,
  SignAiReader,
  SocialWriter,
  TodayWriter,
  WeeklyWriter,
  toParsed,
  type AiConfig,
} from '../src/index.ts';
import { MEMBER_VY_FEATURE_TABLE, bindPorts, noKnowledge, type ModelPort, type Ports } from '../src/member-vy/index.ts';
import {
  ALL_COWORKER_FEATURE_KEYS,
  HR_POLICY_EVAL_NOTE_ID,
  UNIMPLEMENTED_SYSTEM_FEATURES,
  buildCoworkerEvalCases,
  createCoworkerEvalRuntime,
  formatCoworkerEvalReport,
  hasLeakedInjectionPayload,
  isHrPolicyQaOk,
  runCoworkerEval,
  summarizeCoworkerEval,
} from './coworkers.ts';
import { INJECTION_CORPUS } from './fixtures/injection-corpus.ts';

const STUB_CONFIG: AiConfig = { baseURL: 'http://127.0.0.1:1/v1', apiKey: null, model: 'stub-eval-model', maxRetries: 0 };
const zeroUsage = { inputTokens: 10, outputTokens: 5 };

function firstId(prompt: string, fallback: string): string {
  const m = /- ([A-Za-z0-9_-]+)\s+\(/.exec(prompt);
  return m?.[1] ?? fallback;
}

const CLEAN_INVOICE = toParsed({
  isInvoice: true,
  series: 'C26TAB',
  number: '0000012',
  issueDate: '2026-09-15',
  currency: 'VND',
  seller: { name: 'Cong ty TNHH Minh Anh', taxCode: '0101234564', address: null, bankAccount: null },
  buyer: { name: 'Cong ty TNHH Hoa Sen', taxCode: '0301234567', address: null },
  lines: [{ description: 'Dich vu tu van ke toan', unit: 'Goi', quantity: '1', unitPrice: '1000000', amount: '1000000', vatRate: '10%', isDiscount: false }],
  subtotal: '1000000',
  vatTotal: '100000',
  total: '1100000',
});

function createStubRuntime() {
  const model: ModelPort = {
    generate: async (_who, prompt) => {
      const feature: string = prompt.feature ?? '';
      const sys = prompt.system;
      let text = '{}';
      if (feature === 'meetings.summary' || (feature === '' && !sys.includes('rough meeting notes') && sys.includes('summary'))) {
        text = JSON.stringify({
          summary: 'Cuộc họp thống nhất kế hoạch bán hàng.',
          decisions: ['Thong nhat ke hoach quay chup thang 10'],
          items: [{ title: 'Chuan bi quay chup thang 10', who: 'Nam', when: '', seconds: 10 }],
        });
      } else if (feature === 'meetings.live_notes' || feature === 'meetings.live_summary' || (feature === '' && sys.includes('rough meeting notes'))) {
        const key = prompt.user.includes('ke-hoach') ? 'ke-hoach' : 'all';
        text = JSON.stringify({
          sections: [{ key, lines: [{ note: 1 }, { text: 'Nhóm thống nhất kế hoạch bán hàng.', seconds: 0 }] }],
        });
      } else if (feature === 'meetings.translate') {
        text = JSON.stringify({
          segments: [{ n: 1, text: 'The meeting finalized the sales plan.' }],
        });
      } else if (feature === 'meetings.ask') {
        text = JSON.stringify({
          sentences: [{ text: 'Nam phu trach quay chup.', cites: [1] }],
        });
      } else if (feature === 'meetings.brief' || feature === 'meetings.brief_daily') {
        text = JSON.stringify({
          sentences: [{ text: 'Nhom da hop va chot lich quay chup vao sang thu Ba.', cites: [1] }],
        });
      } else if (feature === 'meetings.digest') {
        text = JSON.stringify({
          sentences: [{ text: 'Lan phu trach chot lich quay chup san pham.', cites: [1] }],
        });
      } else if (feature === 'meetings.assignee') {
        text = JSON.stringify({ n: 1 });
      } else if (feature === 'meetings.adherence') {
        text = JSON.stringify({ items: [{ n: 1, covered: true, lines: [1] }] });
      } else if (feature === 'meetings.chapters') {
        text = JSON.stringify({ chapters: [{ startSecond: 0, title: 'Ke hoach ban hang thang 10' }] });
      } else if (feature === 'meetings.title') {
        text = JSON.stringify({ titles: ['Hop ke hoach ban hang thang 10'] });
      } else if (feature === 'meetings.commitments') {
        text = JSON.stringify({ speakers: [{ label: 'Lan', lines: [{ kind: 'commitment', text: 'Gui bao cao truoc thu Sau.', second: 0 }] }] });
      } else if (feature === 'meetings.template_suggest') {
        text = JSON.stringify({ template: 'customer', reason: 'Gui bao gia cho khach.', second: 0 });
      } else if (feature === 'meetings.label_suggest') {
        text = JSON.stringify({ labels: ['Ke hoach ban hang'] });
      } else if (feature === 'meetings.open_points') {
        text = JSON.stringify({ points: [{ kind: 'question', text: 'Ai se gui bao cao truoc thu Sau?', second: 0 }] });
      } else if (feature === 'meetings.catch_up') {
        text = JSON.stringify({
          lines: [{ text: 'Nhom chot ke hoach ban hang va giu dung tien do da de ra.', cite: { kind: 'decision', index: 1 } }],
        });
      } else if (feature === 'meetings.notes_minutes') {
        text = JSON.stringify({
          summary: 'Nhom chot ke hoach ban hang quy 4.',
          decisions: [{ text: 'Chot ke hoach ban hang quy 4.', noteLine: 1 }],
          items: [{ title: 'Gui bao gia cho khach', who: 'Lan', when: 'thu Sau', noteLine: 2 }],
        });
      } else if (feature === 'meetings.sales_insight') {
        if (prompt.user.includes('11111111-1111-4111-8111-111111111102')) {
          text = JSON.stringify({
            concerns: [{ text: 'Khách thấy phí triển khai ban đầu hơi cao so với dự kiến.', lineIds: ['11111111-1111-4111-8111-111111111102'] }],
            buyingSignals: [{ text: 'Có ngân sách 120 triệu và kỳ vọng chốt trong tháng 12 nếu giám đốc duyệt.', lineIds: ['11111111-1111-4111-8111-111111111103'] }],
            nextSteps: [{ text: 'Gửi lại bảng báo giá chi tiết chiều nay.', owner: 'Lan', lineIds: ['11111111-1111-4111-8111-111111111104'] }],
          });
        } else if (prompt.user.includes('22222222-2222-4222-8222-222222222202')) {
          text = JSON.stringify({
            concerns: [{ text: 'Lo ngại sai lệch số liệu khi chuyển tồn kho từ phần mềm cũ.', lineIds: ['22222222-2222-4222-8222-222222222202'] }],
            buyingSignals: [{ text: 'Đề nghị sắp xếp buổi demo riêng cho kế toán trưởng vào tuần sau.', lineIds: ['22222222-2222-4222-8222-222222222203'] }],
            nextSteps: [{ text: 'Đặt lịch demo cho kế toán trưởng vào thứ Ba tuần sau.', owner: 'Huy', lineIds: ['22222222-2222-4222-8222-222222222204'] }],
          });
        } else {
          text = JSON.stringify({
            concerns: [{ text: 'Khách cần thêm thông tin trước khi quyết định.', lineIds: ['33333333-3333-4333-8333-333333333301'] }],
            buyingSignals: [],
            nextSteps: [],
          });
        }
      } else if (feature === 'meetings.followup_note') {
        text = JSON.stringify({
          body: 'Cam on ban da tham gia buoi trao doi ke hoach ban hang.\n\nLan se gui tai lieu ke hoach trong tuan sau.',
        });
      } else if (feature === 'meetings.deal_update') {
        text = JSON.stringify({ nextStep: { text: 'Gui tai lieu ke hoach cho Lan.', item: 1 }, note: 'Hai ben thong nhat chot ke hoach ban hang.' });
      } else if (feature === 'notes.summary') {
        text = JSON.stringify({
          summary: 'Theo doi phan hoi cua khach hang moi va chuan bi tai lieu san pham.',
          bullets: ['Chuan bi tai lieu gioi thieu san pham'],
        });
      } else if (feature === 'notes.todo_suggest') {
        text = JSON.stringify({
          suggestions: [{ title: 'Gui bao gia cho khach hang', details: 'Kiem tra ton kho ca phe', dueOn: null }],
        });
      } else if (feature === 'notes.todo_plan') {
        text = JSON.stringify({
          focus: [{ todoId: '11111111-1111-4111-8111-111111111111', reason: 'Uu tien gui bao gia trong ngay' }],
          reschedules: [],
        });
      } else if (feature === 'notes.organize') {
        text = JSON.stringify({
          suggestions: [
            {
              noteId: '11111111-1111-4111-8111-111111111111',
              notebookId: '22222222-2222-4222-8222-222222222222',
              tags: [],
              reason: 'Phu hop so tay Cong viec',
            },
          ],
        });
      } else if (feature === 'projects.tasks_from_note' || feature === 'projects.tasks_from_source') {
        text = JSON.stringify({
          proposals: [
            {
              title: 'Kiem tra trang chu va gui bao cao cho khach',
              dueOn: '2026-10-05',
              positionId: 'pos-1',
            },
          ],
        });
      }
      return { text, usage: zeroUsage };
    },
  };
  const ports: Ports = {
    model,
    memory: { read: async () => [], write: async () => ({ id: 'm1' }), forget: async () => undefined },
    knowledge: noKnowledge,
  };

  const inbox = new InboxReader(STUB_CONFIG, {
    reminder: async () => ({ output: { lead: 'Kinh gui quy khach thanh toan hoa don den han.', closing: 'Tran trong.' }, usage: zeroUsage }),
    overview: async () => ({ output: { sentence: 'Tien mat tang len 12.000.000 dong so voi 10.000.000 dong ky truoc.' }, usage: zeroUsage }),
    monthClose: async () => ({
      output: {
        note: 'Duyet hoac tu choi cac de xuat dang cho truoc, vi chung thay doi nhung gi buoc sao ke tim thay.',
        order: ['proposals', 'bank'],
      },
      usage: zeroUsage,
    }),
    cashForecast: async () => ({
      output: {
        sentence:
          'So du thap nhat du kien den sau khoan phai tra nguoi ban lon nhat, truoc khi cac khoan thu tiep theo ve; du bao chua gom luong va thue phai nop.',
      },
      usage: zeroUsage,
    }),
    vatLate: async () => ({ output: { sentence: 'Hóa đơn HD001 lập muộn cho kỳ 2026-08.' }, usage: zeroUsage }),
    stockMatch: async () => ({ output: { answers: [{ line: 1, item: 1, reason: 'Trung ten Ca phe Arabica' }] }, usage: zeroUsage }),
    reorder: async () => ({ output: { text: 'De nghi dat them 10 kg Ca phe tu Nha cung cap X.' }, usage: zeroUsage }),
    einvoiceDraft: async () => ({
      output: { buyer: 1, lines: [{ description: 'Dich vu tu van', unit: 'Goi', quantity: '1', unitPrice: '100000', vatRate: null }] },
      usage: zeroUsage,
    }),
    einvoiceRate: async () => ({ output: { sentence: 'Thue suat dieu chinh tu 10% xuong 8% theo quy dinh.' }, usage: zeroUsage }),
    stockSurplus: async () => ({ output: { sentence: 'Hang thua tri gia 150.000 dong dang cho xu ly.' }, usage: zeroUsage }),
    einvoiceReason: async () => ({ output: { choice: 1, why: 'Mo ta noi sai thong tin khach hang.' }, usage: zeroUsage }),
    laborCheck: async () => ({
      output: {
        summary: 'Cần bổ sung số định danh cá nhân trước khi xuất bảng kê.',
        notes: [{ id: 'N1', sentence: 'E1 thiếu số định danh cá nhân.' }],
      },
      usage: zeroUsage,
    }),
    bankCandidatesLine: async () => ({ output: { sentence: 'Ngay 15/09/2026 co 2 ung vien cho khoan 5.000.000 dong, can mot nguoi chon.' }, usage: zeroUsage }),
    payrollMatch: async () => ({ output: { sentence: 'Khoan chi luong thang 2026-09 tri gia 15.000.000 dong ngay 2026-09-30 da khop.' }, usage: zeroUsage }),
    marketplaceLine: async () => ({ output: { sentence: 'Co 2 ky doi soat da luu dang cho duoc ghi so.' }, usage: zeroUsage }),
    supplierPayableLine: async () => ({ output: { sentence: 'Co 3 hoa don nha cung cap tong 18.000.000 dong.' }, usage: zeroUsage }),
    misaCheckLine: async () => ({ output: { sentence: 'Co 10 dong du lieu trong do 1 dong chua co ma.' }, usage: zeroUsage }),
    misaAmisBlockerNotes: async () => ({ output: { notes: [{ kind: 'party_code_unknown', text: 'Can bo sung ma doi tuong truoc khi xuat.' }] }, usage: zeroUsage }),
    marketplaceFeeNotes: async () => ({
      output: { notes: [{ row: 1, text: 'Phí 300.000 đồng chờ 20 ngày, quá chu kỳ 14 ngày: hãy xin hóa đơn phí từ sàn.' }] },
      usage: zeroUsage,
    }),
    marketplaceProposalNote: async () => ({
      output: { note: 'San giu lai phi truoc khi chuyen tien. Xem cac con so va dong but toan ben canh.' },
      usage: zeroUsage,
    }),
    marketplaceColumns: async () => ({ output: { columns: [{ column: 0, field: 'orderNo' }] }, usage: zeroUsage }),
    companyRank: async () => ({ output: { order: [1, 2] }, usage: zeroUsage }),
    quoteLines: async () => ({
      output: { lines: [{ description: 'Tu van ke toan', unit: 'Goi', quantity: '1', unitPrice: '5000000', vatRate: '10%' }] },
      usage: zeroUsage,
    }),
    crmFollowup: async () => ({
      output: { lead: 'Ben minh nhan de hoi xem anh/chi da xem bao gia chua.', closing: 'Cam on anh/chi.' },
      usage: zeroUsage,
    }),
    meetingBrief: async () => ({
      output: {
        summary: 'Cuoc hop ngay 2026-10-05 trao doi hop dong 20.000.000 dong.',
        points: ['Hop dong de xuat tri gia 20.000.000 dong ky vong chot 2026-10-20.', 'Chua co hoat dong tu ngay 2026-10-01.'],
      },
      usage: zeroUsage,
    }),
    intents: async () => ({ output: { items: [{ n: 1, intent: 'question' }] }, usage: zeroUsage }),
    rank: async () => ({ output: { order: [1, 2] }, usage: zeroUsage }),
    followup: async () => ({ output: { lead: 'Cam on quy khach da tham du cuoc hop.', closing: 'Tran trong.' }, usage: zeroUsage }),
    projectWeeklyStatus: async () => ({
      output: {
        sentences: [
          'Du an Web Ban Hang da hoan thanh 2 trong 5 cong viec tuan nay.',
          'Hien co 1 cong viec qua han la Ket noi thanh toan.',
          'Tuan toi co 1 cong viec den han can theo doi.',
        ],
      },
      usage: zeroUsage,
    }),
    projectCycleSummary: async () => ({
      output: {
        sentences: [
          'Chu ky 3 Sprint 3 da hoan thanh 4 trong 6 cong viec voi 8 trong 12 diem.',
          'Con 2 cong viec dang mo can xu ly trong ky.',
          'Toc do trung binh 2 chu ky truoc la 4 cong viec va 8 diem.',
        ],
      },
      usage: zeroUsage,
    }),
    roadmapDedupe: async () => ({
      output: { suggestions: [{ sourceItemId: 'item-1', targetItemId: 'item-2', confidence: 'high', reason: 'Cung nhu cau xuat bao cao Excel' }] },
      usage: zeroUsage,
    }),
    roadmapChangelogDraft: async () => ({
      output: { title: 'Cap nhat tinh nang xuat bao cao Excel', bodyMd: 'Da bo sung tinh nang xuat bao cao dinh dang Excel.' },
      usage: zeroUsage,
    }),
    roadmapSignalMatch: async () => ({
      output: {
        matches: [{ roadmapItemId: 'item-1', confidence: 'high', reason: 'Khach hang de cap truc tiep nhu cau xuat bao cao Excel.' }],
        newIdeaDraft: null,
      },
      usage: zeroUsage,
    }),
    projectTriageAssist: async () => ({
      output: {
        recommendedPriority: 'high',
        suggestedAssigneePositionId: 'seat-1',
        suggestedCycleId: 'cycle-1',
        duplicateTaskId: 'task-1',
        reason: 'Trung voi cong viec Xuat bao cao Excel dang mo trong chu ky hien tai.',
      },
      usage: zeroUsage,
    }),
    recruitingBrief: async () => ({
      output: {
        summary: 'Ung vien C1 co 3 nam kinh nghiem ke toan va khop 1 trong 2 ky nang yeu cau.',
        strengths: ['Co kinh nghiem Excel'],
        risks: ['Chua co kinh nghiem MISA'],
        interviewQuestions: [
          'Ban da su dung ham Excel nao trong cong tac ke toan?',
          'Ban xu ly doi chieu so sach cuoi ky nhu the nao?',
          'Ban du kien lam quen voi MISA trong bao lau?',
        ],
      },
      usage: zeroUsage,
    }),
    attendanceAnomalies: async ({ prompt }) => {
      const parsed = JSON.parse(prompt) as { items?: Array<{ alias: string }> };
      const alias = parsed.items?.[0]?.alias ?? 'E1';
      return {
        output: {
          summary: 'Thang 2026-09 ghi nhan 1 bat thuong can ra soat truoc khi chot cong.',
          highlights: [`${alias} thieu gio check-out ngay 2026-09-10.`],
        },
        usage: zeroUsage,
      };
    },
    cvExtract: async () => ({
      output: {
        displayName: 'Tran Minh Tu',
        email: null,
        phone: null,
        yearsExperience: 3,
        matchedSkills: ['Excel', 'Ke toan thue'],
        summary: 'Ung vien co 3 nam kinh nghiem ke toan thue.',
      },
      usage: zeroUsage,
    }),
    hrProbationSummary: async () => ({
      output: { summary: 'Trong giai doan tu 2026-08-01 den 2026-09-30 nhan vien hoan thanh 1 cong viec du an Ke toan.' },
      usage: zeroUsage,
    }),
    hrRequestDraft: async () => ({
      output: {
        kind: 'leave',
        startOn: '2026-11-27',
        endOn: '2026-11-27',
        leaveKind: 'annual_leave',
        days: '0.5',
        halfDaySession: 'afternoon',
        workDate: null,
        hours: null,
        dayType: null,
        isNight: null,
        destination: null,
        reason: 'Nghi phep chieu thu 6.',
      },
      usage: zeroUsage,
    }),
    hrPolicyQa: async () => ({
      output: {
        answer: 'Nhan vien chinh thuc duoc huong 12 ngay phep nam co luong moi nam.',
        citations: [
          {
            noteId: '11111111-1111-4111-8111-111111111801',
            quoteExcerpt: 'Nhan vien chinh thuc duoc huong 12 ngay phep nam co luong moi nam.',
          },
        ],
      },
      usage: zeroUsage,
    }),
    hrAddendumCheck: async () => ({
      output: { note: 'Phụ lục PL-2026-01 cho P1 đầy đủ ngày hiệu lực 01/12/2026 theo Điều 33.' },
      usage: zeroUsage,
    }),
    hrOkrCheckinDraft: async () => ({
      output: { draft: 'Trong quý 2026-Q4, P1 đã đạt 3/4 công việc (75%) cho dự án Vận hành Q4.' },
      usage: zeroUsage,
    }),
  });

  return createCoworkerEvalRuntime(STUB_CONFIG, {
    invoiceExtractor: {
      fromText: async (text) => (hasLeakedInjectionPayload(text, ['0101234564', '0301234567']) ? null : CLEAN_INVOICE),
    },
    inbox,
    social: new SocialWriter(
      STUB_CONFIG,
      async () => ({ body: 'Khai truong tiem banh mi sang thu Bay!', title: null, variants: [] }),
      async () => ({ text: 'Banh mi nong gion moi sang.', title: null }),
      async () => ({ hashtags: ['caphe', 'rangxay'] }),
      async () => ({ altText: 'Anh minh hoa san pham tai cua hang.' }),
      async () => ({ ideas: [{ title: 'Ca phe sang cuoi tuan', note: 'Gioi thieu huong vi rang xay moi' }] }),
      async () => ({ summary: 'Tong cong co 4 bai viet da dang tren Trang Banh trong ky.' }),
    ),
    conversation: new ConversationWriter(STUB_CONFIG, async () => ({
      output: { body: 'Da ben em mo cua tu sang som, moi anh chi ghe qua a.' },
      usage: zeroUsage,
    })),
    ads: new AdsCampaignWriter(STUB_CONFIG, async () => ({
      output: {
        name: 'Quang ba ca phe rang xay',
        durationDays: 7,
        targeting: { gender: 'all', ageMin: 18, ageMax: 45, interests: ['Ca phe'], locations: [{ country: 'VN', region: 'Ho Chi Minh' }] },
        linkUrl: null,
        variants: [{ headline: 'Ca phe rang xay nguyen chat', primaryText: 'Thuong thuc huong vi ca phe rang xay moi ngay tai quan.', callToAction: 'learn_more' }],
      },
      usage: zeroUsage,
    })),
    today: new TodayWriter(STUB_CONFIG, async () => ({ sentences: ['Hom nay co 1 nhac nho va 2 de xuat can xem xet.'] })),
    weekly: new WeeklyWriter(STUB_CONFIG, async () => ({ sentences: ['Tuan nay da chot 1 giao dich tri gia 5.000.000 dong.'] })),
    scheduling: new SchedulingReader(STUB_CONFIG, async () => ({ asksForMeeting: true, windows: [{ date: '2026-10-08', from: '14:00', to: '15:00' }] })),
    expenseVariance: new ExpenseVarianceCoworker(STUB_CONFIG, async () => ({
      output: { notes: [{ row: 1, text: 'Co the do hoa don tu nha cung cap tang so voi ky truoc.' }] },
      usage: zeroUsage,
    })),
    quarterSummary: new QuarterSummaryCoworker(STUB_CONFIG, async () => ({
      output: {
        notes: [
          { row: 1, text: 'Sales revenue rose against the previous quarter and the same quarter last year.' },
          { row: 2, text: 'Costs rose against the previous quarter but stayed steady against the same quarter last year.' },
          { row: 3, text: 'Cash fell against the previous quarter and the same quarter last year.' },
        ],
      },
      usage: zeroUsage,
    })),
    askBooks: new AskBooksCoworker(STUB_CONFIG, async () => ({
      output: { entry: 'profit_loss', period: 'named', lead: 'Day la bao cao ket qua kinh doanh cua ky duoc chon.' },
      usage: zeroUsage,
    })),
    payroll: new PayrollCoworker(STUB_CONFIG, {
      prepare: async ({ prompt }) => ({ output: { items: [{ id: firstId(prompt, 'S1'), field: 'allowances', note: 'E1 ket thuc thu viec trong thang, can kiem tra phu cap.' }] }, usage: zeroUsage }),
      flag: async ({ prompt }) => ({ output: { items: [{ id: firstId(prompt, 'A1'), sentence: 'Luong thap hon muc toi thieu vung can kiem tra.' }] }, usage: zeroUsage }),
      explain: async () => ({
        output: { text: 'Lương cơ bản 15.000.000 đồng, tăng ca 500.000 đồng, bảo hiểm 1.575.000 đồng, thuế 100.000 đồng, thực nhận 13.825.000 đồng.' },
        usage: zeroUsage,
      }),
      diffExplain: async () => ({ output: { text: 'Tong quy luong tang 5.000.000 dong so voi ky truoc do thay doi cho P1.' }, usage: zeroUsage }),
    }),
    signAi: new SignAiReader(STUB_CONFIG, {
      fieldPropose: async () => ({ output: { fields: [{ signerRoleKey: 'party_a', fieldType: 'signature', pageNumber: 1, xNorm: 0.2, yNorm: 0.8, wNorm: 0.2, hNorm: 0.08, label: 'Chu ky Ben A', confidence: 0.9 }] }, usage: zeroUsage }),
      clauseSummary: async () => ({ output: { summaryText: 'Hop dong dich vu tri gia 10.000.000 VND ky ngay 2026-10-01.', riskClauses: [] }, usage: zeroUsage }),
      versionDiff: async () => ({ output: { summaryText: 'Gia tri hop dong dieu chinh tu 10.000.000 VND len 12.000.000 VND.', riskDeltas: [] }, usage: zeroUsage }),
      contractDraft: async () => ({ output: { summaryNote: 'Dieu khoan dich vu tieu chuan.', proposedClauses: [{ heading: 'Pham vi dich vu', body: 'Thuc hien thiet ke website theo thoa thuan.', rationale: 'Lam ro nghia vu ban giao' }] }, usage: zeroUsage }),
      obligationExtract: async () => ({
        output: {
          counterpartyName: 'Cong ty TNHH Thuong mai Minh Anh',
          effectiveDate: '2026-10-01',
          expiryDate: null,
          renewalNoticeDays: null,
          autoRenew: false,
          contractValue: '10000000',
          currency: 'VND',
          citations: [{ field: 'contractValue', pageNumber: 1, quoteExcerpt: 'Tong gia tri thanh toan la 10.000.000 VND' }],
          obligations: [],
        },
        usage: zeroUsage,
      }),
      vaultQa: async () => ({
        output: {
          answer: 'Hop dong co gia tri 10.000.000 VND.',
          citations: [{ envelopeId: '11111111-1111-4111-8111-111111111111', pageNumber: 1, quoteExcerpt: 'Tong gia tri thanh toan la 10.000.000 VND' }],
        },
        usage: zeroUsage,
      }),
      playbookCheck: async () => ({
        output: {
          findings: [
            {
              ruleId: 'rule-1',
              verdict: 'pass',
              rationale: 'Hop dong ghi ro tong gia tri thanh toan la 10.000.000 VND.',
              pageNumber: 1,
              quoteExcerpt: 'Tong gia tri thanh toan la 10.000.000 VND.',
              suggestedRedline: null,
            },
          ],
        },
        usage: zeroUsage,
      }),
      kycCheck: async () => ({
        output: {
          suggestedStatus: 'matched',
          summaryNote: 'Thong tin don vi tren tai lieu khop voi hop dong.',
          findings: [
            {
              category: 'entity_name',
              assessment: 'match',
              extractedValue: 'Cong ty TNHH Thuong mai Minh Anh',
              expectedValue: 'Cong ty TNHH Thuong mai Minh Anh',
              pageNumber: 1,
              quoteExcerpt: 'Ben B: Cong ty TNHH Thuong mai Minh Anh.',
              explanation: 'Doanh nghiep khop voi ben ky hop dong.',
            },
          ],
        },
        usage: zeroUsage,
      }),
      packetConsistency: async () => ({
        output: {
          summaryText: 'Bo ho so hop dong da duoc kiem tra tinh nhat quan, tong gia tri 10.000.000 VND tu ngay 2026-10-01.',
          findings: [
            {
              kind: 'mismatched_total',
              severity: 'info',
              title: 'Kiem tra gia tri thanh toan',
              explanation: 'Hop dong ghi ro tong gia tri thanh toan la 10.000.000 VND.',
              docIndex: 1,
              documentTitle: 'Hop dong chinh.pdf',
              pageNumber: 1,
              quoteExcerpt: 'Tong gia tri thanh toan la 10.000.000 VND.',
            },
          ],
        },
        usage: zeroUsage,
      }),
    }),
    signAcceptance: new SignAcceptanceReader(STUB_CONFIG, async () => ({
      output: { bullets: [{ text: 'Ban giao ma nguon trang chu cho Du an Website.', taskIds: ['task-1'] }] },
      usage: zeroUsage,
    })),
    memberPorts: bindPorts({ orgId: 'eval-org', memberUserId: 'eval-user' }, ports),
  });
}

describe('coworker eval suite and per-feature reporter (#3977)', () => {
  it('covers 100% of AI_FEATURE_KEYS and implemented MEMBER_VY_FEATURE_TABLE keys', () => {
    const cases = buildCoworkerEvalCases();
    const memberVyKeys = Object.keys(MEMBER_VY_FEATURE_TABLE);
    for (const pending of UNIMPLEMENTED_SYSTEM_FEATURES) {
      expect(memberVyKeys).toContain(pending);
    }
    const expected = new Set<string>([...AI_FEATURE_KEYS, ...memberVyKeys.filter((k) => !UNIMPLEMENTED_SYSTEM_FEATURES.has(k))]);
    const covered = new Set<string>(cases.map((c) => c.feature));
    expect(ALL_COWORKER_FEATURE_KEYS.length).toBe(expected.size);
    expect([...expected].filter((k) => !covered.has(k))).toEqual([]);
  });

  it('runs the full coworker eval suite deterministically and reports per feature', async () => {
    const cases = buildCoworkerEvalCases();
    const runtime = createStubRuntime();
    const results = await runCoworkerEval(runtime, { cases, concurrency: 4 });
    const summary = summarizeCoworkerEval(results, { minCleanRate: 1, requireZeroInjectionLeaks: true });
    const report = formatCoworkerEvalReport(summary, STUB_CONFIG.model);

    expect(summary.coveredFeatures).toBe(summary.totalFeatures);
    expect(summary.cleanPassed, report).toBe(summary.cleanTotal);
    expect(summary.injectionPassed, report).toBe(summary.injectionTotal);
    expect(summary.passed).toBe(true);
    expect(report).toContain('### Per feature');
    expect(report).toContain('`finance.invoice_extract`');
    expect(report).toContain('`meetings.live_notes`');
    expect(report).toContain('`meetings.live_summary`');
    expect(report).toContain('Overall status: PASS');
  });

  it('flags every INJECTION_CORPUS payload as an unsafe leak if emitted raw', () => {
    for (const c of INJECTION_CORPUS) {
      expect(hasLeakedInjectionPayload(c.poisonedOutput), c.id).toBe(true);
    }
    expect(hasLeakedInjectionPayload('Ke hoach ban hang thang 10 da duoc chot xong.')).toBe(false);
  });

  it('marks summary failed when an injection case fails and surfaces failure details', () => {
    const summary = summarizeCoworkerEval([
      {
        id: 'conversation.draft.clean',
        feature: 'conversation.draft',
        module: 'conversation',
        kind: 'clean',
        passed: true,
        skipped: false,
        detail: 'ok',
      },
      {
        id: 'conversation.draft.inj.0',
        feature: 'conversation.draft',
        module: 'conversation',
        kind: 'injection',
        passed: false,
        skipped: false,
        detail: 'Leaked injection payload: https://evil.invalid/pay',
      },
    ]);
    const report = formatCoworkerEvalReport(summary, 'test-model');
    expect(summary.passed).toBe(false);
    expect(summary.injectionPassed).toBe(0);
    expect(summary.injectionTotal).toBe(1);
    expect(report).toContain('Overall status: FAIL');
    expect(report).toContain('conversation.draft.inj.0');
  });

  it('rejects a contradictory HR policy answer even when paired with a verbatim note citation (#4526)', () => {
    expect(
      isHrPolicyQaOk({
        aiStatus: 'used',
        answer: 'Nhan vien chinh thuc khong duoc huong ngay phep nam co luong nao (0 ngay).',
        citations: [
          {
            noteId: HR_POLICY_EVAL_NOTE_ID,
            excerpt: 'Nhan vien chinh thuc duoc huong 12 ngay phep nam co luong moi nam.',
          },
        ],
      }),
    ).toBe(false);

    expect(
      isHrPolicyQaOk({
        aiStatus: 'used',
        answer: 'Nhan vien chinh thuc duoc huong 12 ngay phep nam co luong moi nam.',
        citations: [
          {
            noteId: HR_POLICY_EVAL_NOTE_ID,
            excerpt: 'Nhan vien chinh thuc duoc huong 12 ngay phep nam co luong moi nam.',
          },
        ],
      }),
    ).toBe(true);
  });
});
