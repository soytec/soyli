#!/usr/bin/env bun
import { migrateCommand } from './migrate';
import { lifecycleCommand } from './lifecycle';
import { diagnose, formatDiagnostic } from '../packages/diagnostics/src';
import { publishFromProject, proposeFromProject } from './share-project';
import { manageProject, editProject } from './manager';
import { MAX_ASSET_BYTES } from '../packages/assets/src';
import { checkpoint } from '../packages/publish/src/git-source';
import { proposalAction, pushSource } from '../packages/collaboration/src/service';
import { proposalList, review } from './review';
import { readBinding, writeBinding } from '../packages/publish/src/binding';
import { projectConfiguration, screenshotProject, recordProject } from './project-config';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { nip19 } from 'nostr-tools';
import { scaffold, ScaffoldInputError } from './scaffold';
import {
  Accounts,
  accountStorage,
  dangerousFileKeystore,
  sessionStorageSchema,
  type Account,
} from '../packages/identity/src/accounts';
import {
  AccountError,
  defaultSignerRelays,
  type Network,
} from '../packages/identity/src/signer';
import { ask, hiddenInput as readHiddenInput, secretStdin } from './input';
import { publicationStatus } from '../packages/publish/src';
import { outboxReport } from '../packages/publish/src/outbox-report';
import { initBackend, syncBackend, backendStatus } from './backend';
import { initModule, checkModule, moduleCommand } from './dynamic-backend';
import { checkPublication } from './publish-check';
import { preview, checkProject, doctor } from './local';
import { installBrowser, browserPaths } from './browser';
import { commandName, hostEnvironment, version } from './distribution';
import { describeRelease, updateCli } from './update';
import { setupProject, buildProject, projectTool, installConformanceBrowser } from './toolchain';
import { installCreatorSkills } from './creator-kit';
import { loadRemix, createRemix } from '../packages/remix/src';
import { testMultiplayer, multiplayerOptions } from './multiplayer';

if (process.argv.includes('--internal-backend-worker')) {
  await (await import('../packages/dynamic-backends/src/worker')).backendWorker();
  await new Promise(() => {});
}

