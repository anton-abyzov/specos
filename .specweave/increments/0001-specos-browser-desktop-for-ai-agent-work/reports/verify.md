# Verify — 0001-specos-browser-desktop-for-ai-agent-work

PASS · 2026-11-12T08:31:05.513Z · commands from explicit

## Commands

### `cd /home/anton/.specwithcode/ministorm/verify/spec-os && PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never E2E_PORT=7495 specweave-studio checks run -- bash -c "npm run typecheck && npm test && npm run build && npx playwright test tests/e2e/scenario.spec.ts tests/e2e/system.spec.ts"` → exit 0 (35s)

```
client/dist/assets/bricolage-grotesque-vietnamese-wght-normal-BUzh504Q.woff2    8.60 kB
client/dist/assets/jetbrains-mono-greek-wght-normal-Bw9x6K1M.woff2              9.00 kB
client/dist/assets/instrument-sans-latin-ext-wght-normal-B5bTHO_g.woff2        11.14 kB
client/dist/assets/jetbrains-mono-cyrillic-wght-normal-D73BlboJ.woff2          12.10 kB
client/dist/assets/jetbrains-mono-latin-ext-wght-normal-DBQx-q_a.woff2         15.19 kB
client/dist/assets/bricolage-grotesque-latin-ext-wght-normal-CcLUaPy7.woff2    18.66 kB
client/dist/assets/instrument-sans-latin-wght-normal-BbzFLZTg.woff2            30.09 kB
client/dist/assets/jetbrains-mono-latin-wght-normal-B9CIFXIH.woff2             40.40 kB
client/dist/assets/bricolage-grotesque-latin-wght-normal-DLoelf7F.woff2        41.34 kB
client/dist/assets/icons-C2dY9O3n.css                                           0.33 kB │ gzip:   0.22 kB
client/dist/assets/ProjectPicker-CaJvRR62.css                                   2.47 kB │ gzip:   0.84 kB
client/dist/assets/kit-0g88SBAk.css                                             3.82 kB │ gzip:   1.02 kB
client/dist/assets/agent-B5B49FNX.css                                           4.33 kB │ gzip:   1.20 kB
client/dist/assets/Stream-UT4AmG5f.css                                          4.76 kB │ gzip:   1.43 kB
client/dist/assets/terminal-CVfRot1d.css                                        5.92 kB │ gzip:   1.53 kB
client/dist/assets/agents-wtTHvkoz.css                                          6.54 kB │ gzip:   1.69 kB
client/dist/assets/chat-LUgAN3Zj.css                                            8.29 kB │ gzip:   2.06 kB
client/dist/assets/system-7VttEnh3.css                                          9.05 kB │ gzip:   2.19 kB
client/dist/assets/editor-D1Q4CCHY.css                                         10.11 kB │ gzip:   2.51 kB
client/dist/assets/files-dfXGO5Nu.css                                          15.01 kB │ gzip:   3.36 kB
client/dist/assets/activity-uoBw2BWK.css                                       16.22 kB │ gzip:   3.54 kB
client/dist/assets/index-BGIqUe-6.css                                          45.85 kB │ gzip:  11.78 kB
client/dist/assets/dnd-D5V6LCS-.js                                              0.28 kB │ gzip:   0.18 kB │ map:     1.12 kB
client/dist/assets/markdown-DcZrD5kX.js                                         1.24 kB │ gzip:   0.75 kB │ map:     4.42 kB
client/dist/assets/kit-QdLZ6CQN.js                                              2.26 kB │ gzip:   0.93 kB │ map:     7.35 kB
client/dist/assets/api-JT6f0Gx8.js                                              2.80 kB │ gzip:   1.21 kB │ map:    11.90 kB
client/dist/assets/ProjectPicker-BQwjSFf0.js                                    3.42 kB │ gzip:   1.53 kB │ map:    11.51 kB
client/dist/assets/Stream-DT8zUtW8.js                                           5.59 kB │ gzip:   2.28 kB │ map:    20.30 kB
client/dist/assets/agent-CJ845mnN.js                                            6.16 kB │ gzip:   2.35 kB │ map:    18.48 kB
client/dist/assets/agents-B9cE5Ufi.js                                           7.50 kB │ gzip:   2.51 kB │ map:    21.30 kB
client/dist/assets/libesm-CCPUbXkV.js                                           8.27 kB │ gzip:   3.08 kB │ map:    57.72 kB
client/dist/assets/chat-krc5oPH6.js                                            10.24 kB │ gzip:   3.46 kB │ map:    31.18 kB
client/dist/assets/jsx-runtime-BcMwnnmx.js                                     10.85 kB │ gzip:   4.12 kB │ map:    43.82 kB
client/dist/assets/system-XNbemmb6.js                                          12.85 kB │ gzip:   4.05 kB │ map:    35.32 kB
client/dist/assets/icons-BBRMnmAq.js                                           13.61 kB │ gzip:   4.58 kB │ map:    43.48 kB
client/dist/assets/files-Cm5BEPrR.js                                           30.72 kB │ gzip:  10.07 kB │ map:   113.54 kB
client/dist/assets/activity-DEVLdWAn.js                                        37.06 kB │ gzip:  11.85 kB │ map:   131.08 kB
client/dist/assets/marked.esm-CDqJSlOp.js                                      78.15 kB │ gzip:  26.14 kB │ map:   240.04 kB
client/dist/assets/terminal-DKSLUinI.js                                       342.58 kB │ gzip:  87.30 kB │ map:   726.56 kB
client/dist/assets/index-C6ct-2cB.js                                          490.73 kB │ gzip: 160.56 kB │ map: 2,453.90 kB
client/dist/assets/editor-BMEBWjUU.js                                         615.79 kB │ gzip: 216.85 kB │ map: 2,317.92 kB

✓ built in 502ms

Running 2 tests using 1 worker

  ✓  1 tests/e2e/scenario.spec.ts:6:1 › create a project, run two agents from Chat, inspect and merge one (12.5s)
  ✓  2 tests/e2e/system.spec.ts:8:1 › system shows this machine and times ten agent workspaces (9.0s)

  2 passed (24.0s)
```

