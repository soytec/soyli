// Test fixture helper: production publishing never manufactures commit history.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { freezeSource } from './project';
import { sourceGit } from '../../grasp/src/client';
export async function freezeFixture(
  directory: string,
  contents: Map<string, Uint8Array>,
  createdAt: number,
) {
  const source = join(directory, 'fixture');
  await mkdir(source, { recursive: true });
  await sourceGit(source, ['init', '--initial-branch=main']);
  for (const [path, bytes] of contents) await Bun.write(join(source, path), bytes);
  await sourceGit(source, ['add', '--force', '--', ...contents.keys()]);
  await sourceGit(source, ['commit', '-m', 'Source fixture']);
  return freezeSource(directory, contents, createdAt, {
    directory: source,
    commit: await sourceGit(source, ['rev-parse', 'HEAD']),
  });
}
