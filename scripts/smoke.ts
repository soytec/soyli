import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'soyli-standalone-'));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  await cp(new URL('../dist', import.meta.url).pathname, join(root, 'distribution'), { recursive: true });
  const exe = join(root, 'distribution/soyli');
  const created = Bun.spawn([exe, 'new', 'demo', '--template', 'soft-orbit', '--identity', 'later', '--no-install'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [code, out, err] = await Promise.all([created.exited, new Response(created.stdout).text(), new Response(created.stderr).text()]);
  if (code) throw new Error(`${out}\n${err}`);
  const preview = Bun.spawn([exe, 'dev', '--project', join(root, 'demo'), '--port', '0', '--no-open'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  server = preview;
  const reader = preview.stdout.getReader();
  let text = ''; let url: string | undefined;
  const timer = setTimeout(() => server?.kill(), 20000);
  try {
    while (!url) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Preview exited before listening: ' + text);
      text += new TextDecoder().decode(chunk.value);
      url = text.match(/http:\/\/(?:localhost|127\.0\.0\.1):\d+/)?.[0];
    }
    const response = await fetch(url);
    if (!response.ok || !(await response.text()).includes('<html')) throw new Error('Invalid preview response');
    console.log('Relocated distribution: scaffold and embedded browser preview passed.');
  } finally { clearTimeout(timer); }
} finally {
  server?.kill();
  if (server) await server.exited;
  await rm(root, { recursive: true, force: true });
}
