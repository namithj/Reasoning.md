# Commits and recovery

Node 24+ and Git 2.43+ are required. The tested workflow is an ordinary staged local development commit, including an unborn branch, partial staging and linked worktrees. Existing executable hooks, rejection, modified staging, and real process termination before/after commit creation have Linux tests.

## Controlled wrapper

```sh
reasoning reconcile
git add .ai-history/config.json path/to/your-change
reasoning preview --staged --task TASK_ID
reasoning commit -m "Describe the change" --task TASK_ID
reasoning verify HEAD
reasoning show HEAD
```

These are explicit user-run actions. The policy must be staged and match the working configuration. The wrapper stages only its three new record files alongside the user's existing staging. Preview is advisory: commit creates a fresh UUID and event boundary. Standalone snapshot exports and modifications to prior record files must not be staged; preparation rejects them.

For a manual change, `--no-assistant-activity` is an explicit attestation. It is rejected when selected events or any undrained capture delivery remain. Empty capture without the flag stays unavailable. Reconciliation runs before preparation, and late deliveries belong to a later record.

## Native hooks

`reasoning hooks install` explicitly installs repository-local `core.hooksPath` configuration affecting linked worktrees. Ordinary staged `git commit` then prepares the same kind of record, inserts its trailer and verifies the candidate before the reference update. The active task is selected when one was explicitly started. Multiple independent tasks require the wrapper's `--task` selection.

The installer saves the previous setting and delegates existing executable hooks. Record-related hooks run through the recorder; unrelated standard hooks such as `pre-push` pass through with arguments and stdin. Existing scripts are not edited. `reasoning hooks uninstall` restores the saved local setting, and refuses to overwrite a setting changed since installation. Resolve pending transactions in every linked worktree before uninstalling. Hooks reference the installed CLI path, so moving/removing that installation requires reconfiguration.

The wrapper remains usable while native integration is installed. Its own hooks use a command-scoped path and delegate to the saved original directory, preventing recursive recorder invocation. No automatic push occurs. The VS Code staged Commit action needs the separate [real-client capture check](adapters.md#verify-capture); terminal tests are not proof of the editor action.

## Transaction and hook checks

Preparation freezes event IDs, writes an immutable three-file archive, verifies staged bytes against it, and saves a durable transaction with parent, branch, prepared tree and file hashes. Existing hooks execute with their original arguments. After the message hook, the recorder checks that HEAD, index and trailer still match. The reference-transaction prepared hook verifies the candidate commit before the branch update. Git's normal signing configuration remains in effect; interactive signing has not been exercised.

A rejecting or modifying hook stops the attempt. Cleanup removes only exact unchanged recorder-owned files from staging and disk. Code edits from another hook remain for review. Changed generated files retain the transaction for manual recovery; they are never silently deleted. Recursive commit hooks, arbitrary hook-manager internals and newer Git `hook.*` configuration are unsupported; the latter is rejected by preparation to avoid duplicate invocation. [Git hook runner](https://git-scm.com/docs/git-hook), [Git hooks](https://git-scm.com/docs/githooks).

After Git succeeds, the recorder verifies the committed tree and trailer, writes a rebuildable record-to-commit index, and finalizes. Records in HEAD determine which event IDs have already been archived, making boundaries branch-dependent. A new record references earlier records for the same task. Journals are retained.

## Verification and coverage policy

`verify COMMIT` checks exactly one final-paragraph trailer, a new primary record, three regular files, file hashes, the event boundary, retained earlier archives, same-repository references, and the staged-code fingerprint against the committed diff. `show` verifies and renders the primary and referenced records. Both work from a fresh clone without local journal state.

`reasoning policy --mode strict` updates the tracked policy; stage it before committing. Since no adapter is certified complete, strict mode accepts only explicit no-activity attestations or a wrapper override: `--allow-partial "why this reviewed partial record is acceptable"`. The reason is redacted and saved in the manifest and readable record. Native strict commits with partial capture stop; use the wrapper when an override is needed.

`verify-range BASE..HEAD` checks every commit in a two-dot range. `--require-complete` rejects partial/unavailable records; `--allow-overrides` additionally permits an explicit recorded reason. These are structural/policy checks, not proof of trustworthy statements or complete host capture.

## Failure and crash recovery

```sh
reasoning doctor
reasoning recover
```

After a crash, establish that the PID on the lock's recorded host **and its Git child** have stopped before removing only the stale lock at the state path reported by `doctor`. Recovery never steals a live lock. Do not delete the journal or transaction to clear an error.

Recovery searches refs and reflogs for the pending record. A matching valid commit is finalized without creating another code commit. If none exists and HEAD is unchanged, only unchanged recorder-owned files/staging are removed; events remain pending. Moved HEAD, multiple matching commits, edited files and invalid state require review. Retain refs/reflogs while recovery is unresolved.

Calling the wrapper while a transaction is pending performs only recovery. If that clears a failed attempt, review staging and invoke commit again. Queued hook deliveries and a pending capture batch replay separately during `reconcile`. Failed atomic writes can leave UUID `.tmp` files or `.pending-*` export directories; inspect them before removing them. Never delete the journal to clear a queue failure.

## Unsupported operations and ceilings

Amend/reuse-message commits, `-a`, path-limited/temporary-index commits, merges, rebase, cherry-pick, revert, GitHub merge/squash commits and arbitrary IDE clients are outside this alpha's supported capture workflow. Wrapper preparation rejects operation markers/unsupported options; native preparation rejects temporary indexes and amend/reuse messages. **Some Git operations bypass commit hooks altogether. Native installation is not a universal enforcement boundary.** CI must detect unrecorded or structurally incompatible commits. Do not assume a bypassed operation is covered because ordinary staged commits work.

Replay-safe amendment/merge support is remaining implementation work, not a passed gate. Use a disposable pilot and ordinary staged commits while evaluating this candidate. The verifier deliberately rejects merge commits and mutated/reused archive records rather than claiming valid association.

The journal rewrites at most 32 MiB under one worktree lock; manifest scans are linear in the archive. Segmented storage and an index are future upgrades for larger use. Node cannot fsync directories on Windows. Live shared state across machines, network-filesystem locking and split execution are unsupported.