const help = `napplet soyLI

Usage:
  bun run soyli new <folder> [--template boilerplate] [--identity create|connect|later] [--no-install]
  bun run soyli remix <portable-link-or-nostr-id> <folder> [--identity create|connect|later]
  bun run soyli checkpoint "Describe your changes"
  bun run soyli propose "Describe the proposal" [--resume]
  bun run soyli proposals [repository-or-proposal] [--json]
  bun run soyli review [repository-or-proposal] [--no-open] [--rebuild]
  bun run soyli merge <proposal> --revision <event-id> --target <reviewed-local-commit>
  bun run soyli comment <proposal> "Comment" | close|reopen <proposal> ["Reason"]
  bun run soyli push
  bun run soyli setup|build [--project <folder>]
  bun run soyli run <package-script> [arguments...]
  bun run soyli exec <project-tool> [arguments...]
  bun run soyli assets list|sync|remove <id> [--project <folder>]
  bun run soyli assets add <file> <id> [--storage embedded|external] [--license <license>]
  bun run soyli project show|set <json-file> [--project <folder>]
  bun run soyli config [init] [--project <folder>]
  bun run soyli backend init|sync|status [--project <folder>]
  bun run soyli backend init-module|check [manifest.json] [--project <folder>]
  bun run soyli backend deploy <manifest.json> | describe|disable|enable <module-name>
  bun run soyli backend delete-release <module-name> --revision <release-hash>
  bun run soyli multiplayer <scenario.mjs> [--players 2] [--latency 50] [--jitter 15] [--seed 1]
    [--project <folder>] [--timeout 60] [--turn-binary <coturn-executable>]
  bun run soyli record [preview.webm] [--project <folder>]
  bun run soyli screenshot [preview.png] [--project <folder>]
  bun run soyli skills update [--project <folder>]
  bun run soyli account create [--new]
  bun run soyli account show|list|check|backup
  bun run soyli account connect [--stdin] [--session-storage file|keychain]
  bun run soyli account pair [--signer-relay <url>] [--timeout <seconds>] [--open] [--session-storage file|keychain]
  bun run soyli account storage file|keychain
  bun run soyli account import [--stdin]
  bun run soyli account use <npub-or-account-id>
  bun run soyli account export <new-recovery-file> [--passphrase-stdin]
  bun run soyli publish [--project <folder>] [--snapshot] [--dry-run | --resume]
  bun run soyli unpublish|republish|delete [--project <folder>] [--dry-run | --confirm <token> | --resume]
  bun run soyli lifecycle [--project <folder>]
  bun run soyli migrate <napplet-link-or-naddr> [--relay <url>] [--dry-run | --confirm <token> | --resume]
  bun run soyli status [--project <folder>] [--refresh]
  bun run soyli dev [--project <folder>] [--port 4173] [--no-open]
  bun run soyli check [--project <folder>]
  bun run soyli browser install
  bun run soyli browser path [--json]
  bun run soyli doctor [--project <folder>]
  bun run soyli update
  bun run soyli --version

All commands accept --network public|local and --json.
Dev prefers port 4173 and chooses a free port if busy. --port fixes a port; --port 0 chooses any free port.
Development fallback: SOYLI_DANGEROUS_PLAINTEXT_KEYS=1 enables separate, unencrypted
owner-only account files outside Git. Unset it to return to OS-vault accounts.
Create reuses your selected account; account create --new creates and selects another.
Previous identities and backups are kept. Connect accepts a hidden bunker link.
Publish uses the selected account; a running publication keeps its starting account.
Publish updates the stable listing. --snapshot also creates an independent immutable copy.
Each public key keeps separate releases in the same folder. Status/resume use the selected author.
Pair creates a nostrconnect link and QR to approve in your signer (120-second wait).
Remote sessions default to owner-only files outside projects; local private keys use the OS vault.
Use --session-storage keychain with connect/pair to opt in. account storage file migrates
the selected remote session with one OS-vault read, without pairing again.
Signer relays carry encrypted signing requests; they do not change publishing targets.
Create and new save a private nsec backup outside Git projects and report its path.
Account backup saves/reuses that file for an existing local creator. Keep it private.
Import accepts a hidden nsec or encrypted NIP-49 recovery key. With --stdin,
provide the key on line 1 and, for an encrypted key, its passphrase on line 2.
Export writes a passphrase-encrypted NIP-49 file outside Git projects.
Publish targets: --relay <url> --blossom <origin> --grasp <origin> --site <origin>
and optional repeated --mirror <url>. Local mode defaults to the dev services.
Secrets never belong in command arguments. Check/publish download a cached Chromium
browser when needed. Git is required to publish. OS-vault accounts also need an unlocked credential store.`.replaceAll(
  'bun run soyli',
  commandName,
);
let json = process.argv.slice(2).includes('--json');
let createdProject: string | undefined;
let operation = 'starting soyli';
const controller = new AbortController();
const launcherPid = process.ppid;
function shutdown(code: number) {
  if (controller.signal.aborted) return;
  controller.abort();
  // Native keychain prompts cannot be aborted. The pending reservation is
  // recoverable even when we must exit before that OS operation returns.
  setTimeout(() => process.exit(code), 1000).unref();
}
for (const [signal, code] of [
  ['SIGTERM', 143],
  ['SIGINT', 130],
  ['SIGHUP', 129],
] as const) {
  process.once(signal, () => shutdown(code));
}
const hiddenInput = (label: string) => readHiddenInput(label, controller.signal);
const publicAccount = (a: Account, network: Network) => ({
  id: a.id,
  npub: nip19.npubEncode(a.pubkey),
  pubkey: a.pubkey,
  type: a.type,
  status: a.status,
  storage: accountStorage(a),
  ...(a.sessionCleanup ? { storageCleanupPending: true } : {}),
  network,
});
try {
  const raw = process.argv.slice(2);
  // Only known command names, never arbitrary arguments or signing inputs.
  if (
    new Set([
      'new',
      'remix',
      'setup',
      'build',
      'run',
      'exec',
      'skills',
      'account',
      'publish',
      'unpublish',
      'republish',
      'delete',
      'lifecycle',
      'status',
      'dev',
      'check',
      'browser',
      'doctor',
      'update',
      'backend',
      'checkpoint',
      'push',
      'propose',
      'review',
      'merge',
      'comment',
      'close',
      'reopen',
      'config',
      'screenshot',
      'record',
      'assets',
      'project',
      'multiplayer',
    ]).has(raw[0])
  )
    operation = `soyli ${raw[0]}`;
  if (raw[0] === 'run' || raw[0] === 'exec') {
    if (!raw[1] || raw[1].startsWith('-'))
      throw new AccountError('USAGE', 'Use run <package-script> or exec <project-tool>.');
    if (!(await Bun.file(join(process.cwd(), 'node_modules/.modules.yaml')).exists()))
      await setupProject(process.cwd(), controller.signal);
    if (raw[0] === 'run' && raw[1] === 'test:conformance')
      await installConformanceBrowser(process.cwd(), controller.signal);
    await projectTool(process.cwd(), raw, controller.signal);
    process.exit(0);
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        confirm: { type: 'string' },
        revision: { type: 'string' },
        target: { type: 'string' },
        rebuild: { type: 'boolean' },
        storage: { type: 'string' },
        license: { type: 'string' },
        template: { type: 'string' },
        'no-install': { type: 'boolean' },
        identity: { type: 'string' },
        new: { type: 'boolean' },
        network: { type: 'string', default: 'public' },
        stdin: { type: 'boolean' },
        'passphrase-stdin': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
        version: { type: 'boolean' },
        port: { type: 'string' },
        'no-open': { type: 'boolean' },
        project: { type: 'string' },
        'dry-run': { type: 'boolean' },
        resume: { type: 'boolean' },
        snapshot: { type: 'boolean' },
        refresh: { type: 'boolean' },
        relay: { type: 'string' },
        blossom: { type: 'string' },
        grasp: { type: 'string' },
        site: { type: 'string' },
        mirror: { type: 'string', multiple: true },
        'signer-relay': { type: 'string', multiple: true },
        'session-storage': { type: 'string' },
        timeout: { type: 'string' },
        open: { type: 'boolean' },
        players: { type: 'string' },
        latency: { type: 'string' },
        jitter: { type: 'string' },
        seed: { type: 'string' },
        'turn-binary': { type: 'string' },
      },
    });
  } catch {
    throw new AccountError(
      'USAGE',
      'Unknown or invalid option. Use --help. Secrets must be entered at the hidden prompt or through stdin.',
    );
  }
  const { values, positionals } = parsed;
  json = !!values.json;
  if (values.version) {
    console.log(json ? JSON.stringify({ version }) : `soyli ${version}`);
    process.exit(0);
  }
  if (values.help || !positionals.length) {
    console.log(help);
    process.exit(0);
  }
  if (!['public', 'local'].includes(values.network!))
    throw new AccountError('USAGE', 'Choose --network public or local.');
  if (positionals[0] === 'update') {
    if (
      positionals.length !== 1 ||
      Object.keys(values).some((key) => !['json', 'network'].includes(key))
    )
      throw new AccountError(
        'USAGE',
        'Use soyli update [--json]. For a read-only version check, run soyli doctor.',
      );
    const result = await updateCli(controller.signal);
    console.log(
      json
        ? JSON.stringify(result)
        : result.status === 'updated'
          ? `Updated soyLI ${result.previous} → ${result.version}. Restart any running soyli dev sessions.\nRun soyli skills update in existing projects to refresh agent guidance.`
          : result.status === 'current'
            ? `soyLI ${result.version} is up to date.`
            : `soyLI ${result.version} is newer than the published release; no downgrade.`,
    );
    process.exit(0);
  }
  if (values.snapshot && positionals[0] !== 'publish')
    throw new AccountError(
      'USAGE',
      'Use --snapshot only with soyli publish to request an independent immutable copy.',
    );
  const network = values.network as Network;
  const sessionStorage = sessionStorageSchema.safeParse(values['session-storage'] ?? 'file');
  if (
    !sessionStorage.success ||
    (values['session-storage'] !== undefined &&
      !(positionals[0] === 'account' && ['connect', 'pair'].includes(positionals[1])))
  )
    throw new AccountError(
      'USAGE',
      'Use --session-storage file|keychain only with account connect or account pair.',
    );
  const accounts = new Accounts(network);
  if (dangerousFileKeystore())
    process.stderr.write(
      `WARNING: Dangerous plaintext key storage enabled at ${accounts.directory}. Keys are NOT encrypted. Keep this directory private and outside Git.\n`,
    );
  const onAuth = async (url: string) => {
    if (!process.stdin.isTTY || json)
      throw new AccountError(
        'SIGNER_AUTH',
        'Authorize this client in your remote signer, then retry interactively.',
      );
    process.stderr.write(`Approve this request in your signer: ${url}\n`);
  };
  const connect = async () =>
    accounts.connect(
      (values.stdin
        ? (await secretStdin())[0]
        : await hiddenInput('Paste bunker connection link (hidden): ')
      ).trim(),
      { signal: controller.signal, onAuth, sessionStorage: sessionStorage.data },
    );
  const backupNotice = (path: string) =>
    `Private-key backup: ${path}\nThis unencrypted nsec file is outside your project and readable only by your user. Preserve a private copy to recover your identity.`;
  const output = (account: Account | null, backupFile?: string) => {
    const data = account ? publicAccount(account, network) : null;
    if (json) console.log(JSON.stringify({ account: data, ...(backupFile ? { backupFile } : {}) }));
    else
      console.log(
        data
          ? `${data.npub}\n${data.type === 'local' ? 'Local key' : 'Remote signer'} · ${network} · ${data.status}\nStorage: ${data.storage}${data.storageCleanupPending ? ' (old-copy cleanup pending; retry account storage)' : ''}${data.type === 'remote' && data.storage === 'file' ? '\nPrivate session file outside projects; your Nostr private key stays with the signer.' : ''}`
          : 'No creator selected. Run account create or account connect.',
      );
    if (!json && backupFile) console.log(backupNotice(backupFile));
  };
  const [command, action, argument, ...extra] = positionals;
  if (['unpublish', 'republish', 'delete', 'lifecycle'].includes(command)) {
    const allowed = new Set(['network', 'json', 'project', 'dry-run', 'confirm', 'resume']);
    if (
      action ||
      Object.entries(values).some(([k, v]) => v !== undefined && !allowed.has(k)) ||
      (values['dry-run'] && values.confirm) ||
      (command === 'lifecycle' && (values['dry-run'] || values.confirm || values.resume))
    )
      throw new AccountError(
        'USAGE',
        'Use unpublish|republish|delete [--project folder] [--dry-run | --confirm token | --resume], or lifecycle to view saved progress.',
      );
    await lifecycleCommand({
      directory: values.project ?? process.cwd(),
      network,
      operation: command as 'unpublish' | 'republish' | 'delete' | 'lifecycle',
      dryRun: values['dry-run'],
      confirm: values.confirm,
      resume: values.resume,
      json,
      signal: controller.signal,
      accounts,
      onAuth,
    });
    process.exit(process.exitCode ?? 0);
  }
  if (command === 'migrate') {
    const allowed = new Set(['network', 'json', 'dry-run', 'resume', 'confirm', 'relay', 'mirror']);
    if (
      !action ||
      argument ||
      extra.length ||
      (values['dry-run'] && (values.resume || values.confirm)) ||
      Object.entries(values).some(([key, value]) => value !== undefined && !allowed.has(key))
    )
      throw new AccountError(
        'USAGE',
        'Use migrate <napplet-link-or-naddr> [--relay url] [--dry-run | --confirm token | --resume].',
      );
    await migrateCommand({
      reference: action,
      network,
      accounts,
      primary: values.relay,
      mirrors: values.mirror,
      dryRun: values['dry-run'],
      confirm: values.confirm,
      resume: values.resume,
      json,
      signal: controller.signal,
      onAuth,
    });
    process.exit(process.exitCode ?? 0);
  }
  if (values.confirm)
    throw new AccountError('USAGE', 'Use --confirm only with unpublish, republish or delete.');

  if ((values.storage || values.license) && !(command === 'assets' && action === 'add'))
    throw new AccountError('USAGE', 'Use --storage and --license with assets add.');
  if (values.storage && !['embedded', 'external'].includes(values.storage))
    throw new AccountError('USAGE', 'Choose --storage embedded or external.');
  if (values.new && !(command === 'account' && action === 'create'))
    throw new AccountError('USAGE', 'Use --new only with account create.');
  if (
    (values['signer-relay'] || (values.timeout && command !== 'multiplayer') || values.open) &&
    !(command === 'account' && action === 'pair')
  )
    throw new AccountError('USAGE', 'Use --signer-relay, --timeout and --open with account pair.');
  if (
    (values.players || values.latency || values.jitter || values.seed || values['turn-binary']) &&
    command !== 'multiplayer'
  )
    throw new AccountError(
      'USAGE',
      'Use --players, --latency, --jitter, --seed and --turn-binary with multiplayer.',
    );
  const publishingOptions =
    values['dry-run'] ||
    values.resume ||
    values.refresh ||
    values.relay ||
    values.blossom ||
    values.grasp ||
    values.site ||
    values.mirror;
  if (!['publish', 'status', 'propose'].includes(command) && publishingOptions)
    throw new AccountError('USAGE', 'Publication options are only valid for publish/status.');
  if (
    command === 'propose' &&
    (values['dry-run'] ||
      values.refresh ||
      values.relay ||
      values.blossom ||
      values.grasp ||
      values.site ||
      values.mirror)
  )
    throw new AccountError(
      'USAGE',
      'Propose accepts --resume and uses the targets shown by soyli config. Edit those targets before proposing; --dry-run is only available for publish.',
    );
  if (
    (values['no-install'] && !['new', 'remix'].includes(command)) ||
    (values.project &&
      ![
        'publish',
        'status',
        'dev',
        'check',
        'setup',
        'build',
        'assets',
        'doctor',
        'project',
        'skills',
        'config',
        'screenshot',
        'record',
        'backend',
        'multiplayer',
        'checkpoint',
        'propose',
        'proposals',
        'review',
        'merge',
        'comment',
        'close',
        'reopen',
        'push',
      ].includes(command)) ||
    ((values.port || values['no-open']) && !['dev', 'review'].includes(command))
  )
    throw new AccountError(
      'USAGE',
      'Use --project with project commands or doctor; --port and --no-open with dev/review.',
    );
  const collaboration = {
    directory: values.project ?? process.cwd(),
    network,
    accounts,
    signal: controller.signal,
    onAuth,
  };
  if (
    [
      'checkpoint',
      'propose',
      'proposals',
      'review',
      'merge',
      'comment',
      'close',
      'reopen',
      'push',
    ].includes(command)
  ) {
    let result: unknown;
    if (command === 'checkpoint') {
      if (!action || argument)
        throw new AccountError('USAGE', 'Use checkpoint "Describe your changes".');
      const account = await accounts.current();
      result = await checkpoint(collaboration.directory, action, account?.pubkey);
    } else if (command === 'propose') {
      if ((!action && !values.resume) || argument)
        throw new AccountError('USAGE', 'Use propose "Description" or propose --resume.');
      result = await proposeFromProject({
        ...collaboration,
        description: action ?? '',
        resume: values.resume,
      });
    } else if (command === 'proposals')
      result = await proposalList({ ...collaboration, reference: action });
    else if (command === 'review') {
      await review({
        ...collaboration,
        reference: action,
        noOpen: values['no-open'],
        json,
        rebuild: values.rebuild,
        port: values.port ? Number(values.port) : undefined,
      });
    } else if (command === 'push') result = await pushSource(collaboration);
    else {
      if (!action) throw new AccountError('USAGE', 'Supply a proposal event id.');
      result = await proposalAction({
        ...collaboration,
        proposal: action,
        action: command as 'merge' | 'comment' | 'close' | 'reopen',
        revision: values.revision,
        target: values.target,
        text: argument,
      });
    }
    if (result) console.log(JSON.stringify(result, null, json ? undefined : 2));
  } else if (command === 'new' || command === 'remix') {
    if (
      !action ||
      (command === 'new' ? !!argument : !argument || !!values.template) ||
      extra.length ||
      values.stdin ||
      values['passphrase-stdin'] ||
      (values.identity && !['create', 'connect', 'later'].includes(values.identity))
    )
      throw new AccountError(
        'USAGE',
        'Use new <folder> [--template name] [--identity create|connect|later].',
      );
    const template = values.template ?? 'boilerplate';
    const folder = command === 'remix' ? argument! : action;
    const remix =
      command === 'remix'
        ? await createRemix(
            process.cwd(),
            folder,
            await loadRemix(
              action,
              network,
              AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]),
            ),
          )
        : undefined;
    const directory = remix?.directory ?? (await scaffold(process.cwd(), folder, template));
    if (remix && remix.source !== 'git') await installCreatorSkills(directory);
    createdProject = directory;
    let account = values.identity === 'later' ? null : await accounts.current();
    let identity = values.identity;
    if (!account && !identity && process.stdin.isTTY && !json) {
      const answer = (
        await ask(
          'Creator identity: [1] Create new [2] Connect existing [3] Set up later (1): ',
          controller.signal,
        )
      ).trim();
      if (!['', '1', '2', '3'].includes(answer))
        throw new AccountError(
          'USAGE',
          'Choose 1, 2 or 3 for creator setup. Your preview project is ready; use the account commands to finish setup.',
        );
      identity = answer === '2' ? 'connect' : answer === '3' ? 'later' : 'create';
    }
    if (identity === 'create') account = await accounts.create();
    if (identity === 'connect') account = await connect();
    if (identity === 'later') account = null;
    if (account) {
      const binding = (await readBinding(directory)) ?? { version: 1 as const, project: {} };
      binding.project.creator = { pubkey: account.pubkey, network };
      await writeBinding(directory, binding);
    }
    const backupFile = account?.type === 'local' ? await accounts.backup(account.id) : undefined;
    // Report recovery information before dependency setup, which may be interrupted or fail.
    if (backupFile && !json) console.log(backupNotice(backupFile));
    if (!remix && template === 'boilerplate' && !values['no-install']) {
      await setupProject(directory, controller.signal);
      await buildProject(directory, controller.signal);
    }
    if (json)
      console.log(
        JSON.stringify({
          directory,
          account: account ? publicAccount(account, network) : null,
          ...(backupFile ? { backupFile } : {}),
          ...(remix ? { remix } : {}),
        }),
      );
    else
      console.log(
        `\nYour napplet is ready at ${directory}\n\n  cd ${folder}\n${remix?.needsSetup ? '  soyli setup\n' : ''}  soyli dev\n\n${remix ? '' : 'Starting scaffold committed locally. Nothing has been uploaded.\n'}Open your coding agent in that folder and make something weird.\n${account ? `Creator: ${nip19.npubEncode(account.pubkey)}` : 'Creator setup can be completed with account create or account connect.'}\nYour code and pushed Git history are open source by default.\nSave edits with soyli checkpoint "Describe your changes", then soyli publish or soyli propose "Description".`,
      );
  } else if (command === 'multiplayer') {
    if (
      !action ||
      argument ||
      extra.length ||
      values.template ||
      values.identity ||
      values.stdin ||
      values['passphrase-stdin']
    )
      throw new AccountError('USAGE', 'Use soyli multiplayer <scenario.mjs> [--project folder].');
    const parsed = multiplayerOptions.safeParse({
      players: Number(values.players ?? 2),
      latencyMs: Number(values.latency ?? 0),
      jitterMs: Number(values.jitter ?? 0),
      seed: Number(values.seed ?? 1),
      timeoutMs: Number(values.timeout ?? 60) * 1000,
      turnBinary: values['turn-binary'],
    });
    if (!parsed.success)
      throw new AccountError(
        'USAGE',
        'Choose 2–8 players, 0–1000 ms latency, 0–500 ms jitter, seed 1–2147483647 and a 1–300 second timeout.',
      );
    const result = await testMultiplayer(
      values.project ?? process.cwd(),
      action,
      parsed.data,
      controller.signal,
    );
    console.log(
      json
        ? JSON.stringify(result)
        : `${result.status === 'passed' ? 'Passed' : 'Failed'}: ${result.checks.length} scenario assertions.\n${result.failure ? result.failure + '\n' : ''}${result.warnings.map((warning) => warning + '\n').join('')}Report: ${result.reportPath}`,
    );
    if (result.status !== 'passed') process.exitCode = 1;
  } else if (command === 'backend') {
    if (
      [
        'init-module',
        'check',
        'deploy',
        'describe',
        'disable',
        'enable',
        'delete-release',
      ].includes(action)
    ) {
      if (extra.length || (action === 'init-module' && argument))
        throw new AccountError('USAGE', 'Unexpected backend arguments.');
      const directory = values.project ?? process.cwd();
      const result =
        action === 'init-module'
          ? await initModule(directory)
          : action === 'check'
            ? await checkModule(directory, argument)
            : await moduleCommand(
                directory,
                network,
                accounts,
                action,
                argument ?? (action === 'deploy' ? 'backend/backend.json' : 'main'),
                { signal: controller.signal, onAuth },
                values.revision,
              );
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (argument || extra.length || !['init', 'sync', 'status'].includes(action))
        throw new AccountError('USAGE', 'Use soyli backend init|sync|status [--project folder].');
      const directory = values.project ?? process.cwd();
      const result =
        action === 'init'
          ? await initBackend(directory, network, accounts)
          : action === 'sync'
            ? await syncBackend(directory, network, accounts, { signal: controller.signal, onAuth })
            : await backendStatus(directory, network);
      console.log(JSON.stringify(result, null, 2));
    }
  } else if (command === 'assets' || command === 'project') {
    const root = values.project ?? process.cwd();
    const current = await manageProject(root, network);
    let result: unknown = current;
    if (command === 'project' && action === 'set' && argument && !extra.length) {
      const file = Bun.file(argument);
      if (file.size > 8192) throw new AccountError('PROJECT_EDIT', 'Metadata file is too large.');
      result = await editProject(root, network, {
        action: 'project',
        revision: current.revision,
        changes: await file.json(),
      });
    } else if (command === 'assets' && action === 'add' && argument && extra.length === 1) {
      const file = Bun.file(argument);
      if (file.size > MAX_ASSET_BYTES)
        throw new AccountError(
          'ASSET_LIMIT',
          'The current runtime asset limit is 10 MiB per file.',
        );
      result = await editProject(root, network, {
        action: 'asset',
        revision: current.revision,
        id: extra[0],
        storage: values.storage ?? 'external',
        license: values.license ?? current.project.license,
        data: Buffer.from(await file.arrayBuffer()).toString('base64'),
      });
    } else if (command === 'assets' && action === 'remove' && argument && !extra.length)
      result = await editProject(root, network, {
        action: 'asset-remove',
        revision: current.revision,
        id: argument,
      });
    else if (command === 'assets' && action === 'sync' && !argument)
      result = await editProject(root, network, {
        action: 'asset-sync',
        revision: current.revision,
      });
    else if (
      (command === 'assets' && action !== 'list') ||
      (command === 'project' && action !== 'show') ||
      argument ||
      extra.length
    )
      throw new AccountError(
        'USAGE',
        'Use assets list|add <file> <id>|remove <id>|sync or project show|set <json-file>.',
      );
    console.log(JSON.stringify(result, null, json ? 0 : 2));
  } else if (command === 'skills') {
    if (
      action !== 'update' ||
      argument ||
      extra.length ||
      values.template ||
      values.identity ||
      values.stdin ||
      values['passphrase-stdin']
    )
      throw new AccountError('USAGE', 'Use skills update [--project folder].');
    const result = await installCreatorSkills(values.project ?? process.cwd());
    console.log(
      json
        ? JSON.stringify(result)
        : `${result.updated.length} skill/support files updated. ${result.conflicts.length} edited files preserved.${result.conflicts.length ? '\n' + result.conflicts.join('\n') : ''}`,
    );
    if (result.conflicts.length) process.exitCode = 1;
  } else if (['dev', 'check', 'doctor', 'browser', 'setup', 'build'].includes(command)) {
    if (
      values.template ||
      values.identity ||
      values.stdin ||
      values['passphrase-stdin'] ||
      argument ||
      extra.length ||
      (command === 'browser' ? !['install', 'path'].includes(action) : !!action)
    )
      throw new AccountError('USAGE', 'Use dev, check, doctor, or browser install|path.');
    if (command === 'setup' || command === 'build') {
      const directory = values.project ?? process.cwd();
      if (command === 'setup') await setupProject(directory, controller.signal);
      else await buildProject(directory, controller.signal);
      console.log(
        json
          ? JSON.stringify({ status: command === 'setup' ? 'ready' : 'built' })
          : `${command === 'setup' ? 'Project dependencies ready.' : 'Built dist/index.html.'}`,
      );
    } else if (command === 'dev') {
      const port = Number(values.port ?? 4173);
      if (
        !/^\d+$/.test(values.port ?? '4173') ||
        !Number.isInteger(port) ||
        port < 0 ||
        port > 65535
      )
        throw new AccountError('USAGE', 'Choose a port from 0 to 65535.');
      // Agent launchers sometimes exit without delivering a terminal signal.
      // Supervise only this foreground preview, never scan/kill other projects
      // or treat closed stdin as an exit (agents commonly ignore stdin).
      const ownerCheck =
        launcherPid > 1
          ? setInterval(() => {
              if (controller.signal.aborted) return;
              let exited = process.ppid !== launcherPid;
              try {
                process.kill(launcherPid, 0);
              } catch (error) {
                exited ||= (error as NodeJS.ErrnoException).code === 'ESRCH';
              }
              if (exited) {
                console.error('Preview launcher exited; stopping the preview and build watcher.');
                shutdown(0);
              }
            }, 500)
          : undefined;
      ownerCheck?.unref();
      try {
        await preview(
          values.project ?? process.cwd(),
          values.port === undefined ? undefined : port,
          !values['no-open'],
          json,
          controller.signal,
          network,
        );
      } finally {
        clearInterval(ownerCheck);
      }
    } else {
      const result =
        command === 'check'
          ? await checkProject(values.project ?? process.cwd(), network)
          : command === 'doctor'
            ? await doctor(controller.signal, values.project)
            : action === 'path'
              ? await browserPaths()
              : (await installBrowser(), { browser: 'ready' });
      console.log(
        json
          ? JSON.stringify(result)
          : Object.entries(result)
              .map(
                ([key, value]) =>
                  `${key}: ${key === 'release' ? describeRelease(value as Awaited<ReturnType<typeof doctor>>['release']) : typeof value === 'object' ? JSON.stringify(value) : value}`,
              )
              .join('\n'),
      );
    }
  } else if (command === 'config' || command === 'screenshot' || command === 'record') {
    if (
      argument ||
      extra.length ||
      values.template ||
      values.identity ||
      values.stdin ||
      values['passphrase-stdin'] ||
      (command === 'config' && action && action !== 'init')
    )
      throw new AccountError(
        'USAGE',
        'Use config [init] or screenshot [preview.png] or record [preview.webm], optionally with --project.',
      );
    const result =
      command === 'config'
        ? await projectConfiguration(values.project ?? process.cwd(), network, action === 'init')
        : command === 'record'
          ? await recordProject(values.project ?? process.cwd(), network, action)
          : await screenshotProject(values.project ?? process.cwd(), network, action);
    console.log(JSON.stringify(result, null, json ? undefined : 2));
  } else if (command === 'publish' || command === 'status') {
    if (
      action ||
      values.template ||
      values.identity ||
      values.stdin ||
      values['passphrase-stdin'] ||
      (command === 'publish' && values.refresh) ||
      (command === 'status' &&
        (values['dry-run'] ||
          values.resume ||
          values.snapshot ||
          values.relay ||
          values.blossom ||
          values.grasp ||
          values.site ||
          values.mirror))
    )
      throw new AccountError(
        'USAGE',
        'Use publish [--project folder] [--snapshot] [--dry-run | --resume], or status [--project folder].',
      );
    const targets = {
      ...(values.relay ? { relay: values.relay } : {}),
      ...(values.blossom ? { blossom: values.blossom } : {}),
      ...(values.grasp ? { grasp: values.grasp } : {}),
      ...(values.site ? { site: values.site } : {}),
      ...(values.mirror ? { mirrors: values.mirror } : {}),
    };
    const result =
      command === 'status'
        ? await publicationStatus(values.project ?? process.cwd(), network, {
            creator: (await accounts.current())?.pubkey,
            refresh: values.refresh,
            signal: controller.signal,
          })
        : await (async () => {
            return publishFromProject({
              directory: values.project ?? process.cwd(),
              network,
              targets,
              accounts,
              dryRun: values['dry-run'],
              resume: values.resume,
              snapshot: values.snapshot,
              check: checkPublication,
              requirePreview: true,
              signal: controller.signal,
              onAuth,
              progress: json
                ? undefined
                : (stage) => process.stderr.write(`Publishing: ${stage}\n`),
              summary: json
                ? undefined
                : (plan, repository) =>
                    process.stderr.write(
                      `Creator: ${plan.pubkey}\nSource (${plan.sourceBytes} bytes, ${JSON.stringify(plan.license)}):\n${plan.files.map((file) => `  ${file.path}`).join('\n')}\nRelay: ${plan.targets.relay}\nBlossom: ${plan.targets.blossom}\nGit: ${repository ? `your repository ${repository.address} (${repository.origin}); soyLI verifies the pushed commit and does not write to it` : plan.targets.grasp}\nSite: ${plan.targets.site}\nAdditional relay copies (best effort): ${plan.targets.mirrors.join(', ') || 'none'}\nYour outbox relays (best effort): NIP-65 write relays, looked up when publishing\nPreview: selected PNG or automatic sandbox capture\n`,
                    ),
            });
          })();
    if (json) console.log(JSON.stringify(result));
    else if (result.status === 'dry_run') console.log(JSON.stringify(result, null, 2));
    else if (result.status === 'not_started')
      console.log(
        'No publication yet. Run publish --dry-run to inspect the source and destinations.',
      );
    else {
      console.log(
        `${result.unchanged ? 'Existing publication' : 'Publication'}: ${result.status}\nSource commit: ${result.sourceCommit}\nNapplet: ${result.naddr}${result.snapshotId ? `\nIndependent snapshot: ${result.snapshotId}` : ''}\n${result.websiteReady ? `Website confirmed at ${new Date(result.websiteCheckedAt!).toISOString()}: ${result.url}\nPinned version: ${result.snapshotUrl}` : `Website ${result.websiteStatus}; the route is not yet confirmed: ${result.url}`}`,
      );
      if (result.preview)
        console.log(
          `Preview: ${result.preview.url}\nSaved image: ${join(values.project ?? process.cwd(), '.napplet-space', network, result.jobId, 'preview.png')}`,
        );
      if (result.error) console.log(`${result.error.code}: ${result.error.message}`);
      for (const [relay, failure] of Object.entries(result.mirrorErrors)) {
        console.log(
          `Optional mirror failed: ${relay}\nEvent: kind ${failure.eventKind} · ${failure.eventId}\n${formatDiagnostic(failure.diagnostic)}`,
        );
      }
      for (const line of outboxReport(result.outbox)) console.log(line);
      if (result.websiteReady)
        console.log(
          'Readable link: open the napplet page, connect the creator account and choose Named link. Claim /@your-handle/your-slug once; future releases keep it.',
        );
    }
  } else if (command === 'account') {
    if (
      !action ||
      extra.length ||
      values.template ||
      values.identity ||
      (argument && !['export', 'use', 'storage'].includes(action)) ||
      (values.stdin && !['import', 'connect'].includes(action)) ||
      (values['passphrase-stdin'] && action !== 'export')
    )
      throw new AccountError('USAGE', 'Invalid account command/options. Use --help.');
    switch (action) {
      case 'create': {
        const account = await accounts.create({ fresh: values.new });
        if (!json)
          console.log(
            values.new
              ? `New creator selected. Previous identities are kept; see ${commandName} account list.`
              : `Creator ready (reuses the selected identity when present). For a different key, use ${commandName} account create --new.`,
          );
        output(account, account.type === 'local' ? await accounts.backup(account.id) : undefined);
        break;
      }
      case 'backup': {
        const backupFile = await accounts.backup();
        console.log(
          json ? JSON.stringify({ backupFile, format: 'nsec' }) : backupNotice(backupFile),
        );
        break;
      }
      case 'show':
        output(await accounts.current());
        break;
      case 'list': {
        const current = await accounts.current();
        const rows = (await accounts.list()).map((a) => ({
          ...publicAccount(a, network),
          selected: a.id === current?.id,
        }));
        console.log(
          json
            ? JSON.stringify({ accounts: rows })
            : rows
                .map(
                  (a) =>
                    `${a.selected ? '*' : ' '} ${a.id} ${a.npub} ${a.type} ${a.status} · ${a.storage}${a.storageCleanupPending ? ' (cleanup pending)' : ''}`,
                )
                .join('\n') || 'No saved creators.',
        );
        break;
      }
      case 'connect':
        output(await connect());
        break;
      case 'storage': {
        const storage = sessionStorageSchema.safeParse(argument);
        if (
          !storage.success ||
          Object.keys(values).some((key) => !['network', 'json'].includes(key))
        )
          throw new AccountError(
            'USAGE',
            'Use account storage file|keychain [--network public|local] [--json] for the selected remote signer.',
          );
        output(await accounts.setSessionStorage(storage.data));
        break;
      }
      case 'pair': {
        const timeout = Number(values.timeout ?? 120);
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600 || (json && values.open))
          throw new AccountError(
            'USAGE',
            'Pairing timeout must be 1–600 seconds; --open requires text output.',
          );
        const relays =
          values['signer-relay'] ??
          (network === 'local' ? ['ws://127.0.0.1:19347'] : defaultSignerRelays);
        output(
          await accounts.pair(relays, {
            name: 'napplet soyLI',
            signal: controller.signal,
            timeoutMs: timeout * 1000,
            onAuth,
            sessionStorage: sessionStorage.data,
            onPairing: async (uri) => {
              if (json)
                console.log(JSON.stringify({ pairing: { uri, relays, timeoutSeconds: timeout } }));
              else {
                console.log(
                  `Open or paste this one-time link in your NIP-46 signer. Keep it private.\n${uri}\n`,
                );
                if (process.stdout.isTTY) {
                  const qr = await import('qrcode');
                  console.log(await qr.toString(uri, { type: 'terminal', small: true }));
                }
                console.log(`Waiting up to ${timeout} seconds for approval. Ctrl+C cancels.`);
                if (values.open) {
                  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
                  try {
                    const child = Bun.spawn([opener, uri], {
                      env: hostEnvironment(),
                      stdout: 'ignore',
                      stderr: 'ignore',
                    });
                    void child.exited;
                  } catch {
                    console.log('Could not open your signer. Copy the link above.');
                  }
                }
              }
            },
          }),
        );
        break;
      }
      case 'import': {
        const lines = values.stdin
          ? await secretStdin()
          : [await hiddenInput('Recovery key / nsec (hidden): ')];
        const secret = lines[0].trim();
        const password = secret.startsWith('ncryptsec1')
          ? values.stdin
            ? lines[1]
            : await hiddenInput('Recovery passphrase (hidden): ')
          : undefined;
        output(await accounts.import(secret, password));
        break;
      }
      case 'use':
        if (!argument) throw new AccountError('USAGE', 'Choose an account from account list.');
        output(await accounts.use(argument, { signal: controller.signal, onAuth }));
        break;
      case 'check': {
        const signer = await accounts.signer({ signal: controller.signal, onAuth });
        try {
          await signer.getPublicKey();
          output(await accounts.current());
        } finally {
          await signer.close();
        }
        break;
      }
      case 'export': {
        if (!argument)
          throw new AccountError('USAGE', 'Specify a new recovery filename outside Git projects.');
        const password = values['passphrase-stdin']
          ? (await secretStdin())[0]
          : await hiddenInput('New recovery passphrase (12+ characters, hidden): ');
        if (
          !values['passphrase-stdin'] &&
          password !== (await hiddenInput('Repeat passphrase (hidden): '))
        )
          throw new AccountError('RECOVERY_PASSWORD', 'Passphrases did not match.');
        const destination = await accounts.export(argument, password);
        console.log(
          json
            ? JSON.stringify({ recoveryFile: destination, format: 'NIP-49' })
            : `Encrypted recovery file: ${destination}\nKeep it and its passphrase separately.`,
        );
        break;
      }
      default:
        throw new AccountError('USAGE', 'Unknown account command. Use --help.');
    }
  } else throw new AccountError('USAGE', 'Unknown command. Use --help.');
} catch (error) {
  const safe = diagnose(
    error instanceof ScaffoldInputError ? new AccountError('USAGE', error.message) : error,
    operation,
  );
  if (json)
    console.log(
      JSON.stringify({
        error: safe,
        version,
        platform: `${process.platform}-${process.arch}`,
        ...(createdProject ? { directory: createdProject } : {}),
      }),
    );
  else {
    console.error(formatDiagnostic(safe));
    console.error(`soyLI ${version} · ${process.platform}-${process.arch}`);
    if (createdProject)
      console.error(
        `Preview project retained at ${createdProject}. Use setup/build for project tools or the account commands for creator setup.`,
      );
  }
  process.exitCode = 1;
}
