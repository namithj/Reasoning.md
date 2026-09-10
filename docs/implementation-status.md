# Implementation and acceptance status

Checked on 10 September 2026 in a Linux x64 development container using Node 24.20.0 and Git 2.47.3, with live panel checks in a Linux remote VS Code environment. This is the delivery checklist for the conversation-history implementation plan. The CLI workflow is implemented and exercised end to end; the plan's full editor/host release matrix is not yet certified.

## Live VS Code panel evidence

- Claude Code 2.1.267, session `8b1c5d6f-95be-4aab-ba74-5f89def552cb`: the visible prompt, reply, tool call and tool result were captured. Commit `351d810f135ba73e529f1af59168875c1538b11a` contains record `43945593-e158-4724-8a20-97be157e9be0`, verified as `partial`.
- Codex 26.903.61454, session `01a08c5c-b751-74b3-8cc1-346b13b249ac`: the visible prompt and reply were captured; the exchange used no tool. Commit `3a979749314a8bc55f0a41c0fe0ad1f095b616fa` contains record `4d8b14fe-6c44-4f8a-824d-4ffde6679d4d`, verified as `partial`.

An independent review confirmed the stored markers, records and commit trailers. These manual observations apply only to the named extension builds and environment. They do not establish complete capture, Source Control button behavior, Windows compatibility or compatibility with other versions. Generic runtime status fields remain unverified because the product cannot infer this test provenance.

## Delivery phases

| Phase | Implemented and checked | Remaining release gate |
| --- | --- | --- |
| 0: probes | Read-only extension metadata and environment probes, plus visible exchanges in Claude Code 2.1.267 and Codex 26.903.61454 panels in Linux remote VS Code | Copilot Chat is not installed in this environment; other versions and platforms remain unchecked. |
| 1: recorder | Validation, deduplication, redaction, bounded journal, immutable export, staged preview, gaps and ordering | No automatic completeness claim; journal remains bounded to 32 MiB. |
| 2: commits | Wrapper, trailers, fingerprints, recovery, rejecting hooks, partial staging, fresh-clone retrieval | Interactive signing requires its own real-client check. |
| 3: initial adapters | Claude JSONL, Codex rollout and Copilot session-event v1; exposed model identity, delayed-source reconciliation, durable queue and direct executable Claude/Copilot CLI hooks; live Claude Code and Codex panel capture for the builds documented above | Runtime-update and compaction comparisons. Synthetic fixtures establish parser behavior outside the documented live checks only. |
| 4: Git integration | Native staged commits and `-a`; matching amend previews, controlled amend, staged merge and squash; replay preservation; safe revert workflow; worktree isolation | Source Control button checks; Windows/macOS/WSL/SSH and container recreation on real hosts. Path-limited commits and automatic merges have explicit fallback paths. |
| 5: skill and handoff | One-command idempotent setup, persistent default task, skill installation, decisions, search, file lookup, bounded cited context; archived task discovery, task resumption, new-session binding and historical lookup after archive removals | Skill discovery and use in each real assistant. |
| 6: additional hosts | Copilot CLI/cloud v1 and Codex desktop transcript imports; ChatGPT branch export import | Live desktop/cloud/CLI capture and persistence in disposable remote environments. |
| 7: team rollout | CI verifier, coverage overrides, package exclusions, offline tarball install and complete fresh-clone workflow | Human pilot and platform-specific CI executions; no publication or deployment performed by these checks. |

## Runnable acceptance checks

Final result: **97 tests passed, 0 failed, 1 Windows-only test skipped on Linux**. Build, package boundary checks and the offline installed-package workflow passed. These results apply to this source checkout; install from the local build to use these changes before a new release is published.

```sh
npm test
npm run build
npm run check:package
```

The package check builds on the existing build output. It packs and installs the real tarball offline in a temporary prefix, then initializes a disposable repository, executes the installed direct host launcher, imports conversation, records a decision, installs the skill, previews, commits with partial staging, invokes installed native hooks, clones and verifies task resumption, retrieval/context/CI. The installed package path contains spaces. It leaves the development repository's staging and commit history untouched.

| Plan acceptance items | Automated evidence |
| --- | --- |
| 1, 4, 9, 10, 14, 15 | Recorder/adapter tests cover prompt, reply, tools, two sources, every exported representation, unsupported versions, null paths and resumed surfaces. |
| 2, 3, 5 | Commit tests cover rejected hooks, crashes before/after commit creation, unchanged unrelated staging, recovery and linked worktree isolation. |
| 6, 16 | Compaction/gap fixtures, late source flush after the final hook, persistent queues and fresh recorder processes. Real extension restarts/updates remain to be checked. |
| 7 | Fresh-clone tests and the installed-tarball workflow retrieve saved records without the original host or journal. |
| 8 | Root/ordinary amend, staged merge, squash, clean cherry-pick/rebase, retained revert archives and new discussion records. Changed replay fingerprints are not automatically certified. |
| 11 | Hook bypass, malformed trailers, tampering, code fingerprint changes and strict range policy fail verification. |
| 12, 13, 17, 18 | Core and shell Git paths are tested. A workspace parent with one nested worktree is discovered, bound and exercised through generated hooks; ambiguous siblings fail until `--repo` selects one. Real panels, editor Commit actions and other execution topologies remain open gates. |

## Complete the real-host pilot

Use a non-sensitive disposable repository. Install the built package in the same environment as the assistant and Git. For each panel independently:

1. Run `reasoning setup --host HOST --publication private`. Confirm it stages nothing. Reload the assistant as required; in Codex, review and trust the exact project hook once with `/hooks`.
2. Ask a distinctive question and request a harmless file read. After the full reply, run `reasoning reconcile`, `reasoning status` and `reasoning adapter check HOST --session ID --prompt "QUESTION" --reply "REPLY"`. Check actual text and tool results, then reconcile again to check duplicates.
3. Stage a small edit, leave another edit unstaged, preview and create a wrapper commit. Run `reasoning verify HEAD` and compare the saved conversation to the panel.
4. Use the installed native hooks and repeat with the actual VS Code Source Control Commit action. Verify the archive/trailer and that unrelated edits remain unstaged. Record this result separately from the capture result.
5. Repeat after a new chat, assistant switch, extension restart/update and compaction. In remote/container setups, replace the environment while preserving Git metadata and confirm pending capture survives.
6. Clone elsewhere and use `task list`, `context`, `show` and `explain` without the original assistant account. Record the tested extension/runtime/editor/Git/OS versions and the observed limitations before advertising that combination.

`doctor` checks current hook commands, readable launcher locations, Git hook selection and last capture. It never treats installation metadata or synthetic fixtures as a passed live-host gate. Start in warn mode; all observable capture remains partial until a host contract is established. No hidden model reasoning is captured.
