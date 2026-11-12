# Independent completion review

Reviewed November 12, 2026 against commit `759ea8c1611dca01b18986126147f2b6400bdc95` plus the current uncommitted polish changes. Scope: authentication, path guarding, workspace creation/merge, agent execution, and significant acceptance gaps. No full test suite was run in this review.

## Finding resolved

**P1: Copying a project that is a Git worktree shares its index and changes its branch.**

Location: `server/src/workspaces.ts:203`, `server/src/workspaces.ts:207`, and `server/src/workspaces.ts:214`.

Both the reflink and copy paths copy the source directory wholesale and then run `git checkout -b` in the destination. If the source project is a linked worktree, `.git` is a file pointing at the source worktree's administrative directory. Copying that pointer does not create an independent checkout. The subsequent branch switch changes the original project's branch, and both folders share the same Git index. This violates workspace isolation and can make later staging and merges operate on the wrong working-tree state.

A targeted reproduction used a disposable server home, initialized `Projects/source`, added a linked worktree at `Projects/imported`, then called `ctx.workspaces.create({project: 'Projects/imported', strategy: 'copy'})`. Output:

```text
before: imported
sourceBranch: agent/b8f1272a
cloneBranch: agent/b8f1272a
```

The server and disposable files were closed and cleaned up. The same pointer copying occurs in the reflink path. Detect linked-worktree metadata before copying; choose a safe worktree strategy on Linux or create independent repository metadata for a normal copy. Add a regression test that the source branch and index do not change and the clone can be independently edited and merged.

## Other observations

HTTP auth is registered before API/static routes; WebSocket upgrades separately validate the cookie and Origin. File reads reject ordinary traversal and out-of-home symlinks, reject nonregular files, and sandbox served content. The shell and agents intentionally run with the server user's privileges, so workspace separation must not be described as an OS security sandbox.

Partial merge while an agent is running is an intentional interaction, with explanatory text and a Merge again action. A targeted check confirmed that it merges the current snapshot and leaves later edits in the workspace. This is not reported as a defect.

The final README, end-to-end scenario, full-suite output, screenshot inspection and increment closure are still owned by the implementing task and were not certified by this review.

## Resolution verification

Commit `d5651085c6b7b38a383f4a0dce4b1666aa93cef6` replaces copied `.git` pointers with independent repository metadata, fetches the base commit and initializes the destination index before creating its agent branch. The added regression covers copy and reflink strategies.

Independently repeated the linked-worktree reproduction after this fix for both strategies, then edited the workspace and merged it through the HTTP API. All assertions passed: destination metadata is a directory, the source branch remains unchanged, workspace edits do not affect source contents before merging, the merge returns HTTP 200 with `merged: true`, the imported project receives the edit, and the original primary worktree remains unchanged. The disposable server and files were cleaned up.

```text
copy PASS: independent metadata, original branch preserved, merge back succeeds, primary worktree unchanged
reflink PASS: independent metadata, original branch preserved, merge back succeeds, primary worktree unchanged
```

No unresolved blocking findings remain from this review. This conclusion covers the reviewed code and targeted verification, not the separate full-suite and deployment acceptance gates.

## Deployment follow-up review

Reviewed the `server/src/probe.ts` follow-up that tests actual worktree creation in the configured home rather than merely checking whether Git is installed. The probe uses a newly created scratch repository, applies the existing server commit configuration, catches unavailable operations and removes its scratch directory in `finally`. It respects the environment restriction by selecting ordinary independent copies instead of circumventing the Git wrapper.

Independently called `detectCloneStrategy('/home/anton/live/spec-os/home')` in a fresh process. Assertions passed for the copy strategy, the reported limitation and removal of all newly created probe directories:

```json
{"strategy":"copy","reflinkSupported":false,"reason":"ext4 has no reflinks and git worktrees are unavailable here, so workspaces are independent plain copies"}
```

The README accurately documents the fallback. No new blocking findings were identified in this follow-up. The live installation therefore provides ordinary copies, with their actual cost reported, rather than claiming reflink/worktree efficiency on this restricted path.
