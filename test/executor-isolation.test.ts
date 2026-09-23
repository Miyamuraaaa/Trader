import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import vm from 'node:vm';

it('recursively excludes scanner-only SDKs and quarantined builders from runtime executor imports', async () => {
  const visited = new Set<string>();
  async function visit(file: string): Promise<void> {
    file = path.resolve(file);
    if (visited.has(file)) return;
    visited.add(file);
    // Transpile before walking: erased type-only imports do not expand runtime authority.
    const js = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const tree = ts.createSourceFile(file, js, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const imports: string[] = [];
    const walk = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        expect(node.arguments[0] && ts.isStringLiteral(node.arguments[0]), 'computed executor imports require review').toBe(true);
        if (node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
      }
      ts.forEachChild(node, walk);
    };
    walk(tree);
    for (const specifier of imports) {
      expect(specifier).not.toMatch(/@meteora-ag\/dlmm|@solana\/spl-token|bigint-buffer|@coral-xyz\/anchor/);
      if (specifier.startsWith('.')) {
        expect(specifier).not.toMatch(/(?:^|\/)(?:scanner|meteora|raydium|jupiter|raptor|generic-cycle-builder|meteora-swap-builder)\.js$/);
        await visit(path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts')));
      }
    }
  }
  await visit('src/live-execution-process.ts');
  expect(visited.size).toBeGreaterThan(20);
  const clmm=await readFile('src/execution/raydium-swap-builder.ts','utf8');
  expect(clmm).not.toMatch(/VersionedTransaction\.deserialize|swap-base-in|swapTransaction|\.sendTransaction\(|\.execute\(/);
}, 15_000);

it('keeps the installed Web3/Jayson request-ID path off vulnerable UUID and stream filter APIs', async () => {
  const web3 = await readFile('node_modules/@solana/web3.js/lib/index.cjs.js', 'utf8');
  expect(web3).toContain("require('jayson/lib/client/browser')");
  for (const file of ['node_modules/jayson/lib/client/browser/index.js', 'node_modules/jayson/lib/generateRequest.js']) {
    const source = await readFile(file, 'utf8');
    expect(source).toContain("require('uuid').v4"); expect(source).toContain('uuid()');
    expect(source).not.toMatch(/stream-json|\.v[356]\b/);
  }
});

it('keeps reviewed qs patch and validates dashboard inline-script syntax without starting the bot', async () => {
  const qs = JSON.parse(await readFile('node_modules/qs/package.json', 'utf8'));
  expect(qs.version).toBe('6.16.0');
  const html = await readFile('public/index.html', 'utf8');
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    if (match[1]?.trim()) expect(() => new vm.Script(match[1]!)).not.toThrow();
  }
  expect(html.toUpperCase().includes('EXECUTION FUNNEL')).toBe(true);
  expect(html.toUpperCase().includes('EXECUTABLE OPPORTUNITIES')).toBe(true);
  expect(html.includes('ACCEPT &amp; EXECUTE')).toBe(true);
});
