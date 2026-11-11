import type { AgentStreamEvent } from '../../../shared/protocol';

/**
 * What the agents module asks of a runner, and what a runner reports back.
 * A runner does the work of one job in one folder; numbering the events,
 * keeping them and deciding the job's status are the module's business.
 */

/** A stream event as a runner reports it; the job gives it its number and time. */
export type RunnerEvent = Omit<AgentStreamEvent, 'seq' | 'at'>;

export interface RunRequest {
  prompt: string;
  /** The agent's friendly name, for example "Juniper". */
  agentName: string;
  /** Absolute path of the workspace; the run happens here. */
  cwd: string;
  /** The copies of the attached files, relative to the workspace. */
  attachments: string[];
  /** The session of the job this one continues, when the runner has sessions. */
  resumeSession?: string;
  emit(event: RunnerEvent): void;
  /** Called when the runner learns the id of its session, so a later job can continue it. */
  onSession(sessionId: string): void;
}

export interface RunOutcome {
  /** 0 for success. Null when the run ended without an exit code: stopped, killed, or never started. */
  exitCode: number | null;
  /** Why it failed, in words for the user. */
  error?: string;
}

export interface Run {
  /** Settles when the run is over and nothing of it is left: no process, no timer. Never rejects. */
  finished: Promise<RunOutcome>;
  /** Ends the run early. Safe to call more than once and after the end. */
  stop(): void;
}
