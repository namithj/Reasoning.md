# Connect your assistant

An adapter connects Reasoning.md to the conversation data your assistant exposes. Capture is experimental and may be incomplete; check a real exchange before relying on it.

Run setup commands in your project's Git directory, in the same environment as your assistant. Initialize the project first if needed:

```sh
reasoning init --publication private
```

Use `--publication public` for records intended for public sharing. Neither setting changes GitHub visibility or encrypts your records.

## Claude Code or Codex

On Linux or macOS, choose the commands for your assistant.

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

Keep Reasoning.md installed at a persistent location: generated hook commands contain absolute paths. Reconfigure the adapter if the Node or CLI installation moves. Existing unrelated hook commands and settings are preserved.

## Other assistants and platforms

| Assistant | Adapter name | Current scope |
| --- | --- | --- |
| Claude Code | `claude-code` | Visible messages and exposed tool activity |
| Codex | `codex` | Visible rollout messages and exposed tool activity |
| Copilot CLI | `copilot-cli` | Supported session-event v1 files and hook fields |
| Copilot cloud | `copilot-cloud` | Same format; persistence must be arranged in the remote environment |
| Copilot in VS Code | `copilot-vscode` | Hook fields only; no full-transcript parser |
| Codex desktop | `codex-desktop` | Explicit rollout-file import |
| ChatGPT | `chatgpt-export` | Explicit import of one exported conversation branch |

Use `reasoning adapter enable ADAPTER_NAME` for another hook-based adapter. Live assistant-panel compatibility remains unverified. Test one adapter at a time: some assistants load overlapping hook settings, which can cause duplicate or misattributed capture.

**Windows:** automatic assistant-hook configuration is currently unavailable. Use explicit imports below.

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

Replace `HOST` with your adapter name. Compare the saved prompt, reply and tool activity with what you actually saw. Run reconciliation again to check that the exchange is not duplicated.

`doctor` reports configuration and gaps. Neither it nor the capture check certifies complete conversation capture. To check commit inclusion too, follow the [commit guide](controlled-commits.md) and run `reasoning verify HEAD`.

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
