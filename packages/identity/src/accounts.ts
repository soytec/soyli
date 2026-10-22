import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import { getPublicKey, generateSecretKey, nip19 } from 'nostr-tools';
import { encrypt, decrypt } from 'nostr-tools/nip49';
import { bech32 } from '@scure/base';
import {
  AccountError,
  MAX_SIGNER_RELAYS,
  bunkerCredential,
  checkPubkey,
  openCredential,
  pairCredential,
  type PairingOptions,
  type Credential,
  type Network,
} from './signer';

export type Vault = {
  get(id: string): Promise<string | null>;
  set(id: string, value: string): Promise<void>;
  delete(id: string): Promise<void>;
};
export class NativeVault implements Vault {
  constructor(private service: string) {}
  private async operation<T>(operation: 'read' | 'write' | 'delete', fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (error) {
      // A vault exception may contain the value being stored. Keep only OS codes.
      const failure = error as { code?: unknown; errno?: unknown } | null;
      const code =
        typeof failure?.code === 'string' && /^[A-Z_][A-Z0-9_]{0,49}$/.test(failure.code)
          ? failure.code
          : undefined;
      const errno =
        typeof failure?.errno === 'number' && Number.isSafeInteger(failure.errno)
          ? failure.errno
          : undefined;
      const status = [code, errno].filter((value) => value !== undefined).join(', ');
      throw new AccountError(
        'KEYSTORE_UNAVAILABLE',
        `OS credential ${operation} failed${status ? ` (${status})` : ' (no OS error code supplied)'}. Check the credential store permissions and unlock status. Linux needs a running Secret Service/keyring. Remote sessions can use file storage; account storage file migrates an existing remote session once its old vault is accessible. No automatic fallback is used. For local-key development only, see SOYLI_DANGEROUS_PLAINTEXT_KEYS in soyli --help.`,
      );
    }
  }
  get(id: string) {
    return this.operation('read', () => Bun.secrets.get({ service: this.service, name: id }));
  }
  set(id: string, value: string) {
    return this.operation('write', () =>
      Bun.secrets.set({ service: this.service, name: id, value }),
    );
  }
  async delete(id: string) {
    await this.operation('delete', () => Bun.secrets.delete({ service: this.service, name: id }));
  }
}
export const sessionStorageSchema = z.enum(['file', 'keychain']);
export type SessionStorage = z.infer<typeof sessionStorageSchema>;
const accountSchema = z
  .object({
    id: z.uuid(),
    pubkey: z.string().regex(/^[a-f0-9]{64}$/),
    type: z.enum(['local', 'remote']),
    status: z.enum(['pending', 'ready']),
    sessionStorage: sessionStorageSchema.optional(),
    // Written before removing the old copy, so cleanup can be retried after a crash.
    sessionCleanup: z.enum(['legacy', 'file', 'keychain']).optional(),
  })
  .strict()
  .refine((a) => a.type === 'remote' || (!a.sessionStorage && !a.sessionCleanup))
  .refine(
    (a) => !a.sessionCleanup || (!!a.sessionStorage && a.sessionCleanup !== a.sessionStorage),
  );
export type Account = z.infer<typeof accountSchema>;
export function accountStorage(account: Account) {
  return account.sessionStorage ?? (dangerousFileKeystore() ? 'development-file' : 'keychain');
}
const indexSchema = z
  .object({
    version: z.literal(1),
    network: z.enum(['public', 'local']),
    active: z.uuid().nullable(),
    accounts: z.array(accountSchema).max(32),
  })
  .strict();
type Index = z.infer<typeof indexSchema>;
const credentialSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('local'), key: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z
    .object({
      type: z.literal('remote'),
      clientKey: z.string().regex(/^[a-f0-9]{64}$/),
      remote: z.string().regex(/^[a-f0-9]{64}$/),
      relays: z.array(z.string().max(400)).min(1).max(MAX_SIGNER_RELAYS),
      secret: z.string().max(256).optional(),
    })
    .strict(),
]);

