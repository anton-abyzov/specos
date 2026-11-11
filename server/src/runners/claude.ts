import { spawn } from 'node:child_process';
import type { Run, RunnerEvent, RunOutcome, RunRequest } from './runner';

/**
 * The claude runner: one `claude -p` process per job, in the job's workspace,
 * with its stream of JSON lines turned into the events the desktop shows.
 */

// ---------------------------------------------------------------- parsing

export interface ParsedLine {
  events: RunnerEvent[];
  /** The session the line announces, when it is the one that opens the stream. */
  sessionId?: string;
}

const NOTHING: ParsedLine = { events: [] };
const SUMMARY_MAX_LENGTH = 140;

/** The fields of a tool's input that say what it is working on, most telling first. */
const SUMMARY_FIELDS = ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query', 'description', 'prompt'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** One line saying what a tool call is about: the file, command or pattern from its input. */
function toolSummary(input: unknown, cwd: string | undefined): string {
  if (!isRecord(input)) return '';
  const told = SUMMARY_FIELDS.map((field) => input[field]).find((value) => typeof value === 'string' && value !== '');
  if (typeof told !== 'string') return '';
  // Paths below the workspace read better, and say less about the machine, without the part in front.
  const local = cwd !== undefined && told.startsWith(cwd + '/') ? told.slice(cwd.length + 1) : told;
  const oneLine = local.replace(/\s+/g, ' ').trim();
  return oneLine.length > SUMMARY_MAX_LENGTH ? oneLine.slice(0, SUMMARY_MAX_LENGTH - 1) + '…' : oneLine;
}

/** The text and tool calls of one finished assistant message, in the order they were written. */
function assistantEvents(message: unknown, cwd: string | undefined): RunnerEvent[] {
  const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
  const events: RunnerEvent[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      events.push({ kind: 'message', text: block.text });
    }
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      events.push({ kind: 'tool', tool: block.name, summary: toolSummary(block.input, cwd) });
    }
  }
  return events;
}

/** How the run went, from its closing line: the failure in words, or time, turns and cost. */
function resultEvent(line: Record<string, unknown>): RunnerEvent {
  if (line.is_error === true) {
    const said = typeof line.result === 'string' && line.result.trim() !== '' ? line.result.trim() : undefined;
    const subtype = typeof line.subtype === 'string' ? line.subtype.replace(/_/g, ' ') : 'the run failed';
    return { kind: 'error', text: said ?? subtype };
  }
  const parts: string[] = [];
  if (typeof line.duration_ms === 'number') parts.push(`${(line.duration_ms / 1000).toFixed(1)} s`);
  if (typeof line.num_turns === 'number') parts.push(`${line.num_turns} ${line.num_turns === 1 ? 'turn' : 'turns'}`);
  if (typeof line.total_cost_usd === 'number') parts.push(`$${line.total_cost_usd.toFixed(4)}`);
  return { kind: 'result', summary: parts.join(' · ') || 'finished' };
}

/**
 * Turns one line of `claude --output-format stream-json` into stream events.
 * A line that is not JSON, or of a kind the desktop has no use for (tool
 * results, hooks, thinking), becomes nothing. `cwd` shortens the paths in
 * tool summaries to workspace relative ones.
 */
export function parseClaudeLine(text: string, cwd?: string): ParsedLine {
  let line: unknown;
  try {
    line = JSON.parse(text);
  } catch {
    return NOTHING;
  }
  if (!isRecord(line)) return NOTHING;

  switch (line.type) {
    case 'system':
      if (line.subtype !== 'init') return NOTHING;
      return {
        events: [{ kind: 'status', text: 'session started' }],
        ...(typeof line.session_id === 'string' ? { sessionId: line.session_id } : {}),
      };
    case 'stream_event': {
      const event = line.event;
      if (!isRecord(event) || event.type !== 'content_block_delta' || !isRecord(event.delta)) return NOTHING;
      const { type, text: chunk } = event.delta;
      return type === 'text_delta' && typeof chunk === 'string' && chunk !== '' ? { events: [{ kind: 'text', text: chunk }] } : NOTHING;
    }
    case 'assistant':
      return { events: assistantEvents(line.message, cwd) };
    case 'result':
      return { events: [resultEvent(line)] };
    default:
      return NOTHING;
  }
}

// ---------------------------------------------------------------- process

