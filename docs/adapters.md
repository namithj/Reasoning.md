# Connect your assistant

An adapter connects Reasoning.md to the conversation data your assistant exposes. Capture is experimental and may be incomplete; check a real exchange before relying on it.

Run setup commands in your project's Git directory or its workspace parent, in the same environment as your assistant. Initialize the project first if needed:

```sh
reasoning init --publication private
```

Use `--publication public` for records intended for public sharing. Neither setting changes GitHub visibility or encrypts your records.

If the workspace contains one nested Git worktree, `init` finds the nearest worktree and stores the parent/worktree binding in local Git state. If several worktrees are found at the same depth, no files are changed; rerun with `--repo PATH`. Re-running `init` updates already-enabled adapter hooks to use the stored binding without enabling new adapters.

## Claude Code or Codex

Choose the commands for your assistant. Claude Code supports direct executable setup on Linux, macOS and Windows. Codex shell-hook setup currently supports Linux and macOS.

**Claude Code:**

```sh
reasoning adapter enable claude-code
reasoning skill install --host claude-code
```

**Codex:**

```sh
reasoning adapter enable codex
reasoning skill install --host codex
```

The adapter configures capture. The optional skill gives your assistant instructions for finding and using saved history. Reload your assistant as required by its hook settings, then inspect the setup:

```sh
reasoning doctor
reasoning adapter list
```

Keep Reasoning.md installed at a persistent location: generated hook commands contain absolute paths. They also pass the selected repository explicitly, so a hook launched from a workspace parent writes to the correct worktree. Reconfigure the adapter if the Node, CLI or repository location moves. Existing unrelated hook commands and settings are preserved. Hosts such as Codex may require reviewing the hook again when its generated command changes.

## Other assistants and platforms

| Assistant | Adapter name | Current scope |
| --- | --- | --- |
| Claude Code | `claude-code` | Visible messages and exposed tool activity |
| Codex | `codex` | Visible rollout messages and exposed tool activity |
| Copilot CLI | `copilot-cli` | Supported session-event v1 files and hook fields |
| Copilot cloud | `copilot-cloud` | Same format; persistence must be arranged in the remote environment |
| Copilot in VS Code | `copilot-vscode` | v1 session-event transcripts, visible replies, tool requests/results and hook fields |
| Codex desktop | `codex-desktop` | Explicit rollout-file import |
| ChatGPT | `chatgpt-export` | Explicit import of one exported conversation branch |

Use `reasoning adapter enable ADAPTER_NAME` for another hook-based adapter. Live assistant-panel compatibility remains unverified. Test one adapter at a time: some assistants load overlapping hook settings, which can cause duplicate or misattributed capture.

**Windows:** automatic configuration is implemented for Claude Code and Copilot CLI using Node’s executable and a literal argument array. Codex, Copilot VS Code and cloud adapters still require explicit imports on Windows. Real Windows panel/runtime compatibility remains unverified here; the generated direct launchers are exercised by tests that also run in Windows CI.

**Containers, SSH and WSL:** install and configure Reasoning.md where the assistant and Git checkout actually run. A local editor window does not establish that location. Keep Git metadata on persistent storage so pending conversations survive environment replacement. There is no bridge for capture split across machines.

## Verify capture

1. Ask your assistant a recognizable question and have it read a harmless file with a tool.
2. After its reply, run:

   ```sh
   reasoning reconcile
   reasoning status
   ```

3. Copy the session ID from `status` and check the exchange:

   ```sh
   reasoning adapter check HOST --session SESSION_ID --prompt "your question" --reply "its reply"
   ```

Replace `HOST` with your adapter name. Compare the saved prompt, reply and tool activity with what you actually saw. The command exits with status 1 when any of those four elements is missing. Run reconciliation again to check that the exchange is not duplicated.

`doctor` checks the recorded workspace and repository roots, whether the generated hook commands are still present at the workspace configuration path, whether the recorded Node/CLI paths remain readable, and whether Git still uses the installed hook directory. It also reports the most recent capture separately from live-panel verification. Neither it nor the capture check certifies complete conversation capture. To check commit inclusion too, follow the [commit guide](controlled-commits.md) and run `reasoning verify HEAD`.

## Explicit imports

Use these commands when you have an accessible transcript or export. Replace the paths and IDs with your own:

```sh
reasoning import --host codex-desktop --session SESSION_ID --input /path/to/rollout.jsonl
reasoning import --host chatgpt-export --session CONVERSATION_ID --input /path/to/conversations.json
```

First-time imports configure the selected parser without installing assistant hooks. Existing adapter settings are preserved. Codex and Copilot transcripts must identify the same session and project; ChatGPT imports follow the selected conversation's current branch.

For your own exporter, use the [event format](event-format.md):

```sh
reasoning import --input events.jsonl
```

## Missing or delayed messages

Run `reasoning reconcile`, then inspect `reasoning doctor`. Reconciliation retries queued deliveries and reads known transcript files again. If the source is still writing, wait for it to finish and retry.

Only visible text and exposed tool content are captured. Hidden thinking is omitted. Unsupported formats, missing transcript paths and incomplete source files produce errors or gaps. A failed transcript read can still leave useful hook fields in the record.

Keep source transcripts intact. Editing, truncating or reordering them can invalidate event identities. All current capture is marked `partial`; an empty history is `unavailable`. Review records for private information before sharing them.

## Copilot transcript contract

`copilot-events-v1` is shared by the VS Code, CLI and cloud adapters. The VS Code mapping was checked against Microsoft's [session transcript interfaces](https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/platform/chat/common/sessionTranscriptService.ts) and [producer](https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/extension/chat/vscode-node/sessionTranscriptService.ts). These source checks and synthetic fixtures do not establish that an installed panel fires hooks.

VS Code can omit `context.cwd`. For its recognized producer, this creates a gap identifying the validated hook/import as the repository association. An explicitly different source working directory or session is rejected. A v2 session header is rejected. Historical replay can expose tool requests without results; unavailable results are never invented. `reasoning adapter check` will fail its result check if none were saved. Thinking fields are omitted.

Copilot CLI and cloud use their documented PascalCase compatibility format in generated hooks, with snake_case payloads. Exposed `text_result_for_llm` is captured as result text. See the [Copilot hook contracts](https://docs.github.com/en/copilot/reference/hooks-reference).

If an enabled VS Code adapter was previously configured with parser `none`, rerun `reasoning adapter enable copilot-vscode` to select the v1 parser. Run `reasoning reconcile` after updating. Missing or incomplete initial transcript files remain registered for later reconciliation, including after restarting the recorder. Old gap entries remain as historical evidence of the earlier failure.

## Direct executable hooks and upgrades

Claude Code uses its documented [`command` plus `args` form](https://code.claude.com/docs/en/hooks#exec-form-and-shell-form). Copilot CLI uses [`exec` plus `args`](https://docs.github.com/en/copilot/reference/hooks-reference#command-hooks). Both launch the actual Node executable and compiled recorder script without a shell, so paths with spaces or shell metacharacters are passed literally. These formats require host versions that support direct execution; installation does not certify older runtime compatibility.

Run `reasoning adapter enable HOST` again to upgrade an existing generated hook. The installer removes its previous command from mixed hook groups while retaining unrelated commands, including other Node invocations. `doctor` compares the actual argument array as well as the executable, so another Node hook cannot masquerade as recorder installation.

Transcript capture records model identity when the source exposes it, including Codex turn-context model changes. Missing model metadata stays null and is never inferred from the adapter name.
