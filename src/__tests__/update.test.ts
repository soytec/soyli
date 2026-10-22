import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, parseRelease } from '../update';

const platform = `${process.platform}-${process.arch}`;
function metadata(version = '99.0.0') {
  return {
    tag_name: `soyli-v${version}`,
    draft: false,
    prerelease: false,
    assets: ['', '.sha256'].map((suffix) => ({
      name: `soyli-${platform}.tar.gz${suffix}`,
      state: 'uploaded',
      size: 100,
    })),
  };
}
test('release selection compares numeric versions and requires complete stable platform assets', () => {
  expect(compareVersions('0.9.0', '0.18.0')).toBe(-1);
  expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  expect(compareVersions('1.0.0', '0.99.0')).toBe(1);
  for (const invalid of ['01.2.3', '1.2.3-beta', '1.2', 'foo'])
    expect(() => compareVersions(invalid, '1.0.0')).toThrow();
  expect(parseRelease(metadata()).version).toBe('99.0.0');
  for (const repository of ['zeSchlausKwab/napplet-soy', 'soytec/napplet-soy']) {
    const url = `https://github.com/${repository}/releases/tag/soyli-v99.0.0`;
    expect(parseRelease({ ...metadata(), html_url: url }).url).toBe(url);
  }
  expect(parseRelease({ ...metadata(), html_url: 'https://untrusted.invalid/install' }).url).toBe(
    'https://github.com/soytec/napplet-soy/releases/tag/soyli-v99.0.0',
  );
  for (const invalid of [
    null,
    { ...metadata(), draft: true },
    { ...metadata(), prerelease: true },
    { ...metadata(), tag_name: 'v99.0.0' },
    { ...metadata(), tag_name: 'soyli-v99.0.0-beta' },
    { ...metadata(), assets: [] },
    { ...metadata(), assets: [{ name: `soyli-${platform}.tar.gz`, state: 'uploaded', size: 100 }] },
  ])
    expect(() => parseRelease(invalid)).toThrow();
});

test('doctor reports GitHub release availability and redacted service failures through the real CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soyli-doctor-release-'));
  let response = () => Response.json(metadata());
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => response() });
  const run = async (args: string[]) => {
    const child = Bun.spawn(
      [
        ...(process.env.SPACE_TEST_CLI
          ? [process.env.SPACE_TEST_CLI]
          : [process.execPath, new URL('../index.ts', import.meta.url).pathname]),
        ...args,
      ],
      {
        env: {
          PATH: process.env.PATH,
          SPACE_ACCOUNT_HOME: join(root, 'accounts'),
          PLAYWRIGHT_BROWSERS_PATH: join(root, 'browsers'),
          SOYLI_RELEASE_API: server.url.href + '?token=fixture-private-token',
        },
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  try {
    const dryRun = await run(['update', '--dry-run', '--json']);
    expect(dryRun.code).toBe(1);
    expect(JSON.parse(dryRun.stdout).error.code).toBe('USAGE');
    const available = await run(['doctor', '--json']);
    expect(available.code).toBe(0);
    expect(JSON.parse(available.stdout).release).toMatchObject({
      status: process.env.SPACE_TEST_CLI ? 'update-available' : 'development',
      latest: '99.0.0',
    });
    response = () => new Response('Authorization: Bearer fixture-private-token', { status: 403 });
    for (const args of [['doctor'], ['doctor', '--json']]) {
      const failure = await run(args);
      expect(failure.code).toBe(0);
      expect(failure.stdout).toContain('unavailable');
      expect(failure.stdout).toContain('HTTP status: 403');
      expect(failure.stdout).toContain('rate limiting');
      expect(failure.stdout + failure.stderr).not.toContain('fixture-private-token');
    }
    response = () => Response.json(metadata('99.0.0-beta'));
    expect((await run(['doctor', '--json'])).stdout).toContain('stable soyLI release');
    response = () => new Response('missing', { status: 404 });
    expect((await run(['doctor', '--json'])).stdout).toContain('No published stable release');
    response = () => new Response('invalid json with token=must-not-leak');
    const malformed = await run(['doctor', '--json']);
    expect(JSON.parse(malformed.stdout).release.status).toBe('unavailable');
    expect(malformed.stdout).not.toContain('must-not-leak');
    response = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(1024 * 1024 + 1));
            c.close();
          },
        }),
      );
    expect((await run(['doctor', '--json'])).stdout).toContain('exceeded 1 MiB');
    if (!process.env.SPACE_TEST_CLI) {
      const refused = await run(['update', '--json']);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toContain('UPDATE_INSTALLATION');
      expect(refused.stdout).toContain('source checkout');
    }
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test('the real CLI uses the same repository-ID channel before and after ownership transfer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soyli-transfer-discovery-'));
  let repository = 'zeSchlausKwab/napplet-soy';
  let redirect = false;
  let requests = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      requests++;
      return redirect
        ? Response.redirect('https://untrusted.invalid/releases/latest')
        : Response.json({
            ...metadata(),
            html_url: `https://github.com/${repository}/releases/tag/soyli-v99.0.0`,
          });
    },
  });
  try {
    const preload = join(root, 'github-fixture.ts');
    await writeFile(
      preload,
      `
      const realFetch = globalThis.fetch;
      globalThis.fetch = (url, options) => {
        if (String(url) !== 'https://api.github.com/repositories/1370998066/releases/latest')
          throw new Error('Unexpected release channel: ' + url);
        return realFetch(${JSON.stringify(server.url.href)}, options);
      };
    `,
    );
    for (repository of ['zeSchlausKwab/napplet-soy', 'soytec/napplet-soy', 'soytec/napplet-soy']) {
      const child = Bun.spawn(
        [
          process.execPath,
          '--preload',
          preload,
          new URL('../index.ts', import.meta.url).pathname,
          'doctor',
          '--json',
        ],
        {
          env: {
            PATH: process.env.PATH,
            SPACE_ACCOUNT_HOME: join(root, 'accounts'),
            PLAYWRIGHT_BROWSERS_PATH: join(root, 'browsers'),
          },
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: 'ignore',
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stderr).toBe(0);
      const result = JSON.parse(stdout).release;
      if (redirect) expect(result.status).toBe('unavailable');
      else {
        expect(result.latest).toBe('99.0.0');
        expect(result.url).toBe(`https://github.com/${repository}/releases/tag/soyli-v99.0.0`);
      }
      if (repository === 'soytec/napplet-soy') redirect = true;
    }
    expect(requests).toBe(3);
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
