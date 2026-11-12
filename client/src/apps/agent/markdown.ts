import DOMPurify from 'dompurify';
import { marked } from 'marked';

const purify = DOMPurify(window);
// A link in a reply opens beside the desktop, never in place of it.
purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const CACHE_CAP = 400;
const cache = new Map<string, string>();

/** Markdown as safe HTML. Finished reply blocks never change, so each is rendered once. */
export function renderMarkdown(text: string): string {
  const held = cache.get(text);
  if (held !== undefined) return held;
  const html = purify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }), {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'],
    FORBID_ATTR: ['style'],
  });
  if (cache.size >= CACHE_CAP) cache.delete(cache.keys().next().value!);
  cache.set(text, html);
  return html;
}
