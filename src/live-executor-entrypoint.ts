import { fileURLToPath } from 'node:url';

export interface LiveExecutorEntrypoint {
  runtime: 'typescript/tsx' | 'compiled-javascript';
  entry: string;
  args: string[];
}

/**
 * Resolve the child next to the currently executing parent module. Source
 * (`tsx src/index.ts`) and compiled (`node dist/index.js`) runs therefore
 * cannot silently cross over into a stale output tree.
 */
export function resolveLiveExecutorEntrypoint(parentModuleUrl: string): LiveExecutorEntrypoint {
  const parentPath = fileURLToPath(parentModuleUrl);
  const runningTypeScript = parentPath.endsWith('.ts');
  const entry = fileURLToPath(new URL(
    runningTypeScript ? './live-execution-process.ts' : './live-execution-process.js',
    parentModuleUrl,
  ));
  return {
    runtime: runningTypeScript ? 'typescript/tsx' : 'compiled-javascript',
    entry,
    args: runningTypeScript ? ['--import', 'tsx', entry] : [entry],
  };
}
