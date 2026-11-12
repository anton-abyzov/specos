# SpecOS: browser desktop for AI agent work

## Problem

Running several AI agents on one machine today means a pile of terminals and editor tabs. Nothing shows which agent is running, where it works, or what it just changed, and giving each agent a private copy of a project is slow and manual. Linux already has what agents need (a fast real file system, a real shell, cheap isolated copies through reflinks and git worktrees), but no desktop makes that visible.

SpecOS is the desktop for that work. It runs in a browser, is served by a Node process on a Linux machine, and is opened from another computer on the network. It is not a kernel. It is the desktop you would want on top of one.

## Scope

In: a Node server (Fastify + ws) bound to 0.0.0.0 with token access; a sandboxed home folder at `home/`; file API with a live watch channel; a real PTY shell; millisecond agent workspaces; agent jobs (`claude` CLI or a scripted demo agent); system info; and a React desktop with a window manager, launcher, menu bar, dock and seven apps (Files, Terminal, Editor, Chat, Agents, Activity, System), in light and dark.

Out: multi-user accounts, TLS termination, confining the shell or agents to the home folder (the shell is a real shell as the server's user), mobile layouts, copying any existing desktop's artwork, names or layouts.

## Acceptance Criteria

- [ ] AC-01: The server binds 0.0.0.0, generates a random token at start and prints one URL containing it. The first visit with the token sets an HttpOnly cookie and redirects to a clean URL. Every HTTP request without a valid cookie or token gets 401.
- [ ] AC-02: Every WebSocket upgrade without the cookie, or from a foreign Origin, is rejected before a socket opens.
- [ ] AC-03: Every file API path resolves inside `home/`. `..`, absolute paths, NUL bytes and symlinks that leave the home folder are rejected with 400/403, proven by tests written before the implementation.
- [ ] AC-04: File API lists, reads, writes, renames, deletes and makes folders, and a WebSocket channel delivers a change event within 500 ms of a change on disk.
- [ ] AC-05: Every file change is journalled with its author (me, or the agent that owns the workspace) and a text diff.
- [ ] AC-06: The terminal is a real shell through node-pty over WebSocket, started in the home folder, with resize.
- [ ] AC-07: "Give this agent its own copy" clones a project into a workspace using reflink copies where the file system supports them, git worktrees otherwise on Linux, and a plain copy elsewhere, and reports strategy, milliseconds and bytes for each clone.
- [ ] AC-08: A workspace exposes a diff against its base and can be merged back into its project. Conflicts are reported and leave the project untouched.
- [ ] AC-09: `POST /agents` starts a job in its own workspace. With `claude` on PATH it runs `claude -p "<prompt>" --output-format stream-json` there and streams the events; otherwise a scripted demo agent edits files slowly. Jobs can be stopped and report the files they touched.
- [ ] AC-10: A system endpoint reports OS, kernel, file system type of the home folder, CPU and memory, and a benchmark creates 10 workspaces and reports each time.
- [ ] AC-11: The desktop has an original visual identity (own icons, wallpaper, window controls, type and colour) in light and dark themes, with a translucent menu bar and a dock with running indicators and hover magnify.
- [ ] AC-12: Windows open, move, resize, minimise to the dock, go full screen and close with spring animations. Dragging and resizing run at 60 fps with no jumps or flashes.
- [ ] AC-13: Windows snap to halves and quarters at screen edges, a tiling toggle arranges all windows, four desktops switch on Ctrl+1 to 4 with a slide, F3 shows an overview, and layout persists across reloads.
- [ ] AC-14: The launcher opens on Cmd/Ctrl+Space or Cmd/Ctrl+K and fuzzy-searches apps, files, running agents and actions.
- [ ] AC-15: The menu bar shows the active app's menus, desktops, clock, a live count of running agents, CPU and memory, and a kernel and file system badge that opens the System window.
- [ ] AC-16: Files has a column view with breadcrumbs, a sidebar of places, quick look on Space for text, images and Markdown, live change animation, and drag of a file onto an agent window to attach it.
- [ ] AC-17: Terminal runs xterm.js on the PTY, and Editor is a CodeMirror editor with save that reloads when the file changes on disk.
- [ ] AC-18: Chat is keyboard-first, starts an agent job per message and streams each reply from the first keystroke of Enter.
- [ ] AC-19: Agents shows one card per job with status, elapsed time, workspace, touched files (click to open) and stop. Each job has its own window with the live stream and its own dock icon.
- [ ] AC-20: Activity shows a timeline of every file change with its author and a diff view, and merges an agent's workspace back.
- [ ] AC-21: System shows the machine facts and a one-click test that creates 10 agent workspaces and shows how long it took.
- [ ] AC-22: End to end: create a project folder with a note in Files, start two agents from Chat that each edit the note in their own workspace, watch both change live, open the diff, merge one back. No console errors.
- [ ] AC-23: README has a screenshot and the security model in five lines.

## Approach

One npm package, ESM, TypeScript everywhere.

```
shared/protocol.ts   every HTTP and WebSocket type; the single contract between server and client
server/src/          Fastify app; one module per concern, each exports register(app, ctx)
client/              Vite root. src/desktop (shell, window manager), src/apps/<app>, src/lib, src/design
tests/server/        vitest, real HTTP and WebSocket against an app on a random port
tests/e2e/           Playwright, headless, against a built client and a throwaway home
home/                the sandboxed home folder (contents ignored by git)
data/                server state: activity journal, workspace and agent registry (ignored by git)
```

Server.
- `config.ts` reads `HOST` (0.0.0.0), `PORT` (7300), `SPECOS_HOME` (`./home`), `SPECOS_DATA` (`./data`), `SPECOS_TOKEN` (random 32 bytes, base64url, when unset), `SPECOS_CLIENT_DIST` (`client/dist`), `SPECOS_AGENT` (`auto`, `claude` or `demo`).
- `auth.ts`: one `onRequest` hook guards everything, static files included. `?token=` that matches sets `specos_session` (HttpOnly, SameSite=Strict, Path=/) and answers 302 to the same path without the token. Comparison is constant time. `server.on('upgrade')` checks the cookie and that `Origin` matches `Host` before handing the socket to ws; otherwise it writes `401` and destroys the socket.
- `paths.ts`: `resolveInHome(rel)` rejects absolute paths, NUL and any `..` segment, joins onto the real path of home, then walks to the deepest existing ancestor and requires its realpath to stay inside home, so a symlink that points out is refused for reads and for writes through it.
- `fs-api.ts`: `/api/fs/{list,stat,read,write,mkdir,rename,delete,index}`. Reads are served with `nosniff` and `Content-Security-Policy: sandbox` so a file in home can never script the desktop.
- `watch.ts` + `activity.ts`: one chokidar watcher on home (ignoring `.git`, `node_modules`). Each event becomes an `ActivityEntry` with an actor: the agent that owns the workspace containing the path, a merge marker while the server merges, otherwise `me`. A snapshot cache of text files (up to 256 KB) gives a unified diff for each change. Entries go to a ring buffer and `data/activity.jsonl`, and out on the events socket.
- `ws.ts`: `/ws` is the events socket (fs, agents, agent stream, stats, workspaces, benchmark). `/ws/pty` is one socket per terminal.
- `pty.ts`: node-pty running `$SHELL` in home; JSON frames for input, resize, output, exit.
- `workspaces.ts`: projects live in `home/Projects/<name>`, workspaces in `home/Workspaces/<project>-<agent>`. A project becomes a git repository on first clone (its current state is committed as the base). Strategy is probed once: `reflink` when `cp --reflink=always` works in home (btrfs, XFS, bcachefs), then the whole repository is cloned with `cp -a --reflink=auto` and switched to branch `agent/<id>`; `worktree` otherwise on Linux (`git worktree add -b agent/<id>`); `copy` elsewhere. Each clone is timed with `process.hrtime` and reports logical bytes, file count and the free-space delta of the file system.
- Diff is `git diff <base>` in the workspace including untracked files. Merge commits the workspace, commits the project's own pending edits as the user, then merges `agent/<id>` with `--no-ff`. On conflict the merge is aborted and the conflicting paths are returned with 409.
- `agents.ts`: `POST /api/agents` (alias `POST /agents`) creates a workspace and starts a runner. `claude` runner: `claude -p <prompt> --output-format stream-json --verbose --include-partial-messages --permission-mode acceptEdits` with cwd set to the workspace; each JSON line is normalised into an `AgentStreamEvent`. `demo` runner: a scripted agent that streams words and appends to files on a timer. Touched files come from the watcher, so both runners report them the same way. Stop sends SIGTERM to the process group.
- `system.ts`: `/api/system` from `os`, `/etc/os-release`, `findmnt -T home`; a 2 s stats tick on the events socket. `/api/system/benchmark` (in `workspaces.ts`) creates N workspaces from a sample project, streams each result, then removes them.

Client.
- State in zustand stores (windows, files cache, agents, activity, theme). The windows store persists to `localStorage`.
- Window drag and resize write `transform`/size straight to the DOM inside `requestAnimationFrame` and commit to the store on pointer up, so React does not render per frame. Open, close, minimise and desktop slides use `motion` springs.
- Design tokens are CSS variables in `client/src/design/tokens.css`, switched by `data-theme` on `<html>`. Fonts are bundled (Bricolage Grotesque for display, Instrument Sans for interface, JetBrains Mono for code). Icons, wallpaper and window controls are drawn for this project as SVG.
- Each app is a lazy module in `client/src/apps/<id>/` registered in `client/src/apps/registry.ts`. An agent job is a window of app `agent` with its own dock icon.
- `window.__specos` exposes `setTheme`, `openApp` and the stores for tests and screenshots.

Rejected: Tailwind (tokens in plain CSS are enough and keep the identity in one file); one WebSocket per watched folder (one multiplexed events socket is simpler for a single user); hard links for clones (an in-place write by the agent would change the original).

Risks: browsers reserve Ctrl+1 to 4 and Cmd+Space in a normal tab, so Ctrl+Alt+1 to 4 and Ctrl+K also work and the README says so. ext4 has no reflinks, so this machine uses git worktrees; the System window says which strategy is active and why.

## Decisions

### Asked
- none

### Defaulted (change any before sw-do)
- D-01 Clone strategy on a file system without reflinks → git worktree (reversible).
- D-02 The `claude` runner gets `--permission-mode acceptEdits` so it can edit files in its workspace without prompts; extra flags come from `SPECOS_CLAUDE_ARGS` (reversible).
- D-03 Layout persistence lives in the browser's `localStorage`, not on the server (reversible).
- D-04 Default port 7300 (reversible).
- D-05 Per-task screenshots are saved under this increment's `reports/artifacts/` (ignored by git); the README screenshot is committed in `docs/`.

### Open
- none

### Verified environment decisions
- D-06 Probe actual Git worktree creation in home. If the environment refuses it and reflinks are unavailable, use independent plain copies and report that strategy. This checkout has that restriction; do not bypass it.

## Tasks

### T-01 Scaffold the project and the shared contract
- AC: AC-01 | Files: package.json, tsconfig.base.json, shared/protocol.ts, server/src/main.ts, server/src/app.ts, server/src/config.ts, client/index.html, client/vite.config.ts, client/src/main.tsx, vitest.config.ts, playwright.config.ts, tests/e2e/helpers.ts, scripts/e2e-server.mjs | Test: npm run typecheck && npm run build

### T-02 Token access for HTTP, tests first
- AC: AC-01 | Files: server/src/auth.ts, server/src/main.ts, tests/server/auth-http.test.ts | Test: npx vitest run tests/server/auth-http.test.ts

### T-03 Token access for WebSocket upgrades, tests first
- AC: AC-02 | Files: server/src/ws.ts, server/src/auth.ts, tests/server/auth-ws.test.ts | Test: npx vitest run tests/server/auth-ws.test.ts

### T-04 Home folder path guard, tests first
- AC: AC-03 | Files: server/src/paths.ts, tests/server/paths.test.ts | Test: npx vitest run tests/server/paths.test.ts

### T-05 File API
- AC: AC-03, AC-04 | Files: server/src/fs-api.ts, tests/server/fs-api.test.ts | Test: npx vitest run tests/server/fs-api.test.ts

### T-06 Watch channel and activity journal
- AC: AC-04, AC-05 | Files: server/src/watch.ts, server/src/activity.ts, tests/server/watch.test.ts | Test: npx vitest run tests/server/watch.test.ts

### T-07 Terminal over node-pty
- AC: AC-06 | Files: server/src/pty.ts, tests/server/pty.test.ts | Test: npx vitest run tests/server/pty.test.ts

### T-08 Workspaces with reflink, worktree and copy strategies, and the clone benchmark
- AC: AC-07, AC-10 | Files: server/src/workspaces.ts, tests/server/workspaces.test.ts | Test: npx vitest run tests/server/workspaces.test.ts

### T-09 Workspace diff and merge back
- AC: AC-08 | Files: server/src/workspaces.ts, server/src/merge.ts, tests/server/merge.test.ts | Test: npx vitest run tests/server/merge.test.ts

### T-10 Agent jobs with claude and demo runners
- AC: AC-09 | Files: server/src/agents.ts, server/src/runners/claude.ts, server/src/runners/demo.ts, tests/server/agents.test.ts | Test: npx vitest run tests/server/agents.test.ts

### T-11 System info and stats tick
- AC: AC-10 | Files: server/src/system.ts, server/src/probe.ts, tests/server/system.test.ts | Test: npx vitest run tests/server/system.test.ts

### T-12 Design system: tokens, type, themes, wallpaper, icons
- AC: AC-11 | Files: client/src/design/, client/src/desktop/Wallpaper.tsx, tests/e2e/design.spec.ts | Test: npx playwright test tests/e2e/design.spec.ts

### T-13 Menu bar and dock
- AC: AC-11, AC-15 | Files: client/src/desktop/MenuBar.tsx, client/src/desktop/Dock.tsx, client/src/lib/api.ts, client/src/lib/events.ts, tests/e2e/shell.spec.ts | Test: npx playwright test tests/e2e/shell.spec.ts

### T-14 Window manager core with spring animations
- AC: AC-12 | Files: client/src/desktop/wm/, tests/e2e/windows.spec.ts | Test: npx playwright test tests/e2e/windows.spec.ts

### T-15 Snap, tiling, four desktops, overview, persistence
- AC: AC-13 | Files: client/src/desktop/wm/, client/src/desktop/Overview.tsx, tests/e2e/layout.spec.ts | Test: npx playwright test tests/e2e/layout.spec.ts

### T-16 Launcher
- AC: AC-14 | Files: client/src/desktop/Launcher.tsx, tests/e2e/launcher.spec.ts | Test: npx playwright test tests/e2e/launcher.spec.ts

### T-17 Files app with quick look
- AC: AC-16 | Files: client/src/apps/files/, client/src/desktop/QuickLook.tsx, tests/e2e/files.spec.ts | Test: npx playwright test tests/e2e/files.spec.ts

### T-18 Terminal app
- AC: AC-17 | Files: client/src/apps/terminal/, tests/e2e/terminal.spec.ts | Test: npx playwright test tests/e2e/terminal.spec.ts

### T-19 Editor app
- AC: AC-17 | Files: client/src/apps/editor/, tests/e2e/editor.spec.ts | Test: npx playwright test tests/e2e/editor.spec.ts

### T-20 Chat app
- AC: AC-18 | Files: client/src/apps/chat/, tests/e2e/chat.spec.ts | Test: npx playwright test tests/e2e/chat.spec.ts

### T-21 Agents app, agent windows and dock icons
- AC: AC-19, AC-16 | Files: client/src/apps/agents/, client/src/apps/agent/, tests/e2e/agents.spec.ts | Test: npx playwright test tests/e2e/agents.spec.ts

### T-22 Activity app with diff and merge back
- AC: AC-20 | Files: client/src/apps/activity/, tests/e2e/activity.spec.ts | Test: npx playwright test tests/e2e/activity.spec.ts

### T-23 System app and benchmark
- AC: AC-21, AC-15 | Files: client/src/apps/system/, tests/e2e/system.spec.ts | Test: npx playwright test tests/e2e/system.spec.ts

### T-24 Polish pass over every screen in light and dark
- AC: AC-11, AC-12 | Files: client/src/ | Test: npx playwright test tests/e2e/polish.spec.ts

### T-25 End-to-end scenario and README
- AC: AC-22, AC-23 | Files: tests/e2e/scenario.spec.ts, README.md, docs/screenshot.png | Test: npx playwright test tests/e2e/scenario.spec.ts

### T-26 Verify and close 0001
- AC: AC-22 | Files: .specweave/increments/0001-specos-browser-desktop-for-ai-agent-work/ | Test: npm run typecheck && npm test && npm run e2e
