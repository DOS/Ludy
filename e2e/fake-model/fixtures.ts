// SPDX-License-Identifier: AGPL-3.0-only
// The answers of the fake model for the member-Vy features of the meetings line (#4050): title (#3947), commitments (#3954), agenda adherence (#3959), the weekly digest (#3949) and the brief (#3543, shown on the
// Today view, #3955). The fake model is a mock of a model, not of the app: every answer is written the way a real model could write it, and every one holds BOTH sentences the app's checks keep and ones they
// must drop (an invented figure, an email address, a link, a line the speaker did not say, a citation of a line that is not there), so a spec that shows the kept ones and counts the dropped ones proves the
// checks ran on this answer. This file imports nothing: the container of the fake model mounts this directory and nothing else.
//
// A request is routed on a phrase of the feature's instruction (the system message); any other request keeps the fixed summary of server.ts. A spec picks what the model says by writing a SCENARIO TOKEN into the
// data it stores (a transcript line, a typed agenda line, a decision): "[fake:bad]" makes every part of the answer one the checks drop, "[fake:garbage]" makes it text that is not the JSON asked for, and
// "[fake:down]" makes the service answer HTTP 500. Without a token the answer is the default one below. tools/test/fake-model.test.ts runs every answer through the product's own checks.

// The three-line transcript every spec stores (e2e/lib/meetings-seed.ts) and every answer below is written for: lines at 0 to 10, 10 to 20 and 20 to 30 seconds, no digit in them, the speakers Hà and Nam.
export const TRANSCRIPT: ReadonlyArray<{ from: number; to: number; who: string; said: string }> = [
  { from: 0, to: 10, who: 'Hà', said: 'Chúng ta chốt giá cũ cho khách A.' },
  { from: 10, to: 20, who: 'Nam', said: 'Em sẽ gửi báo giá vào thứ sáu.' },
  { from: 20, to: 30, who: 'Hà', said: 'Được, họp tiếp tuần sau.' },
];

export type Route = 'title' | 'commitments' | 'adherence' | 'digest' | 'brief';
export type Scenario = 'default' | 'bad' | 'garbage' | 'down';

// A phrase of each feature's instruction, copied from the first line of its INSTRUCTION in packages/agent/src/member-vy; tools/test/fake-model.test.ts fails when a source stops holding its phrase, so the
// route cannot silently fall back to the fixed summary.
export const ROUTE_MARKERS: Readonly<Record<Route, string>> = {
  title: 'You suggest a title for one meeting',
  commitments: 'You list what each speaker of one meeting said they would do',
  adherence: 'check whether the meeting covered its agenda',
  digest: 'look back on the week',
  brief: 'You prepare a person who is about to go into a meeting',
};

export const SCENARIO_TOKENS: Readonly<Record<Exclude<Scenario, 'default'>, string>> = { bad: '[fake:bad]', garbage: '[fake:garbage]', down: '[fake:down]' };

export function routeOf(system: string): Route | null {
  for (const route of Object.keys(ROUTE_MARKERS) as Route[]) if (system.includes(ROUTE_MARKERS[route])) return route;
  return null;
}

export function scenarioOf(subject: string): Scenario {
  for (const scenario of Object.keys(SCENARIO_TOKENS) as Array<Exclude<Scenario, 'default'>>) if (subject.includes(SCENARIO_TOKENS[scenario])) return scenario;
  return 'default';
}

// The data of a feature run, as runFeature hands it to the model: <subject-NONCE>\n...\n</subject-NONCE> in the user message.
export function subjectOf(user: string): string {
  return /<subject-([0-9a-f]+)>\n([\s\S]*?)\n<\/subject-\1>/.exec(user)?.[2] ?? '';
}

