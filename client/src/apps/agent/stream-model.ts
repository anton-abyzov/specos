/**
 * Turns an agent's stream events into what the conversation view draws:
 * reply blocks, one-line tool rows, groups of file chips and quiet lines.
 */
import type { AgentStreamEvent, ChangeKind } from '@shared/protocol';

export interface StreamFile {
  path: string;
  change: ChangeKind;
  /** How many changes this chip stands for. */
  count: number;
}

export type StreamItem =
  | { type: 'text'; key: string; text: string; complete: boolean }
  | { type: 'tool'; key: string; tool: string; summary: string }
  | { type: 'files'; key: string; files: StreamFile[] }
  | { type: 'status' | 'error' | 'result'; key: string; text: string; path?: string };

interface OpenBlock {
  key: string;
  chunks: string[];
}

/**
 * `live` is false once the job has ended: a reply that was cut short then
 * counts as complete, so it is drawn like any other and loses its caret.
 */
export function buildStream(events: readonly AgentStreamEvent[], live: boolean): StreamItem[] {
  const items: StreamItem[] = [];
  /** The reply being written, with its place in `items`. */
  let open: (OpenBlock & { index: number }) | null = null;
  /** The newest group of file chips. */
  let files: Extract<StreamItem, { type: 'files' }> | null = null;

  const settle = (complete: boolean, text?: string) => {
    if (!open) return;
    items[open.index] = { type: 'text', key: open.key, text: text ?? open.chunks.join(''), complete };
  };

  for (const event of events) {
    const key = `e${event.seq}`;
    switch (event.kind) {
      case 'text':
        if (!open) {
          open = { key, chunks: [], index: items.length };
          items.push({ type: 'text', key, text: '', complete: false });
        }
        open.chunks.push(event.text ?? '');
        break;
      case 'message':
        // The whole block replaces its chunks in place, under the same key, so nothing is drawn twice.
        if (open) {
          settle(true, event.text ?? '');
          open = null;
        } else {
          items.push({ type: 'text', key, text: event.text ?? '', complete: true });
        }
        break;
      case 'tool':
        items.push({ type: 'tool', key, tool: event.tool ?? 'Tool', summary: event.summary ?? '' });
        break;
      case 'file': {
        if (!event.path) break;
        const change = event.change ?? 'change';
        const held = files?.files.find((file) => file.path === event.path);
        if (held) {
          held.count += 1;
          held.change = change;
          break;
        }
        // A new file joins the group it follows; anything said or done in between starts a new group.
        const last = items[open && open.index === items.length - 1 ? items.length - 2 : items.length - 1];
        if (!files || last !== files) {
          files = { type: 'files', key, files: [] };
          items.push(files);
        }
        files.files.push({ path: event.path, change, count: 1 });
        break;
      }
      case 'status':
      case 'error':
        items.push({ type: event.kind, key, text: event.text ?? '', path: event.path });
        break;
      case 'result':
        items.push({ type: 'result', key, text: event.summary ?? event.text ?? 'finished' });
        break;
    }
  }
  if (open) settle(!live);
  // Chips are counted in place while building; hand out copies so a memoised row sees the change.
  return items.map((item) => (item.type === 'files' ? { ...item, files: item.files.map((file) => ({ ...file })) } : item));
}
