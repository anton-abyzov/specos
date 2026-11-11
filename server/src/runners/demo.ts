import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Run, RunnerEvent, RunOutcome, RunRequest } from './runner';

/**
 * The demo runner: a scripted agent for machines without a model. It talks
 * and edits real files at a pace a person can follow, so the desktop shows
 * what live agent work looks like. Nothing in it is random: the same agent
 * with the same prompt in the same folder does the same thing.
 */

export interface DemoOptions {
  /** How many times faster than the watching pace to work. Every wait is divided by it. */
  speed: number;
}

// The watching pace, in milliseconds.
const FIRST_WORD_AFTER = 60;
const WORD_EVERY = 40;
const LINE_EVERY = 350;
const PAUSE = 700;

const MAX_TARGETS = 2;
const MIN_LINES = 4;
const EXTRA_LINES = 3;
const NEW_NOTE = 'NOTES.md';
const ATTACHMENTS = 'attachments';
const PROMPT_EXCERPT_CHARS = 60;

/** Folders that hold no notes worth editing, or far too many files to look through. */
const SKIPPED_FOLDERS = new Set(['.git', 'node_modules', ATTACHMENTS]);
const NOTE_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const MAX_FILES_LISTED = 5000;
const MAX_EDITABLE_BYTES = 256 * 1024;

/** What the agent says it is doing on each line it writes, in order. */
const STEPS = [
  'read the request',
  'looked at what is already here',
  'drafted a first answer',
  'checked it against the request',
  'tightened the wording',
  'left this for review',
];

// ---------------------------------------------------------------- choosing files

/** Every file below a folder as a POSIX relative path, shallow ones first, each level by name. */
async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const folders = [''];
  for (let next = 0; next < folders.length && files.length < MAX_FILES_LISTED; next++) {
    const folder = folders[next] as string;
    const children = await fsp.readdir(path.join(root, folder), { withFileTypes: true });
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // Files before folders, so a note next to the README wins over one three levels down.
    for (const child of children) {
      if (child.isFile()) files.push(path.posix.join(folder, child.name));
    }
    for (const child of children) {
      if (child.isDirectory() && !SKIPPED_FOLDERS.has(child.name)) folders.push(path.posix.join(folder, child.name));
    }
  }
  return files.slice(0, MAX_FILES_LISTED);
}

/** True for a file the agent can add lines to: text, and not huge. An image must not get notes appended. */
async function isEditable(abs: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(abs);
    if (!stat.isFile() || stat.size > MAX_EDITABLE_BYTES) return false;
    return !(await fsp.readFile(abs)).includes(0);
  } catch {
    return false;
  }
}

/** True when the prompt names the file, as a word of its own: "tidy note.md." does, "footnote.md" does not. */
function isNamedIn(prompt: string, file: string): boolean {
  const name = path.posix.basename(file).toLowerCase();
  const at = prompt.toLowerCase().indexOf(name);
  if (at === -1) return false;
  const before = prompt[at - 1] ?? ' ';
  const after = prompt.slice(at + name.length);
  return !/[\w.-]/.test(before) && !/^(?:[\w-]|\.\w)/.test(after);
}

/**
 * The files to edit, best first: what the user attached, then a file the
 * prompt names, then the first note in the workspace. With none of these the
 * agent starts a note of its own.
 */
async function chooseTargets(request: RunRequest): Promise<string[]> {
  const files = await listFiles(request.cwd);
  const wanted = [
    ...request.attachments,
    ...files.filter((file) => isNamedIn(request.prompt, file)),
    ...files.filter((file) => NOTE_EXTENSIONS.has(path.posix.extname(file).toLowerCase())),
  ];
  const targets: string[] = [];
  for (const file of wanted) {
    if (targets.length === MAX_TARGETS) break;
    if (!targets.includes(file) && (await isEditable(path.join(request.cwd, file)))) targets.push(file);
  }
  return targets.length > 0 ? targets : [NEW_NOTE];
}

