import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { SCRATCH_PREFIX } from './paths';

/**
 * The project the clone benchmark copies when it is not given one: about two
 * hundred small source, test, document and data files, the size of a modest
 * real project. The content is computed from fixed seeds, so every machine
 * clones the same bytes and their timings can be compared.
 */

export const SAMPLE_PROJECT_NAME = 'sample-project';

const README = `# Sample project

SpecOS generated this folder for its clone benchmark (System, "Create 10 agent
workspaces"). The benchmark gives each test workspace its own copy of this
project and reports how long every copy took.

Nothing here is meant to run. The files are computed text of the size and
shape of a small real project: TypeScript modules in \`src/\`, their tests in
\`tests/\`, notes in \`docs/\` and tables in \`data/\`.

You can delete the folder. It is generated again the next time the benchmark
runs without a project of your own.
`;

// ---------------------------------------------------------------- deterministic text

/** A small seeded generator (mulberry32). Math.random would give every machine a different project. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const NOUNS = (
  'orbit ledger harbor signal lantern meadow engine compass archive river ' +
  'beacon canyon garden bridge anchor window forest market station valley'
).split(' ');
const VERBS = 'scale merge trace fold align weigh chart sort blend carry mark round'.split(' ');
const QUALITIES = 'steady quiet bright narrow early distant level plain rapid gentle'.split(' ');

interface Words {
  noun(): string;
  verb(): string;
  quality(): string;
  /** A whole number from 1 up to and including `max`. */
  number(max: number): number;
}

function wordsFrom(random: () => number): Words {
  const pick = (list: string[]): string => list[Math.floor(random() * list.length)] as string;
  return {
    noun: () => pick(NOUNS),
    verb: () => pick(VERBS),
    quality: () => pick(QUALITIES),
    number: (max) => 1 + Math.floor(random() * max),
  };
}

const capitalised = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** Adds blocks until the text is as long as the file should be. */
function fill(targetBytes: number, head: string, block: (index: number) => string): string {
  let text = head;
  for (let index = 0; text.length < targetBytes; index++) text += block(index);
  return text;
}

// ---------------------------------------------------------------- kinds of file

type Writer = (title: string, words: Words, targetBytes: number) => string;

const moduleFile: Writer = (title, words, targetBytes) =>
  fill(targetBytes, `/** ${capitalised(title)}: ${words.quality()} helpers for the ${words.noun()}. */\n\n`, (index) => {
    const verb = words.verb();
    const noun = words.noun();
    const step = words.number(97);
    return (
      `/** Helps to ${verb} a reading of the ${noun} and keeps it within the ${words.quality()} range. */\n` +
      `export function ${verb}${capitalised(noun)}${index}(reading: number): number {\n` +
      `  const offset = ${words.number(900)};\n` +
      `  return (reading * ${step} + offset) % ${step * 13 + 7};\n` +
      `}\n\n`
    );
  });

const testFile: Writer = (title, words, targetBytes) =>
  fill(targetBytes, `import { expect, test } from 'vitest';\n\n// Checks for ${title}.\n\n`, (index) => {
    const left = words.number(500);
    const right = words.number(500);
    return (
      `test('can ${words.verb()} the ${words.quality()} ${words.noun()} (${index})', () => {\n` +
      `  const total = ${left} + ${right};\n` +
      `  expect(total).toBe(${left + right});\n` +
      `});\n\n`
    );
  });

const documentFile: Writer = (title, words, targetBytes) =>
  fill(targetBytes, `# ${capitalised(title)}\n\n`, (index) => {
    const sentence = (): string =>
      `The ${words.quality()} ${words.noun()} will ${words.verb()} the ${words.noun()} ` +
      `before the ${words.quality()} ${words.noun()} can ${words.verb()} it.`;
    const heading = index % 4 === 0 ? `## ${capitalised(words.quality())} ${words.noun()}\n\n` : '';
    return `${heading}${sentence()} ${sentence()} ${sentence()}\n\n`;
  });

const tableFile: Writer = (_title, words, targetBytes) =>
  fill(targetBytes, 'id,name,quality,amount,share\n', (index) => {
    const share = (words.number(999) / 10).toFixed(1);
    return `${index + 1},${words.noun()}-${words.number(99)},${words.quality()},${words.number(9000)},${share}\n`;
  });

/** Where the files go. Together with the README this makes 200 files. */
const LAYOUT: Array<{ folder: string; count: number; ext: string; write: Writer }> = [
  { folder: 'src/core', count: 40, ext: 'ts', write: moduleFile },
  { folder: 'src/ui', count: 40, ext: 'ts', write: moduleFile },
  { folder: 'tests', count: 30, ext: 'test.ts', write: testFile },
  { folder: 'docs', count: 50, ext: 'md', write: documentFile },
  { folder: 'data', count: 39, ext: 'csv', write: tableFile },
];

/** Files are 5 to 9 KB, which puts the whole project near 1.4 MB. */
const MIN_FILE_BYTES = 5 * 1024;
const FILE_BYTES_SPREAD = 4 * 1024;

async function writeFiles(root: string): Promise<void> {
  await fsp.writeFile(path.join(root, 'README.md'), README);
  let seed = 1;
  for (const { folder, count, ext, write } of LAYOUT) {
    await fsp.mkdir(path.join(root, folder), { recursive: true });
    for (let index = 1; index <= count; index++) {
      const random = seeded(seed++);
      const words = wordsFrom(random);
      const name = `${words.noun()}-${String(index).padStart(2, '0')}`;
      const targetBytes = MIN_FILE_BYTES + Math.floor(random() * FILE_BYTES_SPREAD);
      await fsp.writeFile(path.join(root, folder, `${name}.${ext}`), write(name.replace('-', ' '), words, targetBytes));
    }
  }
}

/**
 * Makes sure `<projectsFolder>/sample-project` exists, generating it when it
 * does not. An existing folder is left as it is, whatever it contains.
 */
export async function ensureSampleProject(projectsFolder: string): Promise<void> {
  const target = path.join(projectsFolder, SAMPLE_PROJECT_NAME);
  const present = await fsp.lstat(target).then(
    () => true,
    () => false,
  );
  if (present) return;

  // Built under a scratch name and moved into place, so the project appears whole or not at all.
  const scratch = path.join(projectsFolder, `${SCRATCH_PREFIX}sample-${randomBytes(4).toString('hex')}`);
  try {
    await fsp.mkdir(scratch);
    await writeFiles(scratch);
    await fsp.rename(scratch, target);
  } catch (error) {
    await fsp.rm(scratch, { recursive: true, force: true });
    throw error;
  }
}
