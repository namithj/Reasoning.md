# Capture adapters

Enable capture in the environment where the assistant, transcript and Git checkout execute. Install the recorder at a persistent path; generated commands use absolute Node and CLI paths. Restart or reload the host as its hook settings require. Commands below are user-run configuration actions in the target repository.

| Adapter | Parser | Generated configuration | Current scope |
| --- | --- | --- | --- |
| `claude-code` | `claude-jsonl-v1` | `.claude/settings.local.json` | Visible text, exposed tools, compaction markers; panel/CLI gates open |
| `codex` | `codex-rollout-v1` | `.codex/hooks.json` | Visible response items and exposed tools; null paths produce gaps |
| `copilot-vscode` | `none` | `.github/hooks/reasoning-vscode.json` | Hook fields only; full replies are unavailable unless the hook itself supplies them |
| `copilot-cli` | `copilot-events-v1` | `.github/hooks/reasoning-cli.json` | Declared session event v1 format and hook fields; live CLI gate open |
| `copilot-cloud` | `copilot-events-v1` | `.github/hooks/reasoning-cloud.json` | Same declared source format; remote persistence and execution gate open |
| `codex-desktop` | `codex-rollout-v1` | None | Explicit source input only; no automatic desktop support claimed |
| `chatgpt-export` | `chatgpt-export-v1` | None | Explicit import of one selected conversation branch |

```sh
reasoning adapter enable codex --surface extension --host-version VERSION --extension-version VERSION
reasoning adapter list
reasoning doctor
```

Versions supplied here are declared metadata, not an allowlist or compatibility certification. Unknown parser names fail. `--parser none` disables transcript parsing while keeping exposed hook fields. Windows automatic host configuration is deliberately unavailable; `--surface import` installs no hooks and works independently of that gate. All hosts remain partial until an independently verified scope and boundary contract exists.

The installer preserves existing JSON and unrelated hook commands, and replaces only its own exact prior command. Copilot CLI/cloud use their documented PascalCase compatibility events with snake_case input. Hook stdout remains empty because it is reserved for the host's control schema. Capture errors are reported on stderr and hook invocations return success so recorder failures do not veto assistant tools; strict enforcement occurs at commit preparation.

**Overlapping settings are a compatibility gate.** Copilot may also load Claude settings and other `.github/hooks/*.json` files. A command configured under one adapter name is declared provenance, not proof of the executing host. Test hosts in separate disposable repositories first. Do not certify combined installation until you have excluded duplicate or misattributed deliveries in the actual host versions. Configure machine-specific files locally; review before tracking absolute executable paths.

## Verify capture

Start in a disposable repository. Ask the selected assistant panel a recognizable question and have it read a harmless file using a tool. After its reply, run `reasoning reconcile` and `reasoning status` to find the source session ID, then compare the visible exchange with:

```sh
reasoning adapter check HOST --session SESSION_ID --prompt "recognizable question" --reply "recognizable reply"
```

Check the full prompt, reply and tool call/result, then repeat reconciliation to check deduplication. Resume the session and check again. The CLI always reports panel verification as unverified because supplied fixtures could produce the same events; compare with the actual panel yourself. Missing replies and transcript gaps must remain visible.

Verify commit inclusion separately: stage the intended change and policy, use the controlled wrapper, and run `reasoning verify HEAD`. If testing native integration, repeat with the editor's ordinary staged Commit action. See [supported commits](controlled-commits.md) before enabling native hooks.

## Source handling

Hooks spool only recognized, sanitized fields before taking the recorder lock. Busy locks leave durable queue items. `reasoning reconcile` drains the queue and rereads known sources; controlled and native commit preparation invoke reconciliation. A crash between journal and adapter-state updates replays a durable normalized batch with stable IDs. Failed deliveries remain queued for inspection instead of disappearing. Queued counts and source gaps appear in records and health reports.

Claude transcript UUIDs and tool IDs identify messages; its source must match the session and worktree. Codex rollouts require matching `session_meta` and use row offsets for messages. Copilot event sources require a matching `session.start` with schema version 1 and working directory, and use source event/tool IDs. Other schema versions fail visibly. The SDK schema provides the Copilot parser contract; it does **not** establish that a given VS Code transcript uses it.

Only text and exposed tool content are imported. Reasoning/thinking fields are skipped. Unknown message content becomes a gap or fails the parser. A failed source parse still preserves available hook fields and an explicit gap. Incomplete trailing JSONL receives one bounded flush retry, then waits for later reconciliation.

Late source text can match a provisional hook event one-for-one; repeated identical messages remain distinct when their IDs differ. No-ID retries are inherently ambiguous and are marked. Capture-arrival sequence is retained when late content is appended; locators preserve source positions. Source files must be append-only for offset identity. Truncated/reordered/revised sources are a known ceiling: existing IDs retain their original event and report a gap; they are not silently reinterpreted as a new session. Use a reviewed normalized import with a distinct source identity for a repaired export.

## Explicit imports

```sh
reasoning import --input normalized-events.jsonl
reasoning import --host chatgpt-export --session CONVERSATION_ID --input /absolute/path/conversations.json
reasoning import --host codex-desktop --session SESSION_ID --input /absolute/path/rollout.jsonl
```

First-time host import configures its parser locally with surface `import` and installs no automatic hooks. Importing a source for an already enabled adapter preserves that adapter configuration. ChatGPT import follows `current_node` through the selected branch, rejects cycles and skips hidden/nontext content. It is not automatic ChatGPT desktop capture.

## WSL, SSH, containers and cloud

Install/configure beside the runtime and checkout: inside WSL for WSL processes, on the SSH server for remote processes, and inside the container for container processes. A local VS Code window does not prove local execution. `doctor` reports observed environment flags and opaque environment identity; supplied transcript `cwd` must resolve to the same worktree. Split execution without shared accessible state is unsupported; no network bridge is installed.

Keep Git metadata on persistent storage when pending conversation must survive container replacement. In ephemeral cloud jobs, initialize and configure after the recorder is available at its final path, then reconcile and include reviewed records in an authorized commit before teardown. The recorder does not upload logs or create remote commits automatically. Copying a local hook command containing a workstation path into a cloud checkout will not work.

Source references: [Claude hooks](https://code.claude.com/docs/en/hooks), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [VS Code agent hooks](https://code.visualstudio.com/docs/agent-customization/hooks), [Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference), [Copilot SDK event schema](https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/session-events.ts). These documents establish implementation inputs, not passed host tests.