// ---------------------------------------------------------------- the script

/** A small stable number from a text, so that different agents write different amounts. */
const numberFrom = (text: string): number => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 9973, 7);

function excerptOf(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return oneLine.length > PROMPT_EXCERPT_CHARS ? oneLine.slice(0, PROMPT_EXCERPT_CHARS - 1).trimEnd() + '…' : oneLine;
}

/** The lines one agent adds to one file. Each names the agent and quotes the prompt, so two agents never write the same. */
function linesFor(agentName: string, prompt: string, file: string): string[] {
  const count = MIN_LINES + (numberFrom(agentName + file) % EXTRA_LINES);
  return STEPS.slice(0, count).map((step, index) => `- ${agentName} (${index + 1}/${count}) ${step}: "${excerptOf(prompt)}"`);
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

class Stopped extends Error {}

export function runDemo(request: RunRequest, options: DemoOptions): Run {
  const { agentName, cwd } = request;
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;
  /** A file operation that was under way when the run was stopped still returns; what follows it stays unsaid. */
  const emit = (event: RunnerEvent): void => {
    if (!stopped) request.emit(event);
  };
  let giveUp: (reason: Stopped) => void = () => undefined;

  /** Waits at the watching pace divided by the speed. Ends at once, by throwing, when the run is stopped. */
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve, reject) => {
      if (stopped) return reject(new Stopped());
      giveUp = reject;
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms / options.speed);
      timers.add(timer);
    });

  /** Streams a reply word by word, then reports the whole of it so the desktop can settle the text. */
  async function say(text: string): Promise<void> {
    for (const word of text.split(' ')) {
      await wait(WORD_EVERY);
      emit({ kind: 'text', text: word + ' ' });
    }
    emit({ kind: 'message', text });
  }

  async function edit(file: string): Promise<number> {
    const abs = path.join(cwd, file);
    const existing = await fsp.readFile(abs, 'utf8').catch(() => undefined);
    emit(existing === undefined ? { kind: 'tool', tool: 'Write', summary: file } : { kind: 'tool', tool: 'Read', summary: file });
    await wait(PAUSE);
    if (existing === undefined) {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, `# Notes by ${agentName}\n\n`);
    } else {
      emit({ kind: 'tool', tool: 'Edit', summary: file });
      // The first new line must not end up glued to a last line that has no line break.
      if (existing !== '' && !existing.endsWith('\n')) await fsp.appendFile(abs, '\n');
    }
    const lines = linesFor(agentName, request.prompt, file);
    for (const line of lines) {
      await wait(LINE_EVERY);
      await fsp.appendFile(abs, line + '\n');
    }
    return lines.length;
  }

  async function script(): Promise<void> {
    const started = Date.now();
    await wait(FIRST_WORD_AFTER - WORD_EVERY);
    await say(`On it. I am ${agentName}, working in my own copy of the project, so nothing here touches the original until you merge it.`);
    await wait(PAUSE);
    emit({ kind: 'tool', tool: 'List', summary: 'files in the workspace' });
    const targets = await chooseTargets(request);
    await wait(PAUSE);

    let written = 0;
    for (const file of targets) {
      written += await edit(file);
      await wait(PAUSE);
    }

    await say(`Done. I added ${plural(written, 'line')} to ${targets.join(' and ')}. Open the diff to read them, and merge when you are happy.`);
    emit({ kind: 'result', summary: `${((Date.now() - started) / 1000).toFixed(1)} s · ${plural(targets.length, 'file')} edited` });
  }

  const finished = script().then(
    (): RunOutcome => ({ exitCode: 0 }),
    (error: Error): RunOutcome => (error instanceof Stopped ? { exitCode: null } : { exitCode: 1, error: `The demo agent failed: ${error.message}` }),
  );

  return {
    finished,
    stop() {
      if (stopped) return;
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      giveUp(new Stopped());
    },
  };
}
