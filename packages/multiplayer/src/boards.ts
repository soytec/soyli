import { Database } from 'bun:sqlite';
import { z } from 'zod';
import { type NostrEvent } from 'nostr-tools';
import { verifySignature } from '../../protocol/src/verify';
import { decodeAddress, identityAddress } from '../../protocol/src';

import {
  boardRef,
  boardDefinition,
  boardRegister,
  boardSubmit,
  boardRead,
  boardEntry,
  boardAuthorization,
  type BoardDefinition,
} from './contracts';
import { encodeScoreData, type ScoreDataSchema } from './score-data';
export { boardRegister, boardSubmit, boardRead, boardEntry, boardAuthorization } from './contracts';

function reference(input: z.infer<typeof boardRef>) {
  const address = decodeAddress(input.napplet);
  return { owner: address.pubkey, key: `${identityAddress(address)}/${input.board}` };
}

/** Casual, client-reported personal bests. No score is represented as server-validated gameplay. */
export class Boards {
  private db: Database;
  constructor(
    path = ':memory:',
    private provider = '',
    private now = Date.now,
    private maxBoards = 1000,
    private maxPlayers = 1000,
  ) {
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS boards (key TEXT PRIMARY KEY, definition TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scores (board TEXT NOT NULL, actor TEXT NOT NULL, score REAL NOT NULL, name TEXT NOT NULL,
        updated INTEGER NOT NULL, data TEXT, revision TEXT, PRIMARY KEY(board, actor));`);
    // Upgrade existing durable boards in place, including boards without attachments.
    this.db
      .transaction(() => {
        const columns = this.db.query<{ name: string }, []>('PRAGMA table_info(scores)').all();
        if (!columns.some((c) => c.name === 'data'))
          this.db.exec('ALTER TABLE scores ADD COLUMN data TEXT');
        if (!columns.some((c) => c.name === 'revision'))
          this.db.exec('ALTER TABLE scores ADD COLUMN revision TEXT');
        this.db.exec(
          'UPDATE scores SET revision=lower(hex(randomblob(16))) WHERE revision IS NULL',
        );
      })
      .immediate();
  }
  register(actor: string, input: unknown) {
    const { definition, authorization } = boardRegister.parse(input);
    if (definition.minimum > definition.maximum) throw new Error('Invalid score range');
    const { owner, key } = reference(definition);
    const proof = authorization as NostrEvent;
    const expected = boardAuthorization(this.provider, actor, definition, this.now());
    try {
      if (
        !verifySignature(proof) ||
        proof.pubkey !== owner ||
        proof.kind !== expected.kind ||
        Math.abs(proof.created_at - expected.created_at) > 300 ||
        proof.content !== expected.content ||
        JSON.stringify(proof.tags) !== JSON.stringify(expected.tags)
      )
        throw new Error();
    } catch {
      throw new Error('Creator signature required for this provider, caller and board definition');
    }
    return this.provision(definition);
  }
  /** Operator-only bootstrap for an isolated local preview; never exposed as an MCP tool. */
  provision(definition: BoardDefinition) {
    definition = boardDefinition.parse(definition);
    if (definition.minimum > definition.maximum) throw new Error('Invalid score range');
    const { key } = reference(definition);
    const canonical = JSON.stringify({
      ...definition,
      napplet: identityAddress(decodeAddress(definition.napplet)),
    });
    this.db.transaction(() => {
      const existing = this.db
        .query<{ definition: string }, [string]>('SELECT definition FROM boards WHERE key=?')
        .get(key);
      if (existing) {
        if (existing.definition !== canonical)
          throw new Error(
            'Board rules are immutable; use a new board ID for a new season or rules',
          );
        return;
      }
      if (
        this.db.query<{ count: number }, []>('SELECT count(*) AS count FROM boards').get()!.count >=
        this.maxBoards
      )
        throw new Error('Board capacity reached');
      this.db.query('INSERT INTO boards VALUES (?, ?)').run(key, canonical);
    })();
    return { version: 1, board: key, trust: 'client-reported' };
  }
  private definition(key: string) {
    const row = this.db
      .query<{ definition: string }, [string]>('SELECT definition FROM boards WHERE key=?')
      .get(key);
    if (!row)
      throw new Error('Board is not registered. Run soyli backend sync with the creator identity.');
    return JSON.parse(row.definition) as BoardDefinition;
  }
  submit(actor: string, input: unknown) {
    const args = boardSubmit.parse(input),
      { key } = reference(args),
      definition = this.definition(key);
    if (args.score < definition.minimum || args.score > definition.maximum)
      throw new Error('Score outside board range');
    const data = encodeScoreData(definition.dataSchema as ScoreDataSchema | undefined, args.data);
    this.db.transaction(() => {
      const previous = this.db
        .query<{ score: number }, [string, string]>(
          'SELECT score FROM scores WHERE board=? AND actor=?',
        )
        .get(key, actor);
      if (
        previous &&
        (definition.order === 'highest'
          ? previous.score >= args.score
          : previous.score <= args.score)
      )
        return;
      if (
        !previous &&
        this.db
          .query<{ count: number }, [string]>('SELECT count(*) AS count FROM scores WHERE board=?')
          .get(key)!.count >= this.maxPlayers
      )
        throw new Error('Board player capacity reached');
      this.db
        .query(
          'INSERT INTO scores (board,actor,score,name,updated,data,revision) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(board,actor) DO UPDATE SET score=excluded.score,name=excluded.name,updated=excluded.updated,data=excluded.data,revision=excluded.revision',
        )
        .run(
          key,
          actor,
          args.score,
          args.name,
          this.now(),
          data,
          crypto.randomUUID().replaceAll('-', ''),
        );
    })();
    return this.read(actor, { napplet: args.napplet, board: args.board, limit: 20 });
  }
  read(actor: string, input: unknown) {
    const args = boardRead.parse(input),
      { key } = reference(args),
      definition = this.definition(key);
    const order = definition.order === 'highest' ? 'DESC' : 'ASC';
    const candidates = this.db
      .query<
        {
          actor: string;
          score: number;
          name: string;
          updated: number;
          revision: string;
          hasData: number;
        },
        [string, number, number]
      >(
        `SELECT actor,score,name,updated,revision,data IS NOT NULL AS hasData FROM scores WHERE board=? ORDER BY score ${order},updated ASC,actor ASC LIMIT ? OFFSET ?`,
      )
      .all(key, args.limit + 1, args.offset)
      .map((row) => ({ ...row, hasData: !!row.hasData }));
    // MCP repeats the result as text + structuredContent. Leave room for both
    // encodings under NIP-44's plaintext limit, even with heavily escaped names.
    const rows: typeof candidates = [];
    let bytes = 2;
    for (const row of candidates) {
      const size = new TextEncoder().encode(JSON.stringify(row)).length + 1;
      if (rows.length >= args.limit || bytes + size > 16384) break;
      rows.push(row);
      bytes += size;
    }
    const own = this.db
      .query<
        {
          actor: string;
          score: number;
          name: string;
          updated: number;
          revision: string;
          hasData: number;
        },
        [string, string]
      >(
        'SELECT actor,score,name,updated,revision,data IS NOT NULL AS hasData FROM scores WHERE board=? AND actor=?',
      )
      .get(key, actor);
    return {
      version: 1,
      board: key,
      title: definition.title,
      order: definition.order,
      trust: 'client-reported',
      rows,
      nextOffset: candidates.length > rows.length ? args.offset + rows.length : null,
      own: own ? { ...own, hasData: !!own.hasData } : null,
    };
  }
  entry(input: unknown) {
    const args = boardEntry.parse(input),
      { key } = reference(args);
    this.definition(key);
    const row = this.db
      .query<
        {
          actor: string;
          score: number;
          name: string;
          updated: number;
          revision: string;
          data: string | null;
        },
        [string, string]
      >('SELECT actor,score,name,updated,revision,data FROM scores WHERE board=? AND actor=?')
      .get(key, args.actor);
    const stale = !!args.revision && row?.revision !== args.revision;
    return {
      version: 2,
      board: key,
      trust: 'client-reported',
      stale,
      entry:
        row && !stale ? { ...row, data: row.data === null ? null : JSON.parse(row.data) } : null,
    };
  }
  close() {
    this.db.close();
  }
}
