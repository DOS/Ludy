// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAst } from 'vitest/node';

interface AstNode {
  type: string;
  [key: string]: unknown;
}

export interface ModuleImportRecord {
  specifier: string;
  names: string[];
  valueNames: string[];
}

function staticString(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as AstNode;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (
    n.type === 'TemplateLiteral' &&
    Array.isArray(n.expressions) &&
    n.expressions.length === 0 &&
    Array.isArray(n.quasis) &&
    n.quasis.length === 1
  ) {
    const quasi = n.quasis[0] as { value?: { cooked?: unknown } } | undefined;
    return typeof quasi?.value?.cooked === 'string' ? quasi.value.cooked : null;
  }
  return null;
}

function matchesPackage(specifier: string, pkgName: string): boolean {
  return specifier === pkgName || specifier.startsWith(`${pkgName}/`);
}

function visitAst(node: unknown, visit: (n: AstNode) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) visitAst(item, visit);
    return;
  }
  const ast = node as AstNode;
  if (typeof ast.type === 'string') visit(ast);
  for (const [key, value] of Object.entries(ast)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
    if (value && typeof value === 'object') visitAst(value, visit);
  }
}

/** Parses TS/JS source with Vite's AST parser and extracts real module import/export/require/import() edges. */
export function collectModuleImports(src: string): ModuleImportRecord[] {
  const program = parseAst(src, { lang: 'ts' } as never) as unknown as AstNode;
  const records: ModuleImportRecord[] = [];
  visitAst(program, (node) => {
    if (node.type === 'ImportDeclaration') {
      const specifier = staticString(node.source);
      if (!specifier) return;
      const specifiers = Array.isArray(node.specifiers) ? (node.specifiers as AstNode[]) : [];
      if (specifiers.length === 0) {
        records.push({ specifier, names: ['side-effect'], valueNames: node.importKind === 'type' ? [] : ['side-effect'] });
        return;
      }
      const names: string[] = [];
      const valueNames: string[] = [];
      for (const spec of specifiers) {
        let importedName = '';
        if (spec.type === 'ImportSpecifier') {
          const imported = spec.imported as { name?: unknown; value?: unknown } | undefined;
          importedName = typeof imported?.name === 'string' ? imported.name : typeof imported?.value === 'string' ? imported.value : '';
        } else if (spec.type === 'ImportNamespaceSpecifier') {
          importedName = '*';
        } else if (spec.type === 'ImportDefaultSpecifier') {
          importedName = 'default';
        }
        if (!importedName) continue;
        names.push(importedName);
        if (node.importKind !== 'type' && spec.importKind !== 'type') {
          valueNames.push(importedName);
        }
      }
      records.push({ specifier, names, valueNames });
      return;
    }
    if (node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') {
      const specifier = staticString(node.source);
      if (specifier) records.push({ specifier, names: ['export'], valueNames: node.exportKind === 'type' ? [] : ['export'] });
      return;
    }
    if (node.type === 'ImportExpression') {
      const specifier = staticString(node.source);
      if (specifier) records.push({ specifier, names: ['dynamic'], valueNames: ['dynamic'] });
      return;
    }
    if (node.type === 'TSImportType') {
      const specifier = staticString(node.source);
      if (specifier) records.push({ specifier, names: ['ts-import'], valueNames: [] });
      return;
    }
    if (node.type === 'TSExternalModuleReference') {
      const specifier = staticString(node.expression);
      if (specifier) records.push({ specifier, names: ['import-equals'], valueNames: ['import-equals'] });
      return;
    }
    if (node.type === 'CallExpression' && Array.isArray(node.arguments) && node.arguments.length > 0) {
      const callee = node.callee as AstNode | undefined;
      const isRequire =
        (callee?.type === 'Identifier' && callee.name === 'require') ||
        (callee?.type === 'MemberExpression' &&
          (callee.object as AstNode | undefined)?.type === 'Identifier' &&
          (callee.object as AstNode).name === 'require' &&
          (callee.property as AstNode | undefined)?.type === 'Identifier' &&
          (callee.property as AstNode).name === 'resolve');
      if (isRequire) {
        const specifier = staticString(node.arguments[0]);
        if (specifier) records.push({ specifier, names: ['require'], valueNames: ['require'] });
      }
    }
  });
  return records;
}

/** Resolves the active `@crove/ad-platform` or `@ludy/ad-platform` package name from the workspace manifest. */
export function resolveAdPlatformPackages(root: string): { activePkg: string; inactivePkg: string } {
  const pkg = (JSON.parse(readFileSync(join(root, 'packages/ad-platform/package.json'), 'utf8')) as { name: string }).name;
  if (pkg !== '@crove/ad-platform' && pkg !== '@ludy/ad-platform') {
    throw new Error(`Unexpected ad-platform package name: ${pkg}`);
  }
  return {
    activePkg: pkg,
    inactivePkg: pkg === '@crove/ad-platform' ? '@ludy/ad-platform' : '@crove/ad-platform',
  };
}

/** Returns AST-verified import records matching a workspace package or subpath. */
export function pkgImportMatches(src: string, pkgName: string, records = collectModuleImports(src)): ModuleImportRecord[] {
  return records.filter((record) => matchesPackage(record.specifier, pkgName));
}

/** Extracts named imports from the active ad-platform package using the same AST parse, rejecting mixed-scope imports. */
export function activeAdPlatformNamedImports(
  src: string,
  activePkg: string,
  inactivePkg: string,
): { names: string[]; valueNames: string[] } {
  const records = collectModuleImports(src);
  if (pkgImportMatches(src, inactivePkg, records).length > 0) {
    throw new Error(`Unexpected mixed ad-platform import from ${inactivePkg}`);
  }
  const matched = pkgImportMatches(src, activePkg, records);
  return {
    names: matched.flatMap((record) => record.names),
    valueNames: matched.flatMap((record) => record.valueNames),
  };
}
