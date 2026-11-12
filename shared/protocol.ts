/**
 * The single contract between the SpecOS server and client.
 * Every HTTP body and WebSocket frame is typed here. Change this file first.
 *
 * Paths are always relative to the home folder, POSIX separators, no leading
 * slash. The home folder itself is the empty string "".
 */

// ---------------------------------------------------------------- access

export const SESSION_COOKIE = 'specos_session';
export const TOKEN_PARAM = 'token';

export interface ApiError {
  error: string;
  /** Machine readable code, for example "path_escape", "not_found", "conflict". */
  code: string;
}

// ---------------------------------------------------------------- files

export type EntryKind = 'file' | 'dir' | 'symlink';

export interface FsEntry {
  name: string;
  /** Relative to home. */
  path: string;
  kind: EntryKind;
  size: number;
  /** Milliseconds since the epoch. */
  mtime: number;
  /** Lower case extension without the dot, "" when none. */
  ext: string;
  hidden: boolean;
}

/** GET /api/fs/list?path= */
export interface FsListResponse {
  path: string;
  entries: FsEntry[];
}

/** GET /api/fs/stat?path= */
export type FsStatResponse = FsEntry;

/**
 * GET  /api/fs/read?path=      raw bytes, Content-Type from the extension
 * PUT  /api/fs/write?path=     raw body, creates parent folders -> FsEntry
 * POST /api/fs/mkdir   {path}  -> FsEntry
 * POST /api/fs/rename  {from,to} -> FsEntry
 * DELETE /api/fs/delete?path=  recursive -> {ok:true}
 */
export interface FsMkdirRequest {
  path: string;
}
export interface FsRenameRequest {
  from: string;
  to: string;
}
export interface OkResponse {
  ok: true;
}

/** GET /api/fs/index  every file path under home (capped), for the launcher. */
export interface FsIndexResponse {
  entries: Array<Pick<FsEntry, 'name' | 'path' | 'kind'>>;
  truncated: boolean;
}

// ---------------------------------------------------------------- activity

export type ChangeKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export type Actor =
  | { type: 'me' }
  | { type: 'agent'; agentId: string; name: string; hue: number }
  | { type: 'merge'; agentId: string; name: string; hue: number };

export interface ActivityEntry {
  /** Monotonic id, unique for the life of the journal. */
  id: number;
  at: number;
  kind: ChangeKind;
  path: string;
  isDir: boolean;
  actor: Actor;
  /** Workspace that contains the path, when there is one. */
  workspaceId?: string;
  /** Line counts when a text diff exists. */
  additions?: number;
  deletions?: number;
  hasDiff: boolean;
}

/** GET /api/activity?limit=&before=  newest first */
export interface ActivityListResponse {
  entries: ActivityEntry[];
}

/** GET /api/activity/:id */
export interface ActivityDetail extends ActivityEntry {
  /** Unified diff, empty when the file is binary or too large. */
  patch: string;
}

// ---------------------------------------------------------------- workspaces

export type CloneStrategy = 'reflink' | 'worktree' | 'copy';

export interface CloneStrategyInfo {
  strategy: CloneStrategy;
  /** One sentence the UI can show, for example "ext4 has no reflinks, using git worktrees". */
  reason: string;
  reflinkSupported: boolean;
}

export interface CloneReport {
  strategy: CloneStrategy;
  /** Wall time of the clone in milliseconds, fractional. */
  ms: number;
  /** Logical size of the cloned files. */
  bytes: number;
  /** New disk blocks actually consumed, from the file system's free space delta, never negative. */
  diskBytes: number;
  files: number;
}

export type WorkspaceStatus = 'active' | 'merged' | 'conflict';

export interface Workspace {
  id: string;
  /** Folder name, for example "notes-juniper". */
  name: string;
  /** Relative path, for example "Workspaces/notes-juniper". */
  path: string;
  /** Relative path of the source project, for example "Projects/notes". */
  project: string;
  branch: string;
  baseRef: string;
  clone: CloneReport;
  createdAt: number;
  agentId?: string;
  status: WorkspaceStatus;
}

/** GET /api/projects  folders directly under Projects/ */
export interface ProjectsResponse {
  projects: Array<{ name: string; path: string }>;
}

/** POST /api/workspaces */
export interface CreateWorkspaceRequest {
  /** Relative path of a folder under Projects/. */
  project: string;
  /** Optional label used in the folder name. */
  label?: string;
}

/** GET /api/workspaces */
export interface WorkspacesResponse {
  workspaces: Workspace[];
  strategy: CloneStrategyInfo;
}

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffFile {
  /** Relative to the workspace root. */
  path: string;
  status: DiffStatus;
  additions: number;
  deletions: number;
  /** Unified diff for this file, empty for binary files. */
  patch: string;
}

/** GET /api/workspaces/:id/diff */
export interface WorkspaceDiff {
  workspaceId: string;
  files: DiffFile[];
  additions: number;
  deletions: number;
}

/**
 * POST /api/workspaces/:id/merge  200 on success, 409 with conflicts otherwise.
 * With ?conflicts=report a conflict is answered with 200 as well (merged is false): a browser logs
 * every 4xx answer as an error, and a conflict is an answer the desktop expects.
 */
