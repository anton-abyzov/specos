import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * Runs git for the server. Commands that only read or move branches run as
 * they are; the ones that look at or record the state of a folder start with
 * AS_SERVER.
 */

/**
 * Settings for the commits the server makes, to put in front of status, add,
 * commit and merge. The identity is passed on the command line, so neither
 * the user's global configuration nor a project's own is read for it or
 * written to.
 */
export const AS_SERVER: readonly string[] = [
  '-c', 'user.name=SpecOS',
  '-c', 'user.email=specos@localhost',
  // A signing key would open a passphrase prompt nobody can answer.
  '-c', 'commit.gpgsign=false',
  // A workspace is a copy of what the user sees in the folder; their personal ignore list must not thin it out.
  '-c', 'core.excludesFile=',
];

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** The subcommand in an argument list, past the `-c name=value` pairs in front of it. */
function subcommandOf(args: readonly string[]): string {
  let index = 0;
  while (args[index] === '-c') index += 2;
  return args[index] ?? '';
}

/** A git command that exited with an error. The message is git's own, which names paths below home only. */
export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number | undefined,
  ) {
    super(`git ${subcommandOf(args)} failed: ${stderr.trim() || 'no output'}`);
    this.name = 'GitError';
  }
}

/** Runs `git <args>` in a folder and resolves with its stdout, trailing newline removed. */
export function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          // Git looks for a repository in the folder and no higher. The home folder may itself sit inside
          // someone's repository, and a command meant for a project must never land there.
          GIT_CEILING_DIRECTORIES: path.dirname(cwd),
        },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout.replace(/\n$/, ''));
        reject(new GitError(args, stderr || error.message, typeof error.code === 'number' ? error.code : undefined));
      },
    );
  });
}
