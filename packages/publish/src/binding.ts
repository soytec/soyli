import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { projectSchema, type Project } from './config';

/** Local publication identity is deliberately not part of a proposed source change. */
export const bindingSchema = z
  .object({
    version: z.literal(1),
    project: projectSchema.partial().pick({
      creator: true,
      identifier: true,
      previewId: true,
      remix: true,
      publish: true,
      backend: true,
    }),
    upstream: z
      .object({
        address: z.string(),
        relays: z.array(z.string()).max(8),
        clone: z.string(),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        manifest: z.any(),
      })
      .optional(),
  })
  .strict();
export type ProjectBinding = z.infer<typeof bindingSchema>;
export async function readBinding(directory: string): Promise<ProjectBinding | null> {
  try {
    return bindingSchema.parse(
      JSON.parse(await readFile(join(directory, '.napplet-space/project.json'), 'utf8')),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export async function writeBinding(directory: string, binding: ProjectBinding) {
  await mkdir(join(directory, '.napplet-space'), { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, '.napplet-space/project.json'),
    JSON.stringify(bindingSchema.parse(binding), null, 2) + '\n',
    { mode: 0o600 },
  );
  // Local exclude keeps clones clean without changing the upstream .gitignore.
  const exclude = join(directory, '.git/info/exclude');
  try {
    const previous = await readFile(exclude, 'utf8');
    if (!previous.includes('\n.napplet-space/'))
      await writeFile(exclude, previous + '\n.napplet-space/\nnode_modules/\n');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
export async function effectiveProject(directory: string, project: Project) {
  const binding = await readBinding(directory);
  return binding
    ? projectSchema.parse({
        ...project,
        creator: undefined,
        ...binding.project,
        ...(project.backend || binding.project.backend
          ? {
              backend: {
                ...project.backend,
                ...binding.project.backend,
                boards: project.backend?.boards ?? binding.project.backend?.boards ?? [],
                modules: project.backend?.modules ?? binding.project.backend?.modules,
              },
            }
          : {}),
      })
    : project;
}
