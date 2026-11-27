// SPDX-License-Identifier: AGPL-3.0-only
// Builds the extension into dist/ (or --out <dir>) with no bundler and no dependency: Node strips the types of each
// module (the sources are erasable TypeScript), rewrites relative imports from .ts to .js, and copies the one workspace
// package @ludy/meeting-recorder to <out>/shared/. Stamps version (--version) and origin overrides (--origin, or
// --app-origin / --api-origin) into ludy-address.js and manifest.json.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_API_ADDRESS, DEFAULT_APP_ADDRESS, originPattern, parseAddress } from '../src/ludy-address.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const ENTRIES = ['background', 'offscreen', 'popup', 'mic', 'connected'].map((name) => join(src, `${name}.ts`));
const STATIC = ['popup.html', 'popup.css', 'offscreen.html', 'mic.html', 'connected.html', 'connected.css'];
// The icons the manifest names (`icons`, `action.default_icon`), copied as they are from icons/ (the Ludy mark: the web brand's 16 and 32 pixel favicons and the mark rendered at 48 and 128).
const ICONS = ['icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png'];

// The only package import the sources may make, mapped to its file; any other bare import fails the build (no bundler, no node_modules in the package).
const PACKAGES = { '@ludy/meeting-recorder': join(root, '..', '..', 'packages', 'meeting-recorder', 'src', 'index.ts') };

function parseBuildArgs(argv) {
  const opts = { version: undefined, origin: undefined, appOrigin: undefined, apiOrigin: undefined, out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const eq = arg.indexOf('=');
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || value === '' || (eq < 0 && value.startsWith('--'))) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (flag === '--version') opts.version = value;
    else if (flag === '--origin') opts.origin = value;
    else if (flag === '--app-origin') opts.appOrigin = value;
    else if (flag === '--api-origin') opts.apiOrigin = value;
    else if (flag === '--out') opts.out = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  return opts;
}

function resolveOrigin(input, label) {
  const parsed = parseAddress(input, { allowLoopbackIp: true });
  if ('problem' in parsed) throw new Error(`Invalid ${label} "${input}": ${parsed.problem}`);
  return parsed.origin;
}

const opts = parseBuildArgs(process.argv.slice(2));
const dist = opts.out ? resolve(process.cwd(), opts.out) : join(root, 'dist');
const sharedOrigin = opts.origin ? resolveOrigin(opts.origin, '--origin') : undefined;
const appOrigin = opts.appOrigin ? resolveOrigin(opts.appOrigin, '--app-origin') : (sharedOrigin ?? DEFAULT_APP_ADDRESS);
const apiOrigin = opts.apiOrigin ? resolveOrigin(opts.apiOrigin, '--api-origin') : (sharedOrigin ?? DEFAULT_API_ADDRESS);

const version = (opts.version ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).replace(/^v/, '');
if (!/^\d+(\.\d+){0,3}$/.test(version)) throw new Error(`The version ${version} is not one a manifest accepts`);

// A package's index.ts is <out>/shared/<package>.js; any other file of the package is <out>/shared/<package>-<name>.js, so a package of several files keeps one output each.
const sharedName = (file) => {
  if (!file.includes('/packages/')) return basename(file);
  const pkg = basename(dirname(dirname(file)));
  const name = basename(file, '.ts');
  return name === 'index' ? `${pkg}.ts` : `${pkg}-${name}.ts`;
};
const outputPath = (file) => (file.startsWith(`${src}/`) ? join(dist, relative(src, file)) : join(dist, 'shared', sharedName(file))).replace(/\.ts$/, '.js');

function stampAddresses(code) {
  const appRe = /^(export const DEFAULT_APP_ADDRESS = )'[^']+';$/m;
  const apiRe = /^(export const DEFAULT_API_ADDRESS = )'[^']+';$/m;
  if (!appRe.test(code) || !apiRe.test(code)) {
    throw new Error('Could not stamp DEFAULT_APP_ADDRESS / DEFAULT_API_ADDRESS in ludy-address.ts');
  }
  return code
    .replace(appRe, `$1${JSON.stringify(appOrigin)};`)
    .replace(apiRe, `$1${JSON.stringify(apiOrigin)};`);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const done = new Set();
const addressSource = join(src, 'ludy-address.ts');
function emit(file) {
  if (done.has(file)) return;
  done.add(file);
  let code = stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' });
  if (file === addressSource) code = stampAddresses(code);
  code = code.replace(/(\bfrom\s*|\bimport\s*\(\s*)(['"])([^'"]+)\2/g, (all, lead, quote, spec) => {
    if (spec.startsWith('node:')) return all;
    if (!spec.startsWith('.') && !(spec in PACKAGES)) throw new Error(`${file}: the package ${spec} is not bundled; the extension has no runtime dependency`);
    const target = spec in PACKAGES ? PACKAGES[spec] : resolve(dirname(file), spec);
    if (!target.endsWith('.ts')) throw new Error(`${file}: relative imports name their .ts file, found ${spec}`);
    emit(target);
    let rel = relative(dirname(outputPath(file)), outputPath(target));
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return `${lead}${quote}${rel}${quote}`;
  });
  const out = outputPath(file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, code);
}

for (const entry of ENTRIES) emit(entry);
for (const name of STATIC) cpSync(join(src, name), join(dist, name));
// The store's per-language listing and the browser's own name and description come from _locales/<lang>/messages.json, which the manifest names with __MSG_key__ references.
cpSync(join(root, '_locales'), join(dist, '_locales'), { recursive: true });
mkdirSync(join(dist, 'icons'), { recursive: true });
for (const name of ICONS) cpSync(join(root, 'icons', name), join(dist, 'icons', name));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
manifest.version = version;
manifest.host_permissions = [originPattern(apiOrigin)];
manifest.web_accessible_resources = [{ resources: ['connected.html'], matches: [originPattern(appOrigin)] }];
writeFileSync(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built the Ludy extension ${version}: ${done.size} modules in ${relative(process.cwd(), dist) || '.'} (app: ${appOrigin}, api: ${apiOrigin})`);
