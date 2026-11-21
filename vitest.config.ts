import { defineConfig } from 'vitest/config';
import ts from 'typescript';
// Vite's transformer currently preserves TC39 decorators; use the production TS
// transform for decorated host services so unit tests execute actual methods.
export default defineConfig({ plugins: [{ name: 'robot-host-decorators', enforce: 'pre', transform(code, id) {
  if (!id.endsWith('.ts') || !code.includes('@Remote')) return;
  return ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
} }] });
