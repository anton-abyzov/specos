import { useEffect, useRef, type MouseEvent, type RefObject } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { api } from '../../lib/api';
import { useShellStore } from '../../stores/shell';

interface PreviewProps {
  text: string;
  /** Home relative path of the Markdown file, so its relative links and pictures resolve. */
  path: string;
  scroller: RefObject<HTMLDivElement | null>;
}

const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

/** A link or picture address inside the file, as a home relative path; null when it points elsewhere. */
function resolveInHome(address: string, filePath: string): string | null {
  if (!address || EXTERNAL.test(address) || address.startsWith('#') || address.startsWith('//')) return null;
  const folder = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/') + 1) : '';
  try {
    const resolved = new URL(address, `http://home.invalid/${address.startsWith('/') ? '' : folder}`);
    return decodeURIComponent(resolved.pathname.slice(1));
  } catch {
    return null;
  }
}

/** The Markdown file as a page, rendered from the buffer as it is typed. */
export function Preview({ text, path, scroller }: PreviewProps) {
  const page = useRef<HTMLElement>(null);

  useEffect(() => {
    const html = marked.parse(text, { async: false, gfm: true });
    const fragment = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ['style', 'form'] });
    for (const image of fragment.querySelectorAll('img')) {
      const local = resolveInHome(image.getAttribute('src') ?? '', path);
      if (local !== null) image.src = api.fs.readUrl(local);
      image.loading = 'lazy';
    }
    for (const box of fragment.querySelectorAll('input[type=checkbox]')) box.setAttribute('tabindex', '-1');
    page.current?.replaceChildren(fragment);
  }, [text, path]);

  /** Links never navigate the desktop away: web links open a new tab, links to files open in the Editor. */
  const onClick = (event: MouseEvent<HTMLElement>) => {
    const link = (event.target as Element).closest('a');
    if (!link) return;
    event.preventDefault();
    const address = link.getAttribute('href') ?? '';
    if (/^https?:/i.test(address)) {
      window.open(address, '_blank', 'noopener,noreferrer');
      return;
    }
    const local = resolveInHome(address.split('#')[0] ?? '', path);
    if (local) useShellStore.getState().launchApp('editor', { path: local });
  };

  return (
    <div className="editor-preview selectable" ref={scroller} data-testid="editor-preview">
      {text.trim() === '' && <p className="editor-preview__empty">Nothing to preview yet. Start writing on the left.</p>}
      <article className="editor-preview__page" ref={page} onClick={onClick} />
    </div>
  );
}
