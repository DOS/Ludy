// SPDX-License-Identifier: AGPL-3.0-only
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

/** Returns AST-verified import records matching a workspace package root or any subpath. */
export function pkgImportMatches(src: string, pkgName: string, records = collectModuleImports(src)): ModuleImportRecord[] {
  return records.filter((record) => matchesPackage(record.specifier, pkgName));
}

/** Extracts named imports from an exact package root, rejecting any subpath import. */
export function exactPkgNamedImports(
  src: string,
  pkgName: string,
): { names: string[]; valueNames: string[] } {
  const records = collectModuleImports(src);
  const matched = pkgImportMatches(src, pkgName, records);
  const subpath = matched.find((record) => record.specifier !== pkgName);
  if (subpath) {
    throw new Error(`Unexpected subpath import from ${subpath.specifier}`);
  }
  return {
    names: matched.flatMap((record) => record.names),
    valueNames: matched.flatMap((record) => record.valueNames),
  };
}
