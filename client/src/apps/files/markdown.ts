/**
 * Markdown for Peek. A file in home is untrusted: marked turns it into HTML,
 * DOMPurify keeps only harmless markup, links open in a new tab with no way
 * back to this page, and pictures load only from the home folder.
 */
import createDOMPurify from 'dompurify';
import { marked } from 'marked';
import { api } from '../../lib/api';

// Its own instance, so these hooks never apply to anyone else's sanitising.
const purify = createDOMPurify(window);

/** The folder of the document being rendered; relative pictures resolve against it. */
let folder = '';

const SCHEME = /^([a-z][a-z0-9+.-]*:|\/\/)/i;
const WEB_LINK = /^(https?:|mailto:)/i;

/** A picture path inside the document as a home relative path, or null when it points out of home. */
function resolveInHome(source: string): string | null {
  let clean: string;
  try {
    clean = decodeURIComponent(source.split(/[?#]/)[0]!);
  } catch {
    return null;
  }
  const parts = clean.startsWith('/') ? [] : folder.split('/').filter(Boolean);
  for (const part of clean.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length > 0 ? parts.join('/') : null;
}

purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? '';
    if (WEB_LINK.test(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    } else {
      // A link to another file or heading has nowhere to go inside a preview.
      node.removeAttribute('href');
    }
  }
  if (node.tagName === 'IMG') {
    const source = node.getAttribute('src') ?? '';
    const path = SCHEME.test(source) ? null : resolveInHome(source);
    if (path) node.setAttribute('src', api.fs.readUrl(path));
    else node.removeAttribute('src');
    node.setAttribute('loading', 'lazy');
  }
  if (node.tagName === 'INPUT') {
    // Task lists draw a checkbox; nothing else in a document may be a control.
    if (node.getAttribute('type') === 'checkbox') node.setAttribute('disabled', '');
    else node.remove();
  }
});

/** Sanitised HTML for a Markdown document that lives in `documentFolder`. */
export function renderMarkdown(source: string, documentFolder: string): string {
  folder = documentFolder;
  const html = marked.parse(source, { async: false, gfm: true });
  return purify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'video', 'audio', 'picture', 'source'],
    FORBID_ATTR: ['style', 'class', 'id', 'srcset'],
  });
}