/** Keep account state and recovery exports outside any Git working tree, including symlinked paths. */
export async function outsideRepository(input: string) {
  let existing = resolve(input);
  while (true) {
    try {
      existing = await realpath(existing);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  for (let current = existing; ; current = dirname(current)) {
    if (await lstat(join(current, '.git')).catch(() => null))
      throw new AccountError(
        'ACCOUNT_PATH',
        'Account state and recovery files must be outside Git projects. Choose a private user directory.',
      );
    if (dirname(current) === current) break;
  }
  return resolve(input);
}
export function defaultAccountDirectory(network: Network) {
  const base =
    process.env.SPACE_ACCOUNT_HOME ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'napplet-space');
  return dangerousFileKeystore()
    ? resolve(base, 'plaintext-accounts', network)
    : resolve(base, 'accounts', network);
}
export function dangerousFileKeystore() {
  const value = process.env.SOYLI_DANGEROUS_PLAINTEXT_KEYS;
  if (value && value !== '1')
    throw new AccountError(
      'KEYSTORE_OPTION',
      'Set SOYLI_DANGEROUS_PLAINTEXT_KEYS=1 to explicitly opt in, or unset it to use the OS vault.',
    );
  return value === '1';
}

/** Explicit development storage. Separate account index prevents silent identity replacement. */
export class PlaintextVault implements Vault {
  constructor(readonly directory: string) {}
  private async path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new AccountError('KEYSTORE_FILE', 'Invalid credential ID.');
    await outsideRepository(this.directory);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.mode & 0o077 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new AccountError(
        'KEYSTORE_FILE',
        'Plaintext credential directory must be owner-only (0700), owned by you, and not a symlink.',
      );
    return join(this.directory, `${id}.json`);
  }
  async get(id: string) {
    const path = await this.path(id);
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 4096 ||
        info.mode & 0o077 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error();
      return await file.readFile('utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new AccountError(
        'KEYSTORE_FILE',
        'Plaintext credential is unsafe or unreadable. Require an owner-only (0600) regular file; nothing was overwritten.',
      );
    } finally {
      await file?.close();
    }
  }
  async set(id: string, value: string) {
    const path = await this.path(id);
    await this.get(id); // Reject unsafe existing destinations before replacing.
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(value);
      await file.sync();
      await file.close();
      await rename(temporary, path);
      const dir = await open(this.directory, 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await file.close();
      await rm(temporary, { force: true });
    }
  }
  async delete(id: string) {
    const path = await this.path(id);
    await this.get(id);
    await rm(path, { force: true });
  }
}
export class Accounts {
  readonly directory: string;
  private readonly sessionFiles: Vault;
  private readonly keychain: Vault;
  constructor(
    readonly network: Network = 'public',
    directory = defaultAccountDirectory(network),
    readonly vault: Vault = dangerousFileKeystore()
      ? new PlaintextVault(join(directory, 'credentials'))
      : new NativeVault(`space.napplet.creator.${network}`),
    stores: { sessionFiles?: Vault; keychain?: Vault } = {},
  ) {
    this.directory = resolve(directory);
    this.sessionFiles =
      stores.sessionFiles ?? new PlaintextVault(join(this.directory, 'remote-sessions'));
    this.keychain =
      stores.keychain ??
      (dangerousFileKeystore() ? new NativeVault(`space.napplet.creator.${network}`) : vault);
  }
  private store(account: Account, storage = account.sessionStorage ?? 'legacy'): Vault {
    return storage === 'file'
      ? this.sessionFiles
      : storage === 'keychain'
        ? this.keychain
        : this.vault;
  }
  private async read(): Promise<Index> {
    await outsideRepository(this.directory);
    let file;
    try {
      file = await open(
        join(this.directory, 'accounts.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65536) throw new Error();
      const result = indexSchema.parse(JSON.parse(await file.readFile('utf8')));
      if (
        result.network !== this.network ||
        new Set(result.accounts.map((a) => a.id)).size !== result.accounts.length ||
        (result.active &&
          !result.accounts.some((a) => a.id === result.active && a.status === 'ready'))
      )
        throw new Error();
      return result;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, network: this.network, active: null, accounts: [] };
      throw new AccountError(
        'ACCOUNT_CONFIG',
        'Account metadata is damaged or unsafe. Restore its backup; it was not overwritten.',
      );
    } finally {
      await file?.close();
    }
  }
  private async write(index: Index) {
    const temporary = join(this.directory, `accounts.${crypto.randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(indexSchema.parse(index), null, 2) + '\n');
      await file.sync();
      await file.close();
      await rename(temporary, join(this.directory, 'accounts.json'));
      const dir = await open(this.directory, 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await file.close();
      await rm(temporary, { force: true });
    }
  }
  private async locked<T>(fn: (index: Index) => Promise<T>): Promise<T> {
    await outsideRepository(this.directory);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const path = join(this.directory, 'account-lock.sqlite');
    if ((await lstat(path).catch(() => null))?.isSymbolicLink())
      throw new AccountError('ACCOUNT_CONFIG', 'Account lock cannot be a symlink.');
    const lock = new Database(path, { create: true });
    try {
      await chmod(path, 0o600);
      try {
        lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      } catch {
        throw new AccountError(
          'ACCOUNT_BUSY',
          'Another account operation is running. Retry when it finishes.',
        );
      }
      const index = await this.read();
      // A public reservation survives a crash between credential storage and activation.
      for (const record of [...index.accounts]) {
        if (record.status !== 'pending') continue;
        const saved = await this.store(record).get(record.id);
        if (saved === null) index.accounts = index.accounts.filter((a) => a.id !== record.id);
        else {
          const credential = this.decode(saved, record);
          if (
            credential.type === 'local' &&
            getPublicKey(Uint8Array.from(Buffer.from(credential.key, 'hex'))) !== record.pubkey
          )
            throw new AccountError(
              'IDENTITY_CHANGED',
              'Pending credential does not match its reserved identity.',
            );
          record.status = 'ready';
          index.active = record.id;
        }
        await this.write(index);
      }
      return await fn(index);
    } finally {
      lock.close();
    }
  }
  private decode(raw: string, account: Account): Credential {
    try {
      if (raw.length > 4096) throw new Error();
      const value = credentialSchema.parse(JSON.parse(raw));
      if (value.type !== account.type) throw new Error();
      return value;
    } catch {
      throw new AccountError(
        'INVALID_CREDENTIAL',
        'Stored credential is invalid. Import a recovery backup or reconnect your signer.',
      );
    }
  }
  private async credential(account: Account) {
    const raw = await this.store(account).get(account.id);
    if (raw === null)
      throw new AccountError(
        'CREDENTIAL_MISSING',
        'The saved key/session is missing. Restore your backup or reconnect; a replacement identity was not generated.',
      );
    return this.decode(raw, account);
  }
  async current() {
    const index = await this.read();
    return index.accounts.find((a) => a.id === index.active) ?? null;
  }
  async list() {
    return (await this.read()).accounts;
  }
  async create({ fresh = false }: { fresh?: boolean } = {}) {
    return this.locked(async (index) => {
      const selected = index.accounts.find((a) => a.id === index.active);
      if (selected && !fresh) {
        if (selected.type === 'local') await this.backupAccount(selected);
        return selected;
      }
      const key = generateSecretKey();
      try {
        const account = await this.save(
          index,
          { type: 'local', key: Buffer.from(key).toString('hex') },
          getPublicKey(key),
        );
        await this.backupAccount(account);
        return account;
      } finally {
        key.fill(0);
      }
    });
  }
  /** A portable backup outside source trees; signing still uses the OS credential store. */
  async backup(id?: string) {
    return this.locked(async (index) => {
      const account = index.accounts.find((a) => a.id === (id ?? index.active));
      if (!account || account.status !== 'ready')
        throw new AccountError('ACCOUNT_REQUIRED', 'Select a creator before saving its backup.');
      return this.backupAccount(account);
    });
  }
  private async backupAccount(account: Account) {
    if (account.type !== 'local')
      throw new AccountError(
        'RECOVERY_REMOTE',
        'Back up remote identities in the signer application. Only locally held creator keys can be backed up here.',
      );
    const path = await outsideRepository(join(this.directory, `${account.pubkey}.nsec`));
    // An existing valid backup remains usable even if the OS credential was lost.
    const existing = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw new AccountError(
        'RECOVERY_FILE',
        `Cannot read private-key backup at ${path}. It was not overwritten.`,
      );
    });
    if (existing) {
      try {
        const stat = await existing.stat();
        if (!stat.isFile() || stat.size > 128 || stat.nlink !== 1) throw new Error();
        const decoded = nip19.decode((await existing.readFile('utf8')).trim());
        if (decoded.type !== 'nsec') throw new Error();
        try {
          if (getPublicKey(decoded.data) !== account.pubkey) throw new Error();
        } finally {
          decoded.data.fill(0);
        }
        await existing.chmod(0o600);
        return path;
      } catch {
        throw new AccountError(
          'RECOVERY_FILE',
          `Private-key backup at ${path} is invalid or unsafe. It was not overwritten; preserve it elsewhere before retrying account backup.`,
        );
      } finally {
        await existing.close();
      }
    }
    const credential = await this.credential(account);
    if (credential.type !== 'local')
      throw new AccountError('INVALID_CREDENTIAL', 'Expected a local creator key.');
    const key = Uint8Array.from(Buffer.from(credential.key, 'hex'));
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    let file;
    try {
      if (getPublicKey(key) !== account.pubkey)
        throw new AccountError(
          'IDENTITY_CHANGED',
          'Stored key does not match the selected creator.',
        );
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(nip19.nsecEncode(key) + '\n');
      await file.sync();
      await file.close();
      // Publish a complete file atomically without ever replacing an existing destination.
      await link(temporary, path);
      await rm(temporary);
      const directory = await open(this.directory, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return path;
    } catch (error) {
      if (error instanceof AccountError) throw error;
      throw new AccountError(
        'RECOVERY_DESTINATION',
        `Could not save private-key backup at ${path}. Your stored identity was not replaced. Check permissions and retry account backup.`,
      );
    } finally {
      key.fill(0);
      await file?.close();
      await rm(temporary, { force: true });
    }
  }
  private async save(
    index: Index,
    credential: Credential,
    pubkey: string,
    storage: SessionStorage = 'file',
  ) {
    checkPubkey(pubkey, this.network);
    if (index.accounts.length >= 32)
      throw new AccountError(
        'ACCOUNT_LIMIT',
        'This account directory already contains 32 identities.',
      );
    const encoded = JSON.stringify(credential);
    if (
      Buffer.byteLength(encoded) >
      (credential.type === 'remote' && storage === 'file' ? 4096 : 2048)
    )
      throw new AccountError(
        'CREDENTIAL_SIZE',
        'Signer connection exceeds the portable credential-store size limit.',
      );
    const record: Account = {
      id: crypto.randomUUID(),
      pubkey,
      type: credential.type,
      status: 'pending',
      ...(credential.type === 'remote' ? { sessionStorage: storage } : {}),
    };
    index.accounts.push(record);
    await this.write(index);
    const store = this.store(record);
    await store.set(record.id, encoded);
    if ((await store.get(record.id)) !== encoded)
      throw new AccountError(
        'KEYSTORE_VERIFY',
        'Credential storage could not be verified. Retry account setup; no replacement key will be generated while a saved reservation exists.',
      );
    record.status = 'ready';
    index.active = record.id;
    await this.write(index);
    return record;
  }
  async import(secret: string, password?: string) {
    let key: Uint8Array;
    try {
      if (secret.length > 300) throw new Error();
      if (secret.startsWith('ncryptsec1')) {
        const decoded = bech32.decode(secret as `${string}1${string}`, 300);
        const bytes = bech32.fromWords(decoded.words);
        // Bound the untrusted backup's scrypt work factor before allocating memory.
        if (bytes.length !== 91 || bytes[0] !== 2 || bytes[1] < 10 || bytes[1] > 18 || !password)
          throw new Error();
        key = decrypt(secret, password);
      } else {
        const decoded = nip19.decode(secret);
        if (decoded.type !== 'nsec') throw new Error();
        key = decoded.data;
      }
      getPublicKey(key);
    } catch {
      throw new AccountError(
        'INVALID_RECOVERY',
        'Use a valid nsec or NIP-49 recovery key with its passphrase (supported scrypt logN: 10–18).',
      );
    }
    try {
      return await this.locked((index) =>
        this.save(
          index,
          { type: 'local', key: Buffer.from(key).toString('hex') },
          getPublicKey(key),
        ),
      );
    } finally {
      key.fill(0);
    }
  }
  async connect(
    uri: string,
    options: NonNullable<Parameters<typeof openCredential>[2]> & {
      sessionStorage?: SessionStorage;
    } = {},
  ) {
    const storage = this.validateSessionStorage(options.sessionStorage ?? 'file');
    const credential = bunkerCredential(uri, this.network);
    const signer = await openCredential(credential, this.network, options);
    try {
      // The bunker secret authorizes the first connection only. Future sessions
      // authenticate with the client key already approved by the remote signer.
      delete credential.secret;
      return await this.locked(async (index) =>
        this.save(index, credential, await signer.getPublicKey(), storage),
      );
    } finally {
      await signer.close();
    }
  }
  async pair(relays: string[], options: PairingOptions & { sessionStorage?: SessionStorage }) {
    const storage = this.validateSessionStorage(options.sessionStorage ?? 'file');
    const { credential, signer } = await pairCredential(relays, this.network, options);
    try {
      return await this.locked(async (index) => {
        if (options.signal?.aborted)
          throw new AccountError('SIGNER_CANCELLED', 'Pairing cancelled.');
        return this.save(index, credential, await signer.getPublicKey(), storage);
      });
    } finally {
      await signer.close();
    }
  }
  private validateSessionStorage(value: unknown): SessionStorage {
    const result = sessionStorageSchema.safeParse(value);
    if (!result.success)
      throw new AccountError(
        'SESSION_STORAGE',
        'Choose file or keychain for remote session storage.',
      );
    return result.data;
  }
  /** Move the selected remote session without re-pairing or changing its identity. */
  async setSessionStorage(value: SessionStorage) {
    const target = this.validateSessionStorage(value);
    return this.locked(async (index) => {
      const account = index.accounts.find((a) => a.id === index.active);
      if (!account || account.type !== 'remote')
        throw new AccountError(
          'SESSION_STORAGE',
          'Select a remote signer with account use first. Local private-key storage is unchanged.',
        );
      const cleanup = async () => {
        if (!account.sessionCleanup) return;
        // Never delete the recovery copy if the destination disappeared or became unsafe.
        await this.credential(account);
        try {
          await this.store(account, account.sessionCleanup).delete(account.id);
        } catch (error) {
          // Vault errors may include credentials. Only our safe native/file diagnostics cross this boundary.
          const code =
            error instanceof AccountError &&
            ['KEYSTORE_UNAVAILABLE', 'KEYSTORE_FILE'].includes(error.code)
              ? ` ${error.message}`
              : '';
          throw new AccountError(
            'SESSION_CLEANUP',
            `Session is saved in ${account.sessionStorage}, but removing its old ${account.sessionCleanup} copy failed.${code} Retry soyli account storage ${account.sessionStorage} to finish cleanup; do not pair again.`,
          );
        }
        delete account.sessionCleanup;
        await this.write(index);
      };
      await cleanup();
      if (account.sessionStorage === target) {
        await this.credential(account);
        return account;
      }
      const credential = await this.credential(account);
      if (credential.type !== 'remote')
        throw new AccountError('INVALID_CREDENTIAL', 'Expected a remote session.');
      delete credential.secret;
      const encoded = JSON.stringify(credential);
      if (target === 'keychain' && Buffer.byteLength(encoded) > 2048)
        throw new AccountError(
          'CREDENTIAL_SIZE',
          'This session exceeds the portable Keychain size limit. Keep file storage.',
        );
      const previous = account.sessionStorage ?? 'legacy';
      const destination = this.store(account, target);
      await destination.set(account.id, encoded);
      if ((await destination.get(account.id)) !== encoded)
        throw new AccountError(
          'KEYSTORE_VERIFY',
          'Session storage could not be verified. The original session remains selected; retry account storage.',
        );
      account.sessionStorage = target;
      // Legacy native storage and explicit keychain storage share a vault.
      if (this.store(account, previous) !== destination) account.sessionCleanup = previous;
      await this.write(index);
      await cleanup();
      return account;
    });
  }
  async use(ref: string, options: Parameters<typeof openCredential>[2] = {}) {
    return this.locked(async (index) => {
      const account = index.accounts.find(
        (a) => a.id === ref || nip19.npubEncode(a.pubkey) === ref,
      );
      if (!account || account.status !== 'ready')
        throw new AccountError('ACCOUNT_UNKNOWN', 'Choose a ready account from account list.');
      const signer = await openCredential(await this.credential(account), this.network, {
        ...options,
        expectedPubkey: account.pubkey,
      });
      await signer.close();
      index.active = account.id;
      await this.write(index);
      return account;
    });
  }
  async signer(
    options: NonNullable<Parameters<typeof openCredential>[2]> & { accountId?: string } = {},
  ) {
    const account = options.accountId
      ? (await this.read()).accounts.find((a) => a.id === options.accountId && a.status === 'ready')
      : await this.current();
    if (!account)
      throw new AccountError(
        'ACCOUNT_REQUIRED',
        'Run account create, account import, or account connect first.',
      );
    return openCredential(await this.credential(account), this.network, {
      ...options,
      expectedPubkey: account.pubkey,
    });
  }
  async export(destination: string, password: string) {
    if (password.length < 12)
      throw new AccountError(
        'RECOVERY_PASSWORD',
        'Use a recovery passphrase of at least 12 characters.',
      );
    const account = await this.current();
    if (!account || account.type !== 'local')
      throw new AccountError(
        'RECOVERY_REMOTE',
        'Back up remote identities in the signer application. Only locally held creator keys can be exported here.',
      );
    const path = await outsideRepository(destination);
    const credential = await this.credential(account);
    if (credential.type !== 'local')
      throw new AccountError('INVALID_CREDENTIAL', 'Expected a local creator key.');
    const key = Uint8Array.from(Buffer.from(credential.key, 'hex'));
    try {
      if (getPublicKey(key) !== account.pubkey)
        throw new AccountError(
          'IDENTITY_CHANGED',
          'Stored key does not match the selected creator.',
        );
      const file = await open(path, 'wx', 0o600).catch(() => {
        throw new AccountError(
          'RECOVERY_DESTINATION',
          'Choose a new recovery filename in an existing private directory; files are never overwritten.',
        );
      });
      try {
        await file.writeFile(encrypt(key, password, 16) + '\n');
        await file.sync();
      } finally {
        await file.close();
      }
    } finally {
      key.fill(0);
    }
    return path;
  }
}

/** A running operation retains its chosen account without changing the global default. */
export async function captureAccount(accounts: Pick<Accounts, 'current' | 'signer'>) {
  const account = await accounts.current();
  return {
    current: async () => account,
    signer: (options: Parameters<Accounts['signer']>[0] = {}) => {
      if (!account)
        throw new AccountError(
          'ACCOUNT_REQUIRED',
          'Select a creator before starting this operation.',
        );
      return accounts.signer({ ...options, accountId: account.id });
    },
  };
}
