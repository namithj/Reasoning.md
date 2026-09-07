# Save conversations with commits

Use `reasoning commit` to save a conversation record alongside your staged code changes. You need Node.js 24+, Git 2.43+ and an [initialized project with capture or imported history](adapters.md).

## Make a commit

Stage your intended changes and include the configuration on the first commit:

```sh
reasoning reconcile
git add .ai-history/config.json path/to/changed-file
reasoning preview --staged
```

Replace the file path with your own. Review the preview for private information and missing exchanges, then commit:

```sh
reasoning commit -m "Describe your change"
reasoning verify HEAD
reasoning show HEAD
```

Reasoning.md adds its record files to your staged changes, preserves unstaged edits and runs existing Git hooks. It does not push anything. If you change the Reasoning.md configuration later, stage that change before committing too.

If more than one task is present, use `reasoning task list` to find the right ID and add `--task TASK_ID` to both preview and commit.

For work done without an assistant, you can explicitly attest to that:

```sh
reasoning commit -m "Update the copyright year" --no-assistant-activity
```

The command rejects this flag if relevant pending events or queued capture deliveries remain. An empty history alone does not establish that no assistant was used.

## Read and verify a record

```sh
reasoning show HEAD
reasoning verify HEAD
```

Replace `HEAD` with another commit to inspect older work. These commands work from a fresh clone without the original assistant account.

Records live under `.ai-history/records/`. Each contains readable `reasoning.txt`, structured `events.jsonl` and verification metadata in `manifest.json`. Keep this directory tracked. Later records reference earlier context instead of copying every exchange again.

Verification checks the record's integrity and association with the committed changes. It does not prove that every message was captured or that statements in the conversation are true.

Do not edit previously committed record files or stage standalone `reasoning export` snapshots as commit records. Use `reasoning commit` to create a new record.

## Optional: use ordinary Git commits

To attach records when you run an ordinary staged `git commit`, install native hooks:

```sh
reasoning hooks install
```

This changes the repository's local `core.hooksPath`, including linked worktrees, and delegates to your existing executable hooks. It does not edit those original scripts. The `reasoning commit` command remains available.

Editor Commit buttons need their own test; terminal success does not establish editor compatibility. Use the wrapper when you need to select a task explicitly or supply a coverage override.

To remove the integration:

```sh
reasoning hooks uninstall
```

Resolve pending transactions in every linked worktree first. Uninstall restores the saved setting and refuses to overwrite a different hook configuration. Reinstall if you move the Node or CLI installation.

## Verification and coverage policy

Start with the default `warn` policy. All assistant capture is currently `partial`; missing capture is `unavailable`.

For stricter enforcement:

```sh
reasoning policy --mode strict
git add .ai-history/config.json
```

Strict mode blocks partial or unavailable records unless you explicitly accept the limitation:

```sh
reasoning commit -m "Describe your change" --allow-partial "Reviewed the captured discussion and its gaps"
```

The reason is saved with the record. Native Git commits cannot supply this override; use `reasoning commit`. Explicit no-assistant-activity attestations are also accepted when their checks pass.

For team checks, verify all commits after `BASE` through `HEAD`:

```sh
reasoning verify-range BASE..HEAD
```

Add `--require-complete` to reject incomplete capture. Add `--allow-overrides` alongside it if your team accepts recorded coverage exceptions. No current adapter produces complete capture.

## Failure and crash recovery

Start with:

```sh
reasoning doctor
reasoning recover
```

If the commit already succeeded, recovery finalizes its record without creating another commit. If the attempt failed and the branch is unchanged, it cleans up unchanged recorder-owned files and keeps the events pending. Review your staging before committing again.

A rejecting hook stops the commit. Changes made by hooks or users are kept for review. If files were edited, the branch moved or recovery cannot identify a single valid commit, resolve the reported conflict before retrying.

If a stale lock blocks recovery, confirm that the recorded process **and its Git child** have stopped on the recorded host. Only then remove the stale lock at the state path reported by `doctor` and retry. Do not delete the journal or transaction to clear an error. Preserve refs and reflogs until recovery is resolved.

Run `reasoning reconcile` separately for queued capture deliveries. Pending history is local, so back it up before deleting a checkout or replacing a container.

## Current limitations

Use ordinary staged development commits while evaluating this preview. The following workflows are outside its supported commit flow:

- Amend or reuse-message commits, `git commit -a`, and path-limited commits.
- Merge, rebase, cherry-pick, revert, and GitHub merge or squash commits.
- Recursive commit hooks, unsupported hook managers and newer Git `hook.*` configuration.
- Shared live state across machines or network-filesystem locking.

Some Git operations bypass hooks entirely. Installing native hooks does not make those operations covered; use CI checks to detect unrecorded commits. Interactive commit signing remains unverified.

The local journal is limited to 32 MiB per worktree. There is no automatic pruning, and very large archives require increasing scan time.
