// SPDX-License-Identifier: AGPL-3.0-only
// Builds the app folder Electron runs: src/*.ts with their types stripped (the same erasable TypeScript Node runs, no bundler, no
// transpiler dependency) into out/stage/dist/*.js, plus a minimal package.json. Runs on any system; packaging is package.mjs.
//   node scripts/build.mjs [--version X.Y.Z]
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const stage = join(root, 'out', 'stage');

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(path)));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

export async function build(version) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await rm(stage, { recursive: true, force: true });
  for (const file of await sources(join(root, 'src'))) {
    const code = stripTypeScriptTypes(await readFile(file, 'utf8'), { mode: 'strip' });
    // Relative imports name their .ts file in the source; the built file is .js.
    const js = code.replace(/(\bfrom\s+|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2');
    const target = join(stage, 'dist', relative(join(root, 'src'), file).replace(/\.ts$/, '.js'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, js);
  }
  await writeFile(
    join(stage, 'package.json'),
    `${JSON.stringify({ name: 'ludy-desktop', productName: 'Ludy Desktop', version: version ?? pkg.version, description: pkg.description, author: 'Ludy', main: 'dist/main.js', type: 'module', license: pkg.license }, null, 2)}\n`,
  );
  return { stage, version: version ?? pkg.version };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--version');
  const version = at === -1 ? undefined : process.argv[at + 1];
  if (version !== undefined && !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('--version must be X.Y.Z');
  const done = await build(version);
  console.log(`built ${done.version} into ${done.stage}`);
}
