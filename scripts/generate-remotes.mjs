/** Generate the owned Remote descriptors with DSH's published generator. */
import { WorkspaceTypertGenerator, writeWorkspaceArtifacts } from '@deepseek-ai/dsh-typert-generator';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
// rc.3 recognizes marker declarations only in workspace packages or ambient modules.
// Re-expose the exact installed public declarations for analysis; runtime imports stay untouched.
const require = createRequire(import.meta.url);
const manifestPath = require.resolve('@deepseek-ai/dsh-typert-protocol/package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const publicTypes = resolve(dirname(manifestPath), manifest.exports['.'].types);
const declarations = readFileSync(publicTypes, 'utf8');
const source = ts.createSourceFile(publicTypes, declarations, ts.ScriptTarget.Latest, true);
const selectedNames = new Set(['TypertRemoteService', 'Remote', 'RemoteScope', 'bindTypertRemote', 'RemoteMethodDecorator', 'RemoteTypedMethodDecorator']);
const selected = source.statements.filter(statement => statement.name && selectedNames.has(statement.name.text));
if (![...selectedNames].every(name => selected.some(statement => statement.name.text === name))) throw new Error('Published Typert marker declarations changed; update the build facade adapter');
const modelTypesPath = ts.resolveModuleName('./types.ts', publicTypes, { moduleResolution: ts.ModuleResolutionKind.NodeNext }, ts.sys).resolvedModule?.resolvedFileName;
if (!modelTypesPath) throw new Error('Cannot resolve the public protocol declaration dependencies');
const modelDeclarations = readFileSync(modelTypesPath, 'utf8');
const modelSource = ts.createSourceFile(modelTypesPath, modelDeclarations, ts.ScriptTarget.Latest, true);
const modelNames = new Set(['TypertLookup', 'TypertContext', 'TypertLookupMap', 'TypertContextMap']);
const modelSelected = modelSource.statements.filter(statement => statement.name && modelNames.has(statement.name.text));
const symbols = modelSource.statements.filter(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => ['LOOKUP_HOST', 'LOOKUP_WIRE', 'CONTEXT_WIRE'].includes(declaration.name.getText(modelSource))));
const facade = [
  `// Generated from ${manifest.name}@${manifest.version}; SHA256 ${createHash('sha256').update(declarations).digest('hex')}`,
  "declare module '@deepseek-ai/dsh-typert-protocol' {",
  "import { Context, Service } from '@deepseek-ai/cordis';",
  "import type { TypertGatewayBinding, TypertGatewayBindingOptions, RemoteMethodOptions, RemoteScopeOptions, RemoteWireArgs } from '@robot-build/typert-protocol-actual';",
  "export * from '@robot-build/typert-protocol-actual';",
  ...selected.map(statement => statement.getText(source).replace(/\bdeclare\s+/g, '')),
  ...symbols.map(statement => statement.getText(modelSource).replace(/\bdeclare\s+/g, '')),
  ...modelSelected.map(statement => statement.getText(modelSource)),
  '}',
].join('\n');
mkdirSync(resolve(root, '.build'), { recursive: true });
writeFileSync(resolve(root, '.build/typert-protocol-facade.d.ts'), facade);
const artifacts = new WorkspaceTypertGenerator(root, { checkDiagnostics: false, rejectBuildOutputs: true }).generateContributors(['host']);
if (!artifacts.some(artifact => artifact.remote !== undefined)) {
  throw new Error('Robot management Remote methods were not discovered; no artifacts were written');
}
writeWorkspaceArtifacts(root, artifacts);
console.log(`Generated ${artifacts.length} robot Remote contribution(s)`);
