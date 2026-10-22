// Shared by publication, resume, remix, source browsing and the local workshop.
// These are tooling resource budgets, not Nostr event or Git protocol limits.
export const MAX_SOURCE_FILES = 1024;
export const MAX_PUBLICATION_JOURNAL_BYTES = 2 * 1024 * 1024;
// Best-effort copies to the creator's own NIP-65 write relays.
export { MAX_OUTBOX_RELAYS } from '../../nostr/src/publication-copies';
