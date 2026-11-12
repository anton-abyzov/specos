/**
 * The HTTP client: one typed function per endpoint in shared/protocol.ts.
 * Paths are home relative, exactly as the server expects them.
 */
import type {
  ActivityDetail,
  ActivityListResponse,
  AgentEventsResponse,
  AgentInfo,
  AgentsResponse,
  ApiError,
  AttachRequest,
  BenchmarkRequest,
  BenchmarkResult,
  CreateWorkspaceRequest,
  FsEntry,
  FsIndexResponse,
  FsListResponse,
  FsMissing,
  FsMkdirRequest,
  FsRenameRequest,
  FsStatResponse,
  MergeResult,
  OkResponse,
  ProjectsResponse,
  StartAgentRequest,
  SystemInfo,
  SystemStats,
  Workspace,
  WorkspaceDiff,
  WorkspacesResponse,
} from '@shared/protocol';

/** A request the server answered with an error status, or never answered. */
export class ApiRequestError extends Error {
  readonly name = 'ApiRequestError';
  constructor(
    message: string,
    /** HTTP status; 0 when the request never reached the server. */
    readonly status: number,
    /** Machine readable code from the server, for example "not_found". */
    readonly code: string,
    /** The parsed error body, when the server sent JSON. */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | undefined>;

interface RequestOptions {
  query?: Query;
  /** Sent as a JSON body. */
  json?: unknown;
  /** Sent as is, for file contents. */
  raw?: BodyInit;
  signal?: AbortSignal;
}

function url(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

async function send(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined = options.raw;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (typeof options.raw === 'string') {
    headers['content-type'] = 'text/plain; charset=utf-8';
  } else if (options.raw !== undefined) {
    headers['content-type'] = 'application/octet-stream';
  }

  let response: Response;
  try {
    response = await fetch(url(path, options.query), {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: options.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiRequestError('The SpecOS server did not answer.', 0, 'network');
  }
  if (response.ok) return response;

  // Errors are JSON ({error, code}); anything else still becomes a typed error.
  const parsed: unknown = await response.json().catch(() => undefined);
  const error = parsed as Partial<ApiError> | undefined;
  throw new ApiRequestError(
    error?.error ?? `${method} ${path} failed with ${response.status}`,
    response.status,
    error?.code ?? `http_${response.status}`,
    parsed,
  );
}

async function json<T>(method: string, path: string, options?: RequestOptions): Promise<T> {
  const response = await send(method, path, options);
  return (await response.json()) as T;
}

const id = encodeURIComponent;

export const api = {
  fs: {
    list: (path: string, signal?: AbortSignal) => json<FsListResponse>('GET', '/api/fs/list', { query: { path }, signal }),
    stat: (path: string) => json<FsStatResponse>('GET', '/api/fs/stat', { query: { path } }),
    /** The entry at a path, or undefined when nothing is there. Unlike `stat`, a missing path is not a failed request. */
    find: async (path: string): Promise<FsEntry | undefined> => {
      const found = await json<FsEntry | FsMissing>('GET', '/api/fs/stat', { query: { path, missing: 'report' } });
      return 'missing' in found ? undefined : found;
    },
    /** The file decoded as UTF-8 text. */
    readText: async (path: string, signal?: AbortSignal) =>
      (await send('GET', '/api/fs/read', { query: { path }, signal })).text(),
    /** A URL for <img>, <video> or a download; the session cookie authenticates it. */
    readUrl: (path: string, version?: number) => url('/api/fs/read', { path, v: version }),
    /** Creates or replaces a file; parent folders are created. */
    write: (path: string, contents: string | Blob | ArrayBuffer) =>
      json<FsEntry>('PUT', '/api/fs/write', { query: { path }, raw: contents }),
    mkdir: (path: string) => json<FsEntry>('POST', '/api/fs/mkdir', { json: { path } satisfies FsMkdirRequest }),
    rename: (from: string, to: string) =>
      json<FsEntry>('POST', '/api/fs/rename', { json: { from, to } satisfies FsRenameRequest }),
    /** Deletes a file, or a folder with everything in it. */
    remove: (path: string) => json<OkResponse>('DELETE', '/api/fs/delete', { query: { path } }),
    /** Every path under home (capped), for the launcher. */
    index: (signal?: AbortSignal) => json<FsIndexResponse>('GET', '/api/fs/index', { signal }),
  },

  activity: {
    /** Newest first. Pass the last id you have as `before` to page back. */
    list: (options: { limit?: number; before?: number } = {}) =>
      json<ActivityListResponse>('GET', '/api/activity', { query: options }),
    detail: (entryId: number) => json<ActivityDetail>('GET', `/api/activity/${entryId}`),
  },

  projects: () => json<ProjectsResponse>('GET', '/api/projects'),

  workspaces: {
    list: () => json<WorkspacesResponse>('GET', '/api/workspaces'),
    create: (request: CreateWorkspaceRequest) => json<Workspace>('POST', '/api/workspaces', { json: request }),
    remove: (workspaceId: string) => json<OkResponse>('DELETE', `/api/workspaces/${id(workspaceId)}`),
    diff: (workspaceId: string) => json<WorkspaceDiff>('GET', `/api/workspaces/${id(workspaceId)}/diff`),
    /**
     * Merges the workspace back into its project. A conflict is an answer, not
     * a failure: it resolves with merged false and the conflicting paths.
     */
    merge: async (workspaceId: string): Promise<MergeResult> => {
      try {
        // Asked for as a report, so the browser does not log an expected conflict as a failed request.
        return await json<MergeResult>('POST', `/api/workspaces/${id(workspaceId)}/merge`, {
          query: { conflicts: 'report' },
        });
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 409 && isMergeResult(error.body)) return error.body;
        throw error;
      }
    },
  },

  agents: {
    list: () => json<AgentsResponse>('GET', '/api/agents'),
    get: (agentId: string) => json<AgentInfo>('GET', `/api/agents/${id(agentId)}`),
    /** Stream events after `since` (a seq), or all of them. */
    events: (agentId: string, since?: number) =>
      json<AgentEventsResponse>('GET', `/api/agents/${id(agentId)}/events`, { query: { since } }),
    start: (request: StartAgentRequest) => json<AgentInfo>('POST', '/api/agents', { json: request }),
    stop: (agentId: string) => json<AgentInfo>('POST', `/api/agents/${id(agentId)}/stop`),
    /** Copies a home file into the agent's workspace. */
    attach: (agentId: string, path: string) =>
      json<AgentInfo>('POST', `/api/agents/${id(agentId)}/attach`, { json: { path } satisfies AttachRequest }),
    /** Forgets a finished job. */
    remove: (agentId: string) => json<OkResponse>('DELETE', `/api/agents/${id(agentId)}`),
  },

  system: {
    info: () => json<SystemInfo>('GET', '/api/system'),
    stats: () => json<SystemStats>('GET', '/api/system/stats'),
    /** Creates `count` workspaces and reports each clone; progress arrives as 'bench' frames. */
    benchmark: (request: BenchmarkRequest = {}) =>
      json<BenchmarkResult>('POST', '/api/system/benchmark', { json: request }),
  },
};

function isMergeResult(body: unknown): body is MergeResult {
  return typeof body === 'object' && body !== null && Array.isArray((body as MergeResult).conflicts);
}