export interface MergeResult {
  merged: boolean;
  commit?: string;
  /** Project relative paths that changed in the project. */
  files: string[];
  conflicts: string[];
}

// ---------------------------------------------------------------- agents

export type AgentStatus = 'starting' | 'running' | 'done' | 'failed' | 'stopped';
export type AgentRunner = 'claude' | 'demo';

export interface TouchedFile {
  /** Relative to home, so it can be opened directly. */
  path: string;
  kind: ChangeKind;
  at: number;
  /** How many change events this file has had. */
  count: number;
}

export interface AgentInfo {
  id: string;
  /** Friendly name, for example "Juniper". */
  name: string;
  /** 0 to 359, the agent's colour everywhere in the UI. */
  hue: number;
  prompt: string;
  status: AgentStatus;
  runner: AgentRunner;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  workspace: Workspace;
  filesTouched: TouchedFile[];
  /** Home relative paths attached to the job. */
  attachments: string[];
  /** Number of stream events so far. */
  events: number;
  /** Agent this job continues, when it is a follow-up in the same workspace. */
  continues?: string;
  error?: string;
}

/** POST /api/agents  (alias POST /agents) */
export interface StartAgentRequest {
  prompt: string;
  /** Project to clone, for example "Projects/notes". Omit for an empty scratch workspace. */
  project?: string;
  /** Home relative files copied into the workspace before the job starts. */
  attachments?: string[];
  /** Reuse the workspace (and session) of an earlier job. */
  continueFrom?: string;
  /** Force a runner, mostly for tests. */
  runner?: AgentRunner;
}

export type AgentEventKind =
  /** A chunk of the reply text. Concatenate chunks to rebuild the message. */
  | 'text'
  /** The agent finished a reply block; text holds the complete block. */
  | 'message'
  /** The agent called a tool; tool holds its name and summary a short description. */
  | 'tool'
  /** A file in the workspace changed; path is home relative. */
  | 'file'
  /** Lifecycle note: started, attached a file, stopped. */
  | 'status'
  | 'error'
  /** Final result with usage or timing, when the runner reports one. */
  | 'result';

export interface AgentStreamEvent {
  seq: number;
  at: number;
  kind: AgentEventKind;
  text?: string;
  tool?: string;
  summary?: string;
  path?: string;
  change?: ChangeKind;
}

/** GET /api/agents */
export interface AgentsResponse {
  agents: AgentInfo[];
  runner: { available: AgentRunner; claudeVersion?: string };
  /** The name and colour the next new jobs will get, in order, so the desktop can show an agent before its job exists. */
  upcoming?: Array<Pick<AgentInfo, 'name' | 'hue'>>;
}

/** GET /api/agents/:id/events?since=seq */
export interface AgentEventsResponse {
  events: AgentStreamEvent[];
}

/**
 * POST /api/agents/:id/stop            -> AgentInfo
 * POST /api/agents/:id/attach {path}   copies a home file into the workspace -> AgentInfo
 * DELETE /api/agents/:id               forget a finished job -> {ok:true}
 */
export interface AttachRequest {
  path: string;
}

// ---------------------------------------------------------------- system

export interface SystemInfo {
  hostname: string;
  os: { platform: string; name: string; version: string };
  kernel: string;
  arch: string;
  fs: { type: string; device: string; mount: string; total: number; free: number };
  cpu: { model: string; cores: number; load: [number, number, number] };
  memory: { total: number; available: number };
  uptime: number;
  node: string;
  home: string;
  clone: CloneStrategyInfo;
  agentRunner: { available: AgentRunner; claudeVersion?: string };
  /** Short badge text, for example "Linux 6.8 · ext4". */
  badge: string;
}

export interface SystemStats {
  at: number;
  /** 0 to 1 across all cores since the previous tick. */
  cpu: number;
  /** 0 to 1 used memory. */
  memory: number;
  memoryUsed: number;
  memoryTotal: number;
  agentsRunning: number;
}

/** POST /api/system/benchmark */
export interface BenchmarkRequest {
  count?: number;
  /** Project to clone; a sample project is generated when omitted. */
  project?: string;
}

export interface BenchmarkResult {
  id: string;
  strategy: CloneStrategy;
  project: string;
  count: number;
  totalMs: number;
  clones: CloneReport[];
  /** Files and logical bytes of the project that was cloned. */
  projectFiles: number;
  projectBytes: number;
}

// ---------------------------------------------------------------- sockets

/** Frames the server sends on /ws. */
export type ServerEvent =
  | { type: 'hello'; system: SystemInfo }
  | { type: 'fs'; entry: ActivityEntry }
  | { type: 'agent'; agent: AgentInfo }
  | { type: 'agent-removed'; id: string }
  | { type: 'agent-event'; id: string; event: AgentStreamEvent }
  | { type: 'workspace'; workspace: Workspace }
  | { type: 'workspace-removed'; id: string }
  | { type: 'stats'; stats: SystemStats }
  | { type: 'bench'; id: string; index: number; count: number; clone: CloneReport }
  | { type: 'bench-done'; result: BenchmarkResult };

/** /ws/pty?cols=&rows=&cwd=  frames from the client. */
export type PtyClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

/** /ws/pty frames from the server. */
export type PtyServerFrame =
  | { type: 'ready'; pid: number; shell: string; cwd: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number };
