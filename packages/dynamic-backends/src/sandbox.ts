import { readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { workerExchange } from './worker-process';

export const ISOLATION = {
  profile: 'soy-linux-bwrap-v1',
  sourcePackBytes: 16 * 1024 * 1024,
  workspaceBytes: 128 * 1024 * 1024,
  sourceDeadlineMs: 30000,
  workerMemoryBytes: 256 * 1024 * 1024,
  workerTasks: 32,
  serviceMemoryBytes: 1024 * 1024 * 1024,
  serviceTasks: 128,
} as const;

/** Only operator-owned executables/artifacts are mounted. No checkout, home, keys or data. */
export function sandboxCommand(runtime: string, bundle: string) {
  return [
    '/usr/bin/prlimit',
    '--cpu=10',
    '--fsize=134217728',
    '--nofile=128',
    '--core=0',
    '--',
    '/opt/napplet-space/tools/soy-bwrap',
    '--unshare-all',
    '--unshare-user',
    '--disable-userns',
    '--die-with-parent',
    '--new-session',
    '--cap-drop',
    'ALL',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/lib',
    '/lib',
    '--ro-bind-try',
    '/lib64',
    '/lib64',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--size',
    String(ISOLATION.workspaceBytes),
    '--tmpfs',
    '/work',
    '--symlink',
    '/work',
    '/tmp',
    '--dir',
    '/runtime',
    '--ro-bind',
    runtime,
    '/runtime/bun',
    '--ro-bind',
    bundle,
    '/runtime/worker.js',
    '--remount-ro',
    '/',
    '--chdir',
    '/work',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--setenv',
    'HOME',
    '/work',
    '--setenv',
    'LANG',
    'C.UTF-8',
    '/runtime/bun',
    '--no-env-file',
    '/runtime/worker.js',
  ];
}

/** Fail closed on actual kernel/cgroup setup; an environment switch is not isolation. */
export async function productionSandbox(directory: string) {
  if (process.platform !== 'linux')
    throw new Error(
      'Dynamic public backends require Linux bubblewrap and a dedicated bounded cgroup.',
    );
  const cgroup = (await readFile('/proc/self/cgroup', 'utf8'))
    .trim()
    .split('\n')
    .find((line) => line.startsWith('0::'))
    ?.slice(3);
  if (!cgroup || !cgroup.endsWith('.service/supervisor'))
    throw new Error('Run the CVM in its dedicated systemd service with memory/task/CPU limits.');
  const root = dirname(resolve('/sys/fs/cgroup', '.' + cgroup));
  const [memory, swap, tasks, cpu] = await Promise.all(
    ['memory.max', 'memory.swap.max', 'pids.max', 'cpu.max'].map((file) =>
      readFile(join(root, file), 'utf8'),
    ),
  );
  if (
    !/^\d+\s*$/.test(memory) ||
    Number(memory) > ISOLATION.serviceMemoryBytes ||
    swap.trim() !== '0' ||
    !/^\d+\s*$/.test(tasks) ||
    Number(tasks) > ISOLATION.serviceTasks ||
    cpu.startsWith('max') ||
    Number(cpu.split(' ')[0]) / Number(cpu.split(' ')[1]) > 2
  )
    throw new Error(
      'Dynamic CVM cgroup must enforce MemoryMax<=1G, MemorySwapMax=0, TasksMax<=128 and CPUQuota<=200%.',
    );
  await writeFile(join(root, 'cgroup.subtree_control'), '+memory +pids +cpu');
  const runtime = await realpath(process.execPath);
  const command = async (name: string) => ({
    argv: sandboxCommand(runtime, await realpath(join(directory, name + '.js'))),
    cgroupRoot: root,
  });
  const probe = await workerExchange(
    await command('sandbox-probe'),
    { type: 'probe', hidden: directory },
    { maximum: 8192, timeoutMs: 5000 },
  );
  if (probe !== 'isolated') throw new Error('Backend OS sandbox self-test failed.');
  return {
    workerCommand: await command('worker'),
    sourceCommand: await command('source-worker'),
    isolation: ISOLATION,
  };
}
