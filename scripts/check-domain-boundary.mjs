/** Enforce that the reusable domain does not import the DSH runtime or adapters. */
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export async function checkDomainBoundary(directory) {
  const violations = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && /\.[cm]?tsx?$/.test(file)) {
        const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
        function inspect(node) {
          let specifier;
          if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier = node.moduleSpecifier.text;
          if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifier = node.arguments[0].text;
          if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) specifier = node.argument.literal.text;
          if (specifier && (/^@deepseek-ai\//.test(specifier) || /(^|\/)(adapters?|host|client)(\/|$)/.test(specifier))) violations.push({ file, specifier });
          ts.forEachChild(node, inspect);
        }
        inspect(source);
      }
    }
  }
  await visit(resolve(directory));
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const violations = await checkDomainBoundary(process.argv[2] ?? resolve(import.meta.dirname, '../packages/robot/src/domain'));
  if (violations.length) { console.error(JSON.stringify(violations, null, 2)); process.exitCode = 1; }
  else console.log('Domain boundary passed: no DSH or adapter imports');
}
