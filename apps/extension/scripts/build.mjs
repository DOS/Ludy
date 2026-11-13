// SPDX-License-Identifier: AGPL-3.0-only
// Builds the extension into dist/ with no bundler and no dependency: Node strips the types of each module (the sources
// are erasable TypeScript), the relative imports are rewritten from .ts to .js, and the one workspace package it uses,
// @crove/meeting-recorder (pure code shared with the app's recorder), is copied to dist/shared/. The result is plain ES modules
// the browser loads from the package. `node scripts/build.mjs --version 1.2.3` stamps the manifest (a release tag).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');
const ENTRIES = ['background', 'offscreen', 'popup', 'mic'].map((name) => join(src, `${name}.ts`));
const STATIC = ['popup.html', 'popup.css', 'offscreen.html', 'mic.html'];
// The icons the manifest names (`icons`, `action.default_icon`), copied as they are from icons/ (the Ludy mark: the web brand's 16 and 32 pixel favicons and the mark rendered at 48 and 128).
const ICONS = ['icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png'];

// The only package import the sources may make, mapped to its file; any other bare import fails the build (no bundler, no node_modules in the package).
const PACKAGES = { '@crove/meeting-recorder': join(root, '..', '..', 'packages', 'meeting-recorder', 'src', 'index.ts') };
// A package's index.ts is dist/shared/<package>.js; any other file of the package is dist/shared/<package>-<name>.js, so a package of several files keeps one output each.
const sharedName = (file) => {
  if (!file.includes('/packages/')) return basename(file);
  const pkg = basename(dirname(dirname(file)));
  const name = basename(file, '.ts');
  return name === 'index' ? `${pkg}.ts` : `${pkg}-${name}.ts`;
};
const outputPath = (file) => (file.startsWith(`${src}/`) ? join(dist, relative(src, file)) : join(dist, 'shared', sharedName(file))).replace(/\.ts$/, '.js');

const argVersion = process.argv.indexOf('--version') > 0 ? process.argv[process.argv.indexOf('--version') + 1] : undefined;
const version = (argVersion ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).replace(/^v/, '');
if (!/^\d+(\.\d+){0,3}$/.test(version)) throw new Error(`The version ${version} is not one a manifest accepts`);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const done = new Set();
function emit(file) {
  if (done.has(file)) return;
  done.add(file);
  let code = stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' });
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
writeFileSync(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built the Ludy extension ${version}: ${done.size} modules in ${relative(process.cwd(), dist) || '.'}`);