## Acceptance criteria

23/23 met

| AC | Met | Acceptance | Text |
|---|---|---|---|
| AC-01 | x (tasks) | met | The server binds 0.0.0.0, generates a random token at start and prints one URL containing it. The first visit with the token sets an HttpOnly cookie and redirects to a clean URL. Every HTTP request without a valid cookie or token gets 401. |
| AC-02 | x (tasks) | met | Every WebSocket upgrade without the cookie, or from a foreign Origin, is rejected before a socket opens. |
| AC-03 | x (tasks) | met | Every file API path resolves inside `home/`. `..`, absolute paths, NUL bytes and symlinks that leave the home folder are rejected with 400/403, proven by tests written before the implementation. |
| AC-04 | x (tasks) | met | File API lists, reads, writes, renames, deletes and makes folders, and a WebSocket channel delivers a change event within 500 ms of a change on disk. |
| AC-05 | x (tasks) | met | Every file change is journalled with its author (me, or the agent that owns the workspace) and a text diff. |
| AC-06 | x (tasks) | met | The terminal is a real shell through node-pty over WebSocket, started in the home folder, with resize. |
| AC-07 | x (tasks) | met | "Give this agent its own copy" clones a project into a workspace using reflink copies where the file system supports them, git worktrees otherwise on Linux, and a plain copy elsewhere, and reports strategy, milliseconds and bytes for each clone. |
| AC-08 | x (tasks) | met | A workspace exposes a diff against its base and can be merged back into its project. Conflicts are reported and leave the project untouched. |
| AC-09 | x (tasks) | met | `POST /agents` starts a job in its own workspace. With `claude` on PATH it runs `claude -p "<prompt>" --output-format stream-json` there and streams the events; otherwise a scripted demo agent edits files slowly. Jobs can be stopped and report the files they touched. |
| AC-10 | x (tasks) | met | A system endpoint reports OS, kernel, file system type of the home folder, CPU and memory, and a benchmark creates 10 workspaces and reports each time. |
| AC-11 | x (tasks) | met | The desktop has an original visual identity (own icons, wallpaper, window controls, type and colour) in light and dark themes, with a translucent menu bar and a dock with running indicators and hover magnify. |
| AC-12 | x (tasks) | met | Windows open, move, resize, minimise to the dock, go full screen and close with spring animations. Dragging and resizing run at 60 fps with no jumps or flashes. |
| AC-13 | x (tasks) | met | Windows snap to halves and quarters at screen edges, a tiling toggle arranges all windows, four desktops switch on Ctrl+1 to 4 with a slide, F3 shows an overview, and layout persists across reloads. |
| AC-14 | x (tasks) | met | The launcher opens on Cmd/Ctrl+Space or Cmd/Ctrl+K and fuzzy-searches apps, files, running agents and actions. |
| AC-15 | x (tasks) | met | The menu bar shows the active app's menus, desktops, clock, a live count of running agents, CPU and memory, and a kernel and file system badge that opens the System window. |
| AC-16 | x (tasks) | met | Files has a column view with breadcrumbs, a sidebar of places, quick look on Space for text, images and Markdown, live change animation, and drag of a file onto an agent window to attach it. |
| AC-17 | x (tasks) | met | Terminal runs xterm.js on the PTY, and Editor is a CodeMirror editor with save that reloads when the file changes on disk. |
| AC-18 | x (tasks) | met | Chat is keyboard-first, starts an agent job per message and streams each reply from the first keystroke of Enter. |
| AC-19 | x (tasks) | met | Agents shows one card per job with status, elapsed time, workspace, touched files (click to open) and stop. Each job has its own window with the live stream and its own dock icon. |
| AC-20 | x (tasks) | met | Activity shows a timeline of every file change with its author and a diff view, and merges an agent's workspace back. |
| AC-21 | x (tasks) | met | System shows the machine facts and a one-click test that creates 10 agent workspaces and shows how long it took. |
| AC-22 | x (tasks) | met | End to end: create a project folder with a note in Files, start two agents from Chat that each edit the note in their own workspace, watch both change live, open the diff, merge one back. No console errors. |
| AC-23 | x (tasks) | met | README has a screenshot and the security model in five lines. |

