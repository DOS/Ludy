// SPDX-License-Identifier: AGPL-3.0-only
// The README's pictures and numbers, computed from this repository (owner request, 2026-11-12).
//
//   node tools/readme-assets.mjs            writes docs/assets/readme/*.svg (light and dark) and apps/web/src/content/stats.ts, and prints the numbers
//   node tools/readme-assets.mjs --check    exits 1 when the committed SVGs differ from what the repository gives now
//
// Nothing here is typed in by hand but wording: every number comes from counting files, calling the registries or reading a roster, so the
// README cannot drift from the code without `--check` saying so. The colours are the landing page's tokens (apps/web/src/app/globals.css).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs/assets/readme');
const CHECK = process.argv.includes('--check');

// ---------------------------------------------------------------------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------------------------------------------------------------------
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const tracked = git('ls-files').split('\n').filter(Boolean);

// The commands and queries the kernel registers when every module is on: the arrays the kernel itself passes to `Runtime.register`.
// Run from apps/kernel so the workspace packages resolve, as the kernel's own tests do.
function registries() {
  const modules = readdirSync(join(ROOT, 'modules'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const script = `
    import { buildKernelCommands, kernelQueries } from '@crove/kernel';
    const modules = ${JSON.stringify(modules)};
    const rows = [['kernel', buildKernelCommands({ inboundDomain: null }).length, kernelQueries({ inboundDomain: null }).length]];
    for (const m of modules) {
      const pkg = await import('@crove/mod-' + m);
      rows.push([m, pkg[m + 'Commands'].length, pkg[m + 'Queries'].length]);
    }
    console.log(JSON.stringify(rows));`;
  const out = execFileSync('node', ['--input-type=module', '-e', script], { cwd: join(ROOT, 'apps/kernel'), encoding: 'utf8' });
  return { modules, rows: JSON.parse(out.trim().split('\n').pop()) };
}

function stats() {
  const { modules, rows } = registries();
  const commands = rows.reduce((n, r) => n + r[1], 0);
  const queries = rows.reduce((n, r) => n + r[2], 0);
  const migrations = tracked.filter((f) => /^supabase\/migrations\/.+\.sql$/.test(f)).length;
  const adrs = tracked.filter((f) => /^docs\/adr\/\d{4}-.+\.md$/.test(f)).length;
  // Every file of an invariant directory that holds tests, plus the pgTAP gate files (`_*.test.sql`).
  const invariantSuites = tracked.filter((f) => /\/test\/invariant\/[^/]+\.test\.tsx?$/.test(f) || /^supabase\/tests\/database\/_[^/]*\.test\.sql$/.test(f)).length;
  // One `it(` or `test(` per case; a table-driven case (`it.each`) counts once, so the real number of runs is higher.
  const testCases = Number(git('grep', '-hEc', '^\\s*(it|test)(\\.each\\([^)]*\\))?\\(', '--', '*.test.ts', '*.test.tsx').split('\n').reduce((n, l) => n + (Number(l) || 0), 0));
  const roster = readFileSync(join(ROOT, 'apps/web/src/content/roster.ts'), 'utf8');
  // A coworker is on the roster with a scope only when it has shipped work (DESIGN.md 6.2).
  const coworkers = [...roster.matchAll(/^\s{2}(gm|finance|sales|marketing|system):\s*\{[^}]*?name:\s*'([^']+)'[\s\S]*?(?=^\s{2}(?:gm|finance|sales|marketing|system):|^\};)/gm)].filter((m) => /scope:/.test(m[0])).map((m) => m[2]);
  const mcpTools = (readFileSync(join(ROOT, 'apps/kernel/src/mcp-endpoint.ts'), 'utf8').match(/name: 'ludy_[a-z_]+'/g) ?? []).length;
  const languages = readdirSync(join(ROOT, 'apps/app/src/i18n/messages')).filter((f) => /^[a-z]{2}\.ts$/.test(f)).length;
  const tsLines = Number(execFileSync('sh', ['-c', "git ls-files '*.ts' '*.tsx' | xargs cat | wc -l"], { cwd: ROOT, encoding: 'utf8' }).trim());
  return { modules, commands, queries, migrations, adrs, invariantSuites, testCases, coworkers, mcpTools, languages, tsLines };
}

const fmt = (n) => n.toLocaleString('en-US');
const round = (n, step) => Math.floor(n / step) * step;

// ---------------------------------------------------------------------------------------------------------------------------------------
// Colours: the landing page's tokens, converted from oklch to sRGB hex
// ---------------------------------------------------------------------------------------------------------------------------------------
function oklch(l, c, h) {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_];
  const enc = (x) => {
    const v = Math.min(1, Math.max(0, x));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return '#' + lin.map((x) => Math.round(enc(x) * 255).toString(16).padStart(2, '0')).join('');
}

const THEMES = {
  light: {
    bg: oklch(0.985, 0.003, 290), surface: oklch(1, 0, 0), surface2: oklch(0.965, 0.005, 290), fg: oklch(0.2, 0.02, 285), muted: oklch(0.45, 0.016, 285),
    subtle: oklch(0.53, 0.014, 285), line: oklch(0.915, 0.007, 290), lineStrong: oklch(0.72, 0.012, 290), accent: oklch(0.49, 0.22, 290),
    accentSoft: oklch(0.95, 0.03, 293), ok: oklch(0.47, 0.085, 172), okSoft: oklch(0.95, 0.025, 172), spark: oklch(0.583, 0.105, 177.1), onAccent: '#ffffff',
  },
  dark: {
    bg: oklch(0.155, 0.008, 285), surface: oklch(0.19, 0.01, 285), surface2: oklch(0.225, 0.012, 285), fg: oklch(0.97, 0.003, 285), muted: oklch(0.75, 0.012, 285),
    subtle: oklch(0.66, 0.012, 285), line: oklch(0.285, 0.012, 285), lineStrong: oklch(0.46, 0.015, 285), accent: oklch(0.75, 0.13, 293),
    accentSoft: oklch(0.3, 0.06, 293), ok: oklch(0.8, 0.1, 172), okSoft: oklch(0.29, 0.045, 172), spark: oklch(0.646, 0.119, 175.1), onAccent: oklch(0.17, 0.03, 290),
  },
};

const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A small SVG toolkit: everything is drawn on a W by H canvas with the theme's colours; text is plain and never wider than its box.
function svg(w, h, title, desc, body, t) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="t d" font-family="${esc(FONT)}">
<title id="t">${esc(title)}</title><desc id="d">${esc(desc)}</desc>
<rect width="${w}" height="${h}" rx="16" fill="${t.bg}"/>
${body}
</svg>
`;
}
const text = (x, y, s, { size = 14, weight = 400, fill, anchor = 'start' }) => `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
const box = (x, y, w, h, { fill, stroke, dash, r = 12, sw = 1.5 }) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke ?? 'none'}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const line = (d, stroke, { dash, sw = 1.5 } = {}) => `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linecap="round" stroke-linejoin="round"/>`;
const arrow = (x1, y, x2, stroke) => `${line(`M${x1} ${y}H${x2 - 6}`, stroke, { sw: 2 })}<path d="M${x2} ${y}l-8 -5v10z" fill="${stroke}"/>`;
const chip = (x, y, s, { fill, color, w }) => {
  const width = w ?? s.length * 6.6 + 18;
  return `${box(x, y, width, 22, { fill, r: 11 })}${text(x + width / 2, y + 15, s, { size: 12, weight: 600, fill: color, anchor: 'middle' })}`;
};
const avatar = (cx, cy, letter, t, { dashed } = {}) =>
  `<circle cx="${cx}" cy="${cy}" r="18" fill="${t.accentSoft}" stroke="${t.accent}" stroke-width="1.5"${dashed ? ' stroke-dasharray="3 3"' : ''}/>${text(cx, cy + 6, letter, { size: 17, weight: 700, fill: t.accent, anchor: 'middle' })}`;

// 1. The team: the landing page's org chart. The owner approves; Vy leads; one coworker per area, each proposing and never deciding.
function hero(t) {
  const W = 880;
  const H = 392;
  const node = (x, y, w, h, name, role, scope, letter, { agent = true, chipText } = {}) =>
    `${box(x, y, w, h, { fill: t.surface, stroke: agent ? t.accent : t.lineStrong, dash: agent ? '5 4' : undefined })}${avatar(x + 32, y + 36, letter, t, { dashed: agent })}` +
    text(x + 60, y + 32, name, { size: 16, weight: 700, fill: t.fg }) + text(x + 60, y + 50, role, { size: 12, fill: t.subtle }) +
    text(x + 16, y + 82, scope[0], { size: 13, fill: t.muted }) + (scope[1] ? text(x + 16, y + 100, scope[1], { size: 13, fill: t.muted }) : '') +
    (chipText ? chip(x + 16, y + h - 34, chipText, { fill: t.okSoft, color: t.ok }) : '');
  const cardW = 252;
  const y2 = 218;
  const xs = [28, 28 + cardW + 24, 28 + (cardW + 24) * 2];
  return svg(W, H, 'Your Ludy team', 'You approve. Vy coordinates. Ly reads invoices, Dy handles customers and sales, Uy drafts posts. The AI proposes, you decide.', [
    text(W / 2, 38, 'Your team: you decide, the AI coworkers do the work', { size: 20, weight: 700, fill: t.fg, anchor: 'middle' }),
    // owner and Vy
    box(W / 2 - 372, 62, 292, 74, { fill: t.surface, stroke: t.lineStrong }),
    avatar(W / 2 - 340, 99, 'You', t).replace('font-size="17"', 'font-size="12"'),
    text(W / 2 - 312, 94, 'You', { size: 16, weight: 700, fill: t.fg }), text(W / 2 - 312, 112, 'Owner. Approves money and messages.', { size: 11.5, fill: t.subtle }),
    node(W / 2 + 80, 62, 250, 108, 'Vy', 'General manager (AI)', ['Coordinates the team,', 'across every app'], 'V'),
    line(`M${W / 2 - 80} 99H${W / 2 + 80}`, t.lineStrong, { sw: 2 }),
    chip(W / 2 - 54, 76, 'you approve', { fill: t.okSoft, color: t.ok, w: 108 }),
    // connectors Vy -> three
    line(`M${W / 2 + 205} 170V196H${xs[1] + cardW / 2}V${y2}`, t.lineStrong, { sw: 1.5 }),
    line(`M${W / 2 + 205} 196H${xs[0] + cardW / 2}V${y2}`, t.lineStrong, { sw: 1.5 }),
    line(`M${W / 2 + 205} 196H${xs[2] + cardW / 2}V${y2}`, t.lineStrong, { sw: 1.5 }),
    node(xs[0], y2, cardW, 146, 'Ly', 'Accounting (AI)', ['Reads invoices, drafts the', 'journal entry for you'], 'L', { chipText: 'checked by rules, then you' }),
    node(xs[1], y2, cardW, 146, 'Dy', 'Sales and customers (AI)', ['The Inbox, your customers', 'and your sales'], 'D', { chipText: 'drafts, you send' }),
    node(xs[2], y2, cardW, 146, 'Uy', 'Marketing (AI)', ['Drafts and schedules', 'your posts'], 'U', { chipText: 'you publish' }),
  ].join('\n'), t);
}

// 2. The flow the product exists for.
function flow(t) {
  const W = 880;
  const H = 214;
  const steps = [
    { title: 'Drop it in', lines: ['An e-invoice, a PDF,', 'a photo, or an email'], kind: 'you' },
    { title: 'AI reads it', lines: ['Fields and lines,', 'with your own AI'], kind: 'ai' },
    { title: 'Rules check', lines: ['Totals, VAT, tax', 'code, duplicates'], kind: 'rules' },
    { title: 'You approve', lines: ['Fix an account,', 'then say yes'], kind: 'you' },
    { title: 'Books done', lines: ['A balanced entry,', 'ready for Excel'], kind: 'done' },
  ];
  const bw = 148;
  const gap = (W - 56 - bw * 5) / 4;
  const parts = [text(W / 2, 38, 'From a pile of invoices to books you can hand your accountant', { size: 20, weight: 700, fill: t.fg, anchor: 'middle' })];
  steps.forEach((s, i) => {
    const x = 28 + i * (bw + gap);
    const y = 66;
    const stroke = s.kind === 'ai' ? t.accent : s.kind === 'done' ? t.ok : t.lineStrong;
    const fill = s.kind === 'done' ? t.okSoft : t.surface;
    parts.push(box(x, y, bw, 112, { fill, stroke, dash: s.kind === 'ai' ? '5 4' : undefined }));
    parts.push(`<circle cx="${x + 24}" cy="${y + 26}" r="13" fill="${s.kind === 'done' ? t.ok : t.accent}"/>` + text(x + 24, y + 31, String(i + 1), { size: 14, weight: 700, fill: t.onAccent, anchor: 'middle' }));
    parts.push(text(x + 46, y + 31, s.title, { size: 15, weight: 700, fill: t.fg }));
    parts.push(text(x + 14, y + 62, s.lines[0], { size: 12.5, fill: t.muted }), text(x + 14, y + 80, s.lines[1], { size: 12.5, fill: t.muted }));
    parts.push(chip(x + 14, y + 90, s.kind === 'ai' ? 'AI proposes' : s.kind === 'rules' ? 'fixed rules' : s.kind === 'done' ? 'yours' : 'you', { fill: s.kind === 'ai' ? t.accentSoft : s.kind === 'done' ? t.surface : t.surface2, color: s.kind === 'ai' ? t.accent : s.kind === 'done' ? t.ok : t.muted, w: s.kind === 'rules' ? 84 : s.kind === 'ai' ? 96 : 58 }));
    if (i < 4) parts.push(arrow(x + bw + 4, y + 56, x + bw + gap - 4, t.lineStrong));
  });
  parts.push(text(W / 2, 204, 'The AI only proposes. Every number is checked by fixed rules, and nothing is booked until a person approves.', { size: 13, fill: t.subtle, anchor: 'middle' }));
  return svg(W, H, 'Invoice to books in five steps', 'Drop an invoice, the AI reads it, rules check every number, you approve, and the books are done.', parts.join('\n'), t);
}

// 3. The numbers band.
function numbers(t, s) {
  const W = 880;
  const H = 292;
  const tiles = [
    [String(s.modules.length), 'modules', 'on one shared kernel'],
    [fmt(s.commands + s.queries), 'commands + queries', `${fmt(s.commands)} + ${fmt(s.queries)}`],
    [fmt(s.migrations), 'database migrations', 'forward-only'],
    [`${fmt(round(s.testCases, 1000))}+`, 'test cases', 'run on every merge'],
    [fmt(s.invariantSuites), 'invariant test suites', 'tenancy, ledger, approvals'],
    [String(s.adrs), 'design decisions', 'each one written down'],
    [String(s.languages), 'app languages', 'Vietnamese and English'],
    [String(s.coworkers.length), 'AI coworkers', s.coworkers.join(', ')],
    [String(s.mcpTools), 'read-only MCP tools', 'for Claude and ChatGPT'],
    [`${round(s.tsLines, 10000) / 1000}k+`, 'lines of TypeScript', 'tests included'],
  ];
  const tw = (W - 56 - 4 * 14) / 5;
  const parts = [text(W / 2, 38, 'What is in the box, counted from the repository', { size: 20, weight: 700, fill: t.fg, anchor: 'middle' })];
  tiles.forEach(([n, label, sub], i) => {
    const x = 28 + (i % 5) * (tw + 14);
    const y = 62 + Math.floor(i / 5) * 98;
    const accent = i % 2 === 0 ? t.accent : t.ok;
    parts.push(box(x, y, tw, 86, { fill: t.surface, stroke: t.line }));
    parts.push(text(x + 14, y + 36, n, { size: 28, weight: 800, fill: accent }));
    parts.push(text(x + 14, y + 56, label, { size: 12.5, weight: 600, fill: t.fg }));
    parts.push(text(x + 14, y + 73, sub, { size: 11, fill: t.subtle }));
  });
  parts.push(text(W / 2, 280, 'How each number is counted: see "How these numbers are counted" in the README.', { size: 12, fill: t.subtle, anchor: 'middle' }));
  return svg(W, H, 'Ludy in numbers', 'Counts taken from the repository: modules, operations, migrations, tests, invariant suites, decisions, languages, AI coworkers, MCP tools.', parts.join('\n'), t);
}

// 4. The feature grid, with small line icons drawn here (24 by 24, stroke only).
const ICONS = {
  inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5',
  ledger: 'M5 4h14v16H5zM9 8h6M9 12h6M9 16h3',
  chart: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  mic: 'M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v4',
  chat: 'M4 5h16v11H9l-5 4z',
  note: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18',
};
function features(t) {
  const W = 880;
  const H = 376;
  const cards = [
    ['inbox', 'AI Inbox', 'The AI proposes. You approve, edit or reject.'],
    ['ledger', 'Accounting (TT133)', 'Entries that always balance, and period locks.'],
    ['chart', 'Tax and reports', 'VAT return working, B01 and B02, Excel.'],
    ['chat', 'Engage', 'Customers, sales and social posts in one place.'],
    ['calendar', 'Bookings', 'Booking pages, event types, working hours.'],
    ['mic', 'Meetings', 'Record meetings. AI notes and summaries are optional.'],
    ['note', 'Notes and to-dos', 'Personal notes and lists, with notifications.'],
    ['spark', 'Vy and the team', 'AI coworkers that propose; a person decides.'],
    ['shield', 'Private by design', 'Row-level isolation and an audit log.'],
    ['server', 'Yours to run', 'Open source (AGPL). One command to start, no cloud account.'],
  ];
  const cw = (W - 56 - 4 * 14) / 5;
  const parts = [text(W / 2, 38, 'Everything a small business does every month', { size: 20, weight: 700, fill: t.fg, anchor: 'middle' })];
  const wrap = (s, n) => {
    const out = [];
    let cur = '';
    for (const word of s.split(' ')) {
      if ((cur + ' ' + word).trim().length > n) { out.push(cur); cur = word; } else cur = (cur + ' ' + word).trim();
    }
    out.push(cur);
    return out;
  };
  cards.forEach(([icon, title, desc], i) => {
    const x = 28 + (i % 5) * (cw + 14);
    const y = 62 + Math.floor(i / 5) * 156;
    parts.push(box(x, y, cw, 144, { fill: t.surface, stroke: t.line }));
    parts.push(box(x + 14, y + 14, 36, 36, { fill: i % 2 === 0 ? t.accentSoft : t.okSoft, r: 10 }));
    parts.push(`<g transform="translate(${x + 20} ${y + 20})">${line(ICONS[icon], i % 2 === 0 ? t.accent : t.ok, { sw: 1.7 })}</g>`);
    parts.push(text(x + 14, y + 72, title, { size: 13.5, weight: 700, fill: t.fg }));
    wrap(desc, 21).forEach((l, k) => parts.push(text(x + 14, y + 90 + k * 15, l, { size: 11.5, fill: t.muted })));
  });
  return svg(W, H, 'What Ludy does', 'AI Inbox, accounting, tax reports, Engage, bookings, meetings, notes, AI coworkers, private by design, yours to run.', parts.join('\n'), t);
}

// ---------------------------------------------------------------------------------------------------------------------------------------
const s = stats();
const files = {};
for (const [name, theme] of Object.entries(THEMES)) {
  files[`team-${name}.svg`] = hero(theme);
  files[`flow-${name}.svg`] = flow(theme);
  files[`numbers-${name}.svg`] = numbers(theme, s);
  files[`features-${name}.svg`] = features(theme);
}

// The landing page's numbers band reads the same counts from a generated module, so the site and the README cannot disagree.
const STATS_TS = join(ROOT, 'apps/web/src/content/stats.ts');
const statsTs = `// SPDX-License-Identifier: AGPL-3.0-only
// GENERATED by tools/readme-assets.mjs from the repository's own files: do not edit by hand. \`node tools/readme-assets.mjs\` rewrites it and
// \`--check\` fails when it is out of date. Large counts are rounded down (test cases to the thousand, lines to the ten thousand), so the page
// never claims more than the repository holds; the README's "How these numbers are counted" says how each one is taken.
export const STATS = {
  modules: ${s.modules.length},
  operations: ${s.commands + s.queries},
  commands: ${s.commands},
  queries: ${s.queries},
  migrations: ${s.migrations},
  testCases: ${round(s.testCases, 1000)},
  invariantSuites: ${s.invariantSuites},
  adrs: ${s.adrs},
  languages: ${s.languages},
  coworkers: ${s.coworkers.length},
  mcpTools: ${s.mcpTools},
  typescriptLines: ${round(s.tsLines, 10000)},
} as const;
`;

if (CHECK) {
  const stale = Object.entries(files).filter(([f, body]) => !existsSync(join(OUT, f)) || readFileSync(join(OUT, f), 'utf8') !== body).map(([f]) => f);
  if (!existsSync(STATS_TS) || readFileSync(STATS_TS, 'utf8') !== statsTs) stale.push('apps/web/src/content/stats.ts');
  if (stale.length > 0) {
    console.error(`readme-assets: out of date: ${stale.join(', ')} (run: node tools/readme-assets.mjs)`);
    process.exit(1);
  }
  console.log('readme-assets: up to date');
} else {
  mkdirSync(OUT, { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(OUT, f), body);
  writeFileSync(STATS_TS, statsTs);
  console.log(JSON.stringify(s, null, 2));
}
