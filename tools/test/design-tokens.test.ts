// SPDX-License-Identifier: AGPL-3.0-only
// The token block at the top of DESIGN.md (YAML front matter) is machine-readable, for design tools and coding agents.
// The CSS files stay the source of truth: this fails when a value in the block and the CSS disagree, so the block
// cannot drift. `rules` holds what DESIGN.md decides in prose (the CSS has no token for it); each value must still appear
// in the text. The front matter is the small YAML subset the block uses (nested maps, double-quoted or plain scalars,
// `#` comment lines), read here without a dependency.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

type Node = string | { [key: string]: Node };
type Tree = { [key: string]: Node };

function parseFrontMatter(text: string): Tree {
  const root: Tree = {};
  const stack: { indent: number; node: Tree }[] = [{ indent: -1, node: root }];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^( *)([\w-]+):(?: (.*))?$/.exec(line);
    if (!match) throw new Error(`cannot read the token block line: ${line}`);
    const indent = (match[1] ?? '').length;
    const key = match[2] ?? '';
    const value = match[3];
    while ((stack[stack.length - 1]?.indent ?? -1) >= indent) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    if (!parent) throw new Error(`bad indentation: ${line}`);
    if (value === undefined) {
      const child: Tree = {};
      parent[key] = child;
      stack.push({ indent, node: child });
    } else {
      parent[key] = value.startsWith('"') ? (JSON.parse(value) as string) : value;
    }
  }
  return root;
}

const design = read('DESIGN.md');
const END = design.indexOf('\n---\n', 4);
if (!design.startsWith('---\n') || END < 0) throw new Error('DESIGN.md has no YAML front matter');
const block = parseFrontMatter(design.slice(4, END));
const body = design.slice(END + 5);

const tree = (path: string): Tree => {
  let node: Node | undefined = block;
  for (const part of path.split('.')) node = typeof node === 'object' ? node[part] : undefined;
  if (typeof node !== 'object') throw new Error(`no map at ${path} in the token block`);
  return node;
};
const text = (path: string): string => {
  const parts = path.split('.');
  const last = parts.pop() ?? '';
  const value = (parts.length ? tree(parts.join('.')) : block)[last];
  if (typeof value !== 'string') throw new Error(`no value at ${path} in the token block`);
  return value;
};
const leaves = (node: Node): string[] => (typeof node === 'string' ? [node] : Object.values(node).flatMap(leaves));

const appCss = read('packages/ui/src/styles/globals.css');
const siteCss = read('apps/web/src/app/globals.css');

// The declarations of one block of a stylesheet (`:root`, `.dark`, `@theme inline`), up to the closing brace at the
// start of a line.
function declarations(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const end = css.indexOf('\n}', start + 1);
  const out: Record<string, string> = {};
  for (const match of css.slice(start, end).matchAll(/^\s+--([\w-]+):\s*([^;]+);/gm)) out[match[1] ?? ''] = (match[2] ?? '').trim();
  return out;
}
const without = (record: Record<string, string>, ...keys: string[]): Record<string, string> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
const withPrefix = (record: Record<string, string>, prefix: string): Record<string, string> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => key.startsWith(prefix)));
const stripped = (record: Record<string, string>, prefix: string): Record<string, string> =>
  Object.fromEntries(Object.entries(withPrefix(record, prefix)).map(([key, value]) => [key.slice(prefix.length), value]));

const THEMES = {
  app: { css: appCss, light: ':root', dark: '.dark' },
  site: { css: siteCss, light: ':root', dark: ":root[data-theme='dark']" },
} as const;

