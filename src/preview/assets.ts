import { DiagnosticError } from '../../packages/diagnostics/src';
export type PreviewAssets = { client: string; html: string };
declare const NAPPLET_PREVIEW_ASSETS: PreviewAssets | undefined;
let pending: Promise<PreviewAssets> | undefined;

export function previewAssets(): Promise<PreviewAssets> {
  if (typeof NAPPLET_PREVIEW_ASSETS !== 'undefined') return Promise.resolve(NAPPLET_PREVIEW_ASSETS);
  // Source-checkout convenience only. Distributed executables embed the result.
  // Keep Bun.build away from prior native/network work in the publishing process.
  return (pending ??= (async () => {
    const child = Bun.spawn([process.execPath, new URL('./bundle.ts', import.meta.url).pathname], {
      cwd: import.meta.dir,
      env: { PATH: process.env.PATH, BUN_BE_BUN: '1' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    try {
      const [code, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code !== 0)
        throw new DiagnosticError(
          'PREVIEW_BUILD',
          'Could not prepare the trusted preview assets.',
          { operation: 'bundle local preview', tool: 'Bun', exitCode: code, detail: errors },
        );
      return JSON.parse(output) as PreviewAssets;
    } finally {
      clearTimeout(timer);
    }
  })().catch((error) => {
    pending = undefined;
    throw error;
  }));
}
