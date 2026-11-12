# SpecOS delivery

Implementation lives in `/home/anton/live/spec-os`. All seven apps, window management, authentication, file APIs, PTY, agent streaming, workspace diff/merge and system benchmark are implemented. The README includes a desktop screenshot, running instructions and a five-line security model.

## Verification scope

The full suite at `d43575d` passed typechecking, 314 server tests and all 63 headless browser tests. One filesystem-dependent reflink test was skipped because the test filesystem does not support reflinks. The drag test measured 61 frames with a 16.7 ms median interval and zero intervals over 34 ms. The full test output is `task-T-26.txt` beside this report.

The later capability-probe change at `06f4e73` was independently reviewed and checked with the workspace/system tests. Final `verify.json` and `verify.md` record a new typecheck, full server suite, build, and the two-agent scenario and System browser tests against that revision in `/home/anton/.specwithcode/ministorm/verify/spec-os`.

Browser tests use scripted demo agents for deterministic live file edits. The real CLI streaming adapter is covered by server tests with a fixture executable. No paid real-model job was needed for final verification.

## Live activation

The production server binds `0.0.0.0:7300`, with home `/home/anton/live/spec-os/home`. The URL format is `http://192.168.40.158:7300/?token=<startup-token>`. The current private URL is in `/home/anton/live/spec-os/.e2e/preview.log`; it is intentionally absent from committed evidence. The detached launch PID is recorded in `/home/anton/live/spec-os/.e2e/preview.pid`. This process survives terminal exit, but is not configured to start after reboot.

Live headless checks passed HTTP authentication, HttpOnly/SameSite cookie attributes, token removal from the address, zero browser errors and the ten-workspace benchmark. The benchmark measured 1.79 seconds total and 179 ms median per copy. See `live-verification.json` and `artifacts/live-benchmark-dark.png` beside this report.

This home is on ext4, without reflinks. The host restricts Git worktree creation beneath this checkout, so the live app uses independent plain copies and explicitly reports that strategy. The restriction is respected. Unrestricted Linux folders use worktrees, and supporting filesystems use reflinks. A copied linked Git worktree now receives separate repository metadata; independent review also confirmed merge-back preserves the original branch.

## Evidence

- `/home/anton/live/spec-os/README.md`
- `/home/anton/live/spec-os/docs/screenshot.png`
- `/home/anton/live/spec-os/docs/screenshot-dark.png`
- `/home/anton/live/spec-os/.specweave/increments/0001-specos-browser-desktop-for-ai-agent-work/reports/task-T-26.txt`
- `/home/anton/live/spec-os/.specweave/increments/0001-specos-browser-desktop-for-ai-agent-work/reports/verify.json`
- `/home/anton/live/spec-os/.specweave/increments/0001-specos-browser-desktop-for-ai-agent-work/reports/review-independent.md`
- `/home/anton/live/spec-os/.specweave/increments/0001-specos-browser-desktop-for-ai-agent-work/reports/artifacts/T-25-two-agents-light.png`
- `/home/anton/live/spec-os/.specweave/increments/0001-specos-browser-desktop-for-ai-agent-work/reports/artifacts/T-25-diff-light.png`
- `/home/anton/live/spec-os/.specweave/increments/0001-specos-browser-desktop-for-ai-agent-work/reports/artifacts/T-25-merged-dark.png`