// What a model that is not following the format writes: no JSON object in it at all.
export const GARBAGE = 'Xin lỗi, tôi không thể giúp việc này.';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function dataOf(subject: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(subject);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
const listOf = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.filter(isRecord) : []);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// title: the transcript the specs store has no digit and the speakers Hà and Nam (e2e/lib/meetings-seed.ts).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const TITLES_DEFAULT = [
  'Chốt giá cũ cho khách A', // kept
  'Chốt giá cũ cho khách A', // a repeat: dropped
  'Báo giá 2.500.000 đồng cho khách A', // a figure the transcript does not write: dropped
  'Liên hệ nam@example.com để nhận báo giá', // an address: dropped
  'Gửi báo giá cho khách A vào thứ sáu', // kept
];
// Every candidate is one the checks drop: a repeat-free list of an address, a figure and a text too short.
const TITLES_BAD = ['Liên hệ nam@example.com', 'Giá 2.500.000 đồng', 'Ab'];

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// commitments: lines of Hà (seconds 0 and 20) and Nam (second 10).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const COMMITMENTS_DEFAULT = [
  {
    label: 'Hà',
    lines: [
      { kind: 'decision', text: 'Giữ giá cũ cho khách A', second: 0 }, // kept
      { kind: 'commitment', text: 'Họp tiếp vào tuần sau', second: 20 }, // kept
    ],
  },
  {
    label: 'Nam',
    lines: [
      { kind: 'commitment', text: 'Gửi báo giá cho khách A vào thứ sáu', second: 10 }, // kept
      { kind: 'commitment', text: 'Gửi báo giá 3.000.000 đồng cho khách A', second: 10 }, // a figure that line does not write: dropped
      { kind: 'commitment', text: 'Chốt giá cũ cho khách A', second: 0 }, // a second Nam has no line at (it is Hà's): dropped
    ],
  },
  // A speaker the transcript does not have: dropped.
  { label: 'Lan', lines: [{ kind: 'commitment', text: 'Gọi lại cho khách A', second: 10 }] },
];
// Every line is one the checks drop.
const COMMITMENTS_BAD = [
  { label: 'Nam', lines: [{ kind: 'commitment', text: 'Gửi báo giá 3.000.000 đồng', second: 10 }, { kind: 'commitment', text: 'Chốt giá cũ', second: 0 }] },
  { label: 'Lan', lines: [{ kind: 'commitment', text: 'Gọi lại cho khách A', second: 10 }] },
];

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// adherence: the answer follows the agenda lines it is given, by what each line says (a rule a spec can read: a line naming a price is covered by the line of the transcript that does; a line naming a party is
// "covered" with a citation of a line that is not there; anything else is not covered).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
function adherenceAnswer(subject: string, scenario: Scenario): string {
  const data = dataOf(subject);
  const agenda = listOf(data.agenda);
  const transcript = listOf(data.transcript);
  const priceLine = transcript.findIndex((line) => typeof line.text === 'string' && line.text.includes('giá')) + 1;
  const items = agenda.map((entry, index) => {
    const n = typeof entry.n === 'number' ? entry.n : index + 1;
    const text = typeof entry.text === 'string' ? entry.text : '';
    if (scenario === 'bad') return { n, covered: true, lines: [transcript.length + 40] };
    if (text.includes('giá') && priceLine > 0) return { n, covered: true, lines: [priceLine] };
    if (text.includes('tiệc')) return { n, covered: true, lines: [transcript.length + 40] }; // cites a line that is not there: shown as "not heard"
    return { n, covered: false, lines: [] };
  });
  return JSON.stringify({ items });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// digest and brief: sentences over the numbered facts. The first fact of kind "decision" (else the first fact) is the one the kept sentence cites and quotes.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
function sentencesAnswer(subject: string, scenario: Scenario): string {
  const facts = listOf(dataOf(subject).facts);
  const first = facts.find((fact) => fact.kind === 'decision') ?? facts[0];
  const n = typeof first?.n === 'number' ? first.n : 1;
  const text = typeof first?.text === 'string' ? first.text : '';
  const dropped = [
    { text: 'Tổng giá trị các thỏa thuận là 999.000.000 đồng.', cites: [n] }, // a figure no cited fact writes
    { text: 'Xem chi tiết tại https://example.com/bao-gia.', cites: [n] }, // a link, never allowed
    { text: 'Khách đã đồng ý với mọi điều khoản.', cites: [999] }, // a citation of a fact that is not there
  ];
  if (scenario === 'bad') return JSON.stringify({ sentences: dropped });
  return JSON.stringify({ sentences: [{ text: `Đã chốt: ${text}`, cites: [n] }, ...dropped] });
}

/** What the model "writes" for one request: the answer text, or null when the scenario is a failed request (HTTP 500). */
export function answerFor(route: Route, subject: string, scenario: Scenario): string | null {
  if (scenario === 'down') return null;
  if (scenario === 'garbage') return GARBAGE;
  switch (route) {
    case 'title':
      return JSON.stringify({ titles: scenario === 'bad' ? TITLES_BAD : TITLES_DEFAULT });
    case 'commitments':
      return JSON.stringify({ speakers: scenario === 'bad' ? COMMITMENTS_BAD : COMMITMENTS_DEFAULT });
    case 'adherence':
      return adherenceAnswer(subject, scenario);
    case 'digest':
    case 'brief':
      return sentencesAnswer(subject, scenario);
  }
}