## Tasks (ledger)

| Task | State | By | Evidence | Note |
|---|---|---|---|---|
| T-01 | done | claude@minisforum | npm run typecheck && npm run build → exit 0 log: .specweave… |  |
| T-02 | done | claude@minisforum | npx vitest run tests/server/auth-http.test.ts → exit 0 log:… |  |
| T-03 | done | claude@minisforum | npx vitest run tests/server/auth-ws.test.ts → exit 0 log: .… |  |
| T-04 | done | claude@minisforum | npx vitest run tests/server/paths.test.ts → exit 0 log: .sp… |  |
| T-05 | done | claude@minisforum | npx vitest run tests/server/fs-api.test.ts → exit 0 log: .s… |  |
| T-06 | done | claude@minisforum | npx vitest run tests/server/watch.test.ts → exit 0 log: .sp… |  |
| T-07 | done | claude@minisforum | npx vitest run tests/server/pty.test.ts → exit 0 log: .spec… |  |
| T-08 | done | claude@minisforum | npx vitest run tests/server/workspaces.test.ts → exit 0 log… |  |
| T-09 | done | claude@minisforum | npx vitest run tests/server/merge.test.ts → exit 0 log: .sp… |  |
| T-10 | done | claude@minisforum | npx vitest run tests/server/agents.test.ts → exit 0 log: .s… |  |
| T-11 | done | claude@minisforum | npx vitest run tests/server/system.test.ts → exit 0 log: .s… |  |
| T-12 | done | claude@minisforum | E2E_PORT=7401 PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never npx play… |  |
| T-13 | done | claude@minisforum | E2E_PORT=7401 PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never npx play… |  |
| T-14 | done | claude@minisforum | E2E_PORT=7401 PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never npx play… |  |
| T-15 | done | claude@minisforum | E2E_PORT=7401 PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never npx play… |  |
| T-16 | done | claude@minisforum | E2E_PORT=7401 PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never npx play… |  |
| T-17 | done | claude@minisforum | E2E_PORT=7411 PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never npx play… |  |
| T-18 | done | claude@minisforum | E2E_PORT=7412 PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never npx play… |  |
| T-19 | done | claude@minisforum | E2E_PORT=7412 PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never npx play… |  |
| T-20 | done | claude@minisforum | E2E_PORT=7413 PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never npx play… |  |
| T-21 | done | claude@minisforum | E2E_PORT=7413 PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never npx play… |  |
| T-22 | done | claude@minisforum | E2E_PORT=7414 PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never npx play… |  |
| T-23 | done | claude@minisforum | E2E_PORT=7414 PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never npx play… |  |
| T-24 | done | codex@minisforum | Polish checks passed: 2 tests, /tmp/specos-polish.log; ligh… |  |
| T-25 | done | codex@minisforum | Scenario passed: /tmp/specos-scenario.log; T-25 screenshots… |  |
| T-26 | done | codex@minisforum | Full typecheck, 314 server tests and 63 headless browser te… |  |

26/26 done · 0 skipped · 0 claimed · 0 blocked · 0 stale · 0 open
