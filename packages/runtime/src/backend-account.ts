import { z } from 'zod';
import {
  authorizationTemplate,
  canonical,
  moduleRef,
  reference,
} from '../../dynamic-backends/src/contracts';
import type { HostSign } from './action-contracts';
import { signExact } from './action-session';

type Connection = {
  tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
};
export type BackendAccountOptions = {
  identity: string;
  pubkey: string | null;
  sign?: HostSign;
  signal: AbortSignal;
  consent(label: string): Promise<boolean>;
};
/** Host-owned proofs. The iframe can request an operation, never choose what gets signed. */
export class BackendAccount {
  private sessions = new Map<string, Promise<{ session: string; expiresAt: number }>>();
  constructor(
    private options: BackendAccountOptions,
    private actor: () => Promise<string>,
    private now: () => number = Date.now,
  ) {}
  async arguments(
    connection: Connection,
    provider: string,
    name: unknown,
    input: Record<string, unknown>,
  ) {
    if (
      ![
        'soy_backend_invoke',
        'soy_backend_changes',
        'soy_backend_purge_plan',
        'soy_backend_purge_confirm',
      ].includes(String(name)) ||
      input.session !== undefined ||
      !this.options.pubkey ||
      !this.options.sign
    )
      return input;
    const target = z.object({ module: moduleRef }).passthrough().parse(input.target);
    const ref = reference(target.module);
    // Same signed napplet identity across releases; copied/remixed code cannot claim its parent.
    const [author, kind, ...identifier] = this.options.identity
      .replace(/:[a-f0-9]{64}$/, '')
      .split(':');
    if (
      ref.key !== `${kind}:${author}:${identifier.join(':')}/${ref.module.name}` ||
      kind !== '35129'
    )
      throw new Error('Backend account binding must belong to this signed napplet.');
    const key = `${provider}/${ref.key}`;
    const bind = async () => {
      this.options.signal.throwIfAborted();
      if (
        !(await this.options.consent(
          `Use your signed-in Nostr identity for saved worlds and actions in ${ref.module.name} on backend ${provider.slice(0, 12)}? This session lasts up to one hour.`,
        ))
      )
        throw new Error('Backend account connection declined.');
      this.options.signal.throwIfAborted();
      const challenge = await connection.tool('soy_backend_session_challenge', {
        module: target.module,
        account: this.options.pubkey,
      });
      const challengeResult = z
        .object({
          challenge: z.string().uuid(),
          module: z.literal(ref.key),
          expiresAt: z.number().int(),
          scope: z.literal('instance-actions'),
          proof: z.object({ created_at: z.number().int() }).passthrough(),
        })
        .safeParse(challenge);
      if (!challengeResult.success)
        throw new Error(
          'Backend provider returned an invalid account challenge. Reconnect and retry.',
        );
      const parsed = challengeResult.data;
      const now = Math.floor(this.now() / 1000);
      if (
        parsed.expiresAt <= now ||
        parsed.expiresAt > now + 300 ||
        Math.abs(parsed.proof.created_at - now) > 300
      )
        throw new Error('Invalid backend account challenge lifetime.');
      const template = authorizationTemplate(
        provider,
        await this.actor(),
        'sessionBind',
        {
          challenge: parsed.challenge,
          module: ref.key,
          account: this.options.pubkey,
          expiresAt: parsed.expiresAt,
          scope: 'instance-actions',
        },
        parsed.proof.created_at * 1000,
      );
      if (canonical(template) !== canonical(parsed.proof))
        throw new Error('Backend requested an unexpected account proof.');
      const authorization = await signExact(
        this.options.sign!,
        this.options.pubkey!,
        template,
        this.options.signal,
      );
      const bound = await connection.tool('soy_backend_session_bind', {
        challenge: parsed.challenge,
        authorization,
      });
      // The provider starts the session after signing. A person or remote signer may
      // spend seconds approving; the earlier challenge timestamp is not this clock.
      const boundNow = Math.floor(this.now() / 1000);
      const result = z
        .object({
          session: z.string().uuid(),
          account: z.literal(this.options.pubkey!),
          expiresAt: z
            .number()
            .int()
            .min(boundNow + 1)
            .max(boundNow + 3601),
        })
        .safeParse(bound);
      if (!result.success)
        throw new Error(
          'Backend provider returned an invalid or expired account session. Reconnect and retry.',
        );
      this.options.signal.throwIfAborted();
      return result.data;
    };
    let cached = this.sessions.get(key);
    if (cached && (await cached).expiresAt <= Math.floor(this.now() / 1000) + 30) {
      this.sessions.delete(key);
      cached = undefined;
    }
    if (!cached) {
      if (this.sessions.size >= 16) throw new Error('Backend account session limit reached.');
      cached = bind().catch((error) => {
        this.sessions.delete(key);
        throw error;
      });
      this.sessions.set(key, cached);
    }
    const bound = await cached;
    this.options.signal.throwIfAborted();
    return { ...input, session: bound.session };
  }
}
