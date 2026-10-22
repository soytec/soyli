import type { AssetLock } from './index';

/** BUD-10 discovery metadata; NAP-RESOURCE's pinned URI syntax stays separate. */
export async function relatedAssetHtml(html: Uint8Array, lock: AssetLock) {
  const assets = [
    ...new Map(
      [...lock.assets]
        .filter((asset) => asset.storage === 'external')
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((asset) => [asset.hash, asset] as const),
    ).values(),
  ].sort((a, b) => a.hash.localeCompare(b.hash));
  const escape = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const links = assets
    .map((asset) => {
      const extension = asset.path.split('.').pop() || 'bin';
      return `<link rel="related" data-soyli-related href="blossom:${asset.hash}.${extension}?sz=${asset.bytes}" type="${escape(asset.mime)}">`;
    })
    .join('');
  let head = false;
  let headUnavailable = false;
  let removed = false;
  const response = new HTMLRewriter()
    .on('link[data-soyli-related]', {
      element(element) {
        removed = true;
        element.remove();
      },
    })
    .on('body, template, svg, math', {
      element() {
        headUnavailable = true;
      },
    })
    .on('head', {
      element(element) {
        if (head || headUnavailable) return;
        head = true;
        // append waits for a literal end tag; HTML may legally omit </head>.
        element.prepend(links, { html: true });
      },
    })
    .transform(new Response(new Uint8Array(html)));
  const output = new Uint8Array(await response.arrayBuffer());
  // Keep existing artifacts byte-for-byte when they need no metadata.
  if (!links && !removed) return new Uint8Array(html);
  if (head || !links) return output;
  // Locate the first HTML token instead of guessing where a doctype ends.
  // Leading comments/whitespace and quoted doctype identifiers stay untouched.
  // Leave </head> implicit so existing title/meta/script tokens remain in the head.
  const opening = `<head>${links}`;
  let inserted = false;
  const prepared = new HTMLRewriter()
    .on('*', {
      element(element) {
        if (inserted) return;
        if (element.tagName === 'html') element.prepend(opening, { html: true });
        else element.before(opening, { html: true });
        inserted = true;
      },
    })
    .onDocument({
      text(text) {
        if (inserted || /^[\t\n\f\r \uFEFF]*$/.test(text.text)) return;
        text.before(opening, { html: true });
        inserted = true;
      },
      end(end) {
        if (!inserted) end.append(opening, { html: true });
      },
    })
    .transform(new Response(output));
  return new Uint8Array(await prepared.arrayBuffer());
}
