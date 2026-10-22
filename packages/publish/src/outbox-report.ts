import { formatDiagnostic } from '../../diagnostics/src';
import type { PublishJob } from './journal';
import { MAX_OUTBOX_RELAYS } from './limits';

/** Terminal/local-UI text for the best-effort NIP-65 outbox copies of a release. */
export function outboxReport(outbox: PublishJob['outbox'] | null): string[] {
  if (!outbox) return [];
  const lines: string[] = [];
  if (outbox.source === 'nip65') {
    const copied = outbox.relays.filter((url) => outbox.copies[url]);
    lines.push(
      outbox.relays.length
        ? `Your outbox relays (NIP-65, best effort): ${copied.length}/${outbox.relays.length} copied${copied.length ? ` · ${copied.join(', ')}` : ''}`
        : 'Your outbox relays (NIP-65): no additional eligible destinations',
    );
    if (outbox.ignored)
      lines.push(
        `Skipped ${outbox.ignored} listed write relay${outbox.ignored === 1 ? '' : 's'}: outside the publication relay policy (including the 256-character canonical URL bound), over the ${MAX_OUTBOX_RELAYS}-relay limit, or beyond the retained destination history limit.`,
      );
  } else
    lines.push(
      outbox.source === 'none'
        ? 'Your outbox relays (NIP-65): no relay list found for this creator; publish one to receive copies on your own relays.'
        : 'Your outbox relays (NIP-65): the relay list could not be read; no outbox copies were made.',
    );
  if (outbox.lookupError) lines.push(formatDiagnostic(outbox.lookupError));
  for (const [relay, failure] of Object.entries(outbox.errors))
    lines.push(
      `Optional outbox copy failed: ${relay}\nEvent: kind ${failure.eventKind} · ${failure.eventId}\n${formatDiagnostic(failure.diagnostic)}`,
    );
  return lines;
}