export interface ClaudeOptions {
  /** The executable: a name on PATH or a path. */
  command: string;
  /** Flags added after the fixed ones, from SPECOS_CLAUDE_ARGS. */
  extraArgs: readonly string[];
  /** The SpecOS access token, which the agent must not be able to read from its environment. */
  token: string;
  /** How long a stopped run gets to end by itself before it is killed. */
  killAfterMs?: number;
}

const KILL_AFTER_MS = 3000;
/** After claude itself has exited, how long what it left running may keep its output open. */
const LEFTOVER_GRACE_MS = 1000;
const STDERR_TAIL_CHARS = 2000;

/** Settings that say how claude reaches its model. Unlike the other CLAUDE_CODE_ variables these are the user's own. */
const KEPT_CLAUDE_VARIABLES = /^CLAUDE_CODE_(USE_(BEDROCK|VERTEX|FOUNDRY)|OAUTH_TOKEN)$/;

/**
 * The environment claude runs in: the server's own, without the access token
 * and SpecOS settings, and without the marks a Claude Code session leaves on
 * its children. With those marks the new process would take itself for a
 * nested part of that session instead of a run of its own.
 */
export function claudeEnv(env: NodeJS.ProcessEnv, token: string): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || name.startsWith('SPECOS_') || value.includes(token)) continue;
    const marksSession = name === 'CLAUDECODE' || (name.startsWith('CLAUDE_CODE_') && !KEPT_CLAUDE_VARIABLES.test(name));
    if (!marksSession) kept[name] = value;
  }
  return kept;
}

/** The command line of one run. */
export function claudeArguments(prompt: string, extraArgs: readonly string[], resumeSession?: string): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    // stream-json needs it, and partial messages are what make the reply appear as it is written.
    '--verbose',
    '--include-partial-messages',
    // Nobody is there to answer a permission prompt; edits stay inside the agent's own copy.
    '--permission-mode',
    'acceptEdits',
    ...extraArgs,
    ...(resumeSession === undefined ? [] : ['--resume', resumeSession]),
  ];
}

const lastOf = (text: string, chars: number): string => (text.length > chars ? text.slice(-chars) : text);

export function runClaude(request: RunRequest, options: ClaudeOptions): Run {
  const child = spawn(options.command, claudeArguments(request.prompt, options.extraArgs, request.resumeSession), {
    cwd: request.cwd,
    env: claudeEnv(process.env, options.token),
    // A process group of its own, so that stopping reaches the commands claude started as well.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  /** Signals claude and everything it started. False when none of it is left. */
  const signalGroup = (signal: NodeJS.Signals): boolean => {
    if (child.pid === undefined) return false;
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      return false;
    }
  };

  let pending = '';
  const readLine = (text: string): void => {
    const parsed = parseClaudeLine(text, request.cwd);
    if (parsed.sessionId !== undefined) request.onSession(parsed.sessionId);
    for (const event of parsed.events) request.emit(event);
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) readLine(line);
  });

  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrTail = lastOf(stderrTail + chunk, STDERR_TAIL_CHARS);
  });

  let killTimer: NodeJS.Timeout | undefined;
  let leftoverTimer: NodeJS.Timeout | undefined;
  let over = false;

  const finished = new Promise<RunOutcome>((resolve) => {
    const settle = (outcome: RunOutcome): void => {
      if (over) return;
      over = true;
      clearTimeout(killTimer);
      clearTimeout(leftoverTimer);
      resolve(outcome);
    };

    // Not started at all: the usual reason is that claude is not installed.
    child.once('error', (error: NodeJS.ErrnoException) => {
      const reason = error.code === 'ENOENT' ? `${options.command} was not found on PATH` : error.message;
      settle({ exitCode: null, error: `claude could not be started: ${reason}` });
    });

    child.once('exit', () => {
      // A command claude left in the background would hold the output open and keep the job running for ever.
      if (!signalGroup('SIGTERM')) return;
      leftoverTimer = setTimeout(() => {
        signalGroup('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
      }, LEFTOVER_GRACE_MS);
    });

    // Fires after the exit and after both pipes have been read to their end.
    child.once('close', (code, signal) => {
      if (pending !== '') readLine(pending);
      if (code === 0) return settle({ exitCode: 0 });
      const said = stderrTail.trim();
      const fallback = code === null ? `claude was ended by ${signal ?? 'a signal'}` : `claude exited with code ${code}`;
      settle({ exitCode: code, error: said || fallback });
    });
  });

  return {
    finished,
    stop() {
      if (over || killTimer) return;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), options.killAfterMs ?? KILL_AFTER_MS);
    },
  };
}