describe('DESIGN.md token block', () => {
  it('names the version the text says', () => {
    expect(body).toContain(`Version ${text('version')} (${text('date')})`);
  });

  for (const [name, { css, light, dark }] of Object.entries(THEMES)) {
    for (const [theme, selector] of [['light', light], ['dark', dark]] as const) {
      it(`has every ${name} color of the ${theme} theme, with the CSS value`, () => {
        expect(tree(`colors.${name}.${theme}`)).toEqual(without(declarations(css, selector), 'radius'));
      });
    }
    it(`gives every ${name} color a role, and no role to a color that is not there`, () => {
      const roles = Object.keys(tree(`colors.${name}.roles`)).sort();
      expect(roles).toEqual(Object.keys(tree(`colors.${name}.light`)).sort());
      expect(Object.keys(tree(`colors.${name}.dark`)).sort()).toEqual(roles);
      for (const role of leaves(tree(`colors.${name}.roles`))) expect(role.length).toBeGreaterThan(3);
    });
  }

  it('has the font families of each stylesheet', () => {
    expect(tree('typography.app')).toEqual(withPrefix(declarations(appCss, '@theme inline'), 'font-'));
    expect(tree('typography.site')).toEqual(withPrefix(declarations(siteCss, '@theme inline'), 'font-'));
  });

  it('has the weights the app ships (fonts.css) and the marketing site loads (fonts.ts)', () => {
    const fontFaces = read('packages/ui/src/fonts/fonts.css');
    const weightsOf = (family: string): string => {
      const found = new Set<string>();
      for (const face of fontFaces.matchAll(/@font-face \{([^}]*)\}/g)) {
        const css = face[1] ?? '';
        if (css.includes(`font-family: '${family}'`)) found.add(/font-weight:\s*([^;]+);/.exec(css)?.[1]?.trim() ?? '');
      }
      return [...found].sort().join(' ');
    };
    expect(text('typography.faceWeights.app-sans')).toBe(weightsOf('Be Vietnam Pro'));
    expect(text('typography.faceWeights.app-mono')).toBe(weightsOf('JetBrains Mono'));

    const fonts = read('apps/web/src/app/fonts.ts');
    const siteFace = (name: string): { weights: string; variable: string } => {
      const call = new RegExp(`${name}\\(\\{([\\s\\S]*?)\\}\\)`).exec(fonts)?.[1] ?? '';
      const weights = [...(/weight:\s*\[([^\]]*)\]/.exec(call)?.[1] ?? '').matchAll(/\d+/g)].map((m) => m[0]).join(' ');
      return { weights, variable: /variable:\s*'([^']+)'/.exec(call)?.[1] ?? '' };
    };
    const sans = siteFace('Be_Vietnam_Pro');
    const mono = siteFace('JetBrains_Mono');
    expect(text('typography.faceWeights.site-sans')).toBe(sans.weights);
    expect(text('typography.faceWeights.site-mono')).toBe(mono.weights);
    expect(text('typography.faces.site-sans')).toContain(sans.variable);
    expect(text('typography.faces.site-mono')).toContain(mono.variable);
    for (const key of ['app-sans', 'app-mono', 'site-sans', 'site-mono']) {
      expect(text(`typography.faces.${key}`)).toContain(text(`typography.faceWeights.${key}`));
    }
  });

  it('has the body line height of the marketing site', () => {
    expect(siteCss).toMatch(new RegExp(`body \\{[^}]*line-height: ${text('typography.siteBodyLineHeight').replace('.', '\\.')};`));
  });

  it('has the radius and its scale of packages/ui', () => {
    const { radius } = declarations(appCss, ':root');
    const scale = stripped(declarations(appCss, '@theme inline'), 'radius-');
    expect(tree('radius')).toEqual({ base: radius, ...scale });
  });

  it('has the layout values of the stylesheets', () => {
    expect(siteCss).toContain(`max-width: ${text('layout.site-content-max-width')};`);
    expect(siteCss).toContain(`padding-left: max(${text('layout.site-gutter-phone')},`);
    expect(siteCss).toContain(`padding-left: max(${text('layout.site-gutter-640-up')},`);
    expect(siteCss).toContain(`scroll-padding-top: ${text('layout.site-scroll-padding-top')};`);
    expect(siteCss).toContain(`outline: ${text('layout.site-focus-outline')};`);
    expect(siteCss).toContain(`outline-offset: ${text('layout.site-focus-outline-offset')};`);
    for (const css of [appCss, siteCss]) {
      expect(css).toContain(`::-webkit-scrollbar {\n      width: ${text('layout.scrollbar-size')};\n      height: ${text('layout.scrollbar-size')};`);
    }
  });

  it('has the motion values of the stylesheets', () => {
    expect(siteCss).toContain(`animation: crove-travel-up ${text('motion.site-travel-up')};`);
    expect(appCss).toContain(`animation-duration: ${text('motion.app-reduced-animation-duration')} !important;`);
    expect(siteCss).toContain(`animation-duration: ${text('motion.site-reduced-animation-duration')} !important;`);
  });

  it('keeps each marketing token equal to its app counterpart, but the listed exceptions', () => {
    const { exceptions, ...pairs } = tree('parity') as Record<string, string>;
    const excepted = (exceptions ?? '').split(' ').filter(Boolean);
    expect(excepted.length).toBeGreaterThan(0);
    for (const theme of ['light', 'dark'] as const) {
      const site = tree(`colors.site.${theme}`);
      const app = tree(`colors.app.${theme}`);
      for (const [siteName, appName] of Object.entries(pairs)) {
        if (excepted.includes(siteName)) expect(site[siteName], `${theme} ${siteName} differs on purpose`).not.toBe(app[appName]);
        else expect(site[siteName], `${theme} ${siteName} is ${appName}`).toBe(app[appName]);
      }
    }
  });

  it('keeps every value of `rules` in the text of DESIGN.md', () => {
    const rules = leaves(tree('rules'));
    expect(rules.length).toBeGreaterThan(10);
    for (const value of rules) expect(body, value).toContain(value);
  });
});
