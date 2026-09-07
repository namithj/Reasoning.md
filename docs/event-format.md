# Import custom events

Use this guide if you are building an exporter or already have conversation data to import. For an assistant's own transcript, start with [explicit imports](adapters.md#explicit-imports).

Reasoning.md accepts UTF-8 JSONL: one JSON event per line. Save this example as `events.jsonl`:

```jsonl
{"schema_version":1,"source":{"tool":"manual","session_id":"session-1","event_id":"message-1","surface":"import","locator":"my-export:1"},"task_id":"task-1","sequence":0,"type":"user_message","content":"Keep the existing API compatible."}
```

From your initialized Git project, run:

```sh
reasoning import --input events.jsonl
reasoning status
```

Import saves pending local history. Follow the [commit guide](controlled-commits.md) to include it in Git.

## Required fields

| Field | Value |
| --- | --- |
| `schema_version` | `1` |
| `source.tool` | `claude-code`, `codex`, `copilot`, `chatgpt`, `manual`, or legacy `copilot-vscode` |
| `source.session_id` | Stable ID for the source conversation |
| `source.event_id` | Stable ID for this event within the conversation |
| `source.surface` | `extension`, `cli`, `desktop` or `import` |
| `source.locator` | Text describing where the event came from; up to 1,024 characters |
| `task_id` | ID of the task this event belongs to |
| `sequence` | Non-negative safe integer; unique within the tool/session |
| `type` | One of the event types below |
| `content` | Text content; serialize structured tool output as a string |

IDs must be 1–160 characters, start with a letter or digit, and contain only letters, digits, `.`, `_`, `:`, `/` or `-`.

## Optional fields

Omitted optional fields default to `null`.

| Field | Value |
| --- | --- |
| `timestamp` | ISO 8601 timestamp with a timezone, such as `2026-09-07T12:00:00Z`; up to 40 characters |
| `model` | Model name; up to 160 characters |
| `tool_call_id` | ID linking a tool result to its call; follows the ID rules above |
| `source.host_version` | Assistant version; up to 160 characters |
| `source.extension_version` | Extension version; up to 160 characters |

Use `null` when the source does not expose a value. Unknown fields and unsupported schema versions reject the entire batch without changing the journal.

## Event types

| Type | Use for |
| --- | --- |
| `user_message` | A visible user prompt |
| `assistant_message` | A visible assistant reply |
| `tool_call` | An exposed tool invocation |
| `tool_result` | An exposed tool result |
| `explicit_decision` | A decision recorded in words |
| `compaction_boundary` | A source compaction marker; label any generated summary clearly |
| `capture_gap` | Known missing or unsupported content |
| `imported_content` | Other accessible conversation text |

Only import content you actually have. Do not invent missing messages or label inferred reasoning as a captured exchange.

## Repeated and late events

Keep the same tool, session ID and source event ID when importing an event again. An unchanged replay is ignored. Identical text with a different source event ID is treated as a separate event.

A replay that changes normalized content, task, sequence, timestamp, model or tool-call ID is rejected without changing the journal. Surface, version and locator changes do not create a new event. Changes that redact to identical normalized content are indistinguishable.

Late events may arrive out of order. Imported records sort by source sequence within each session; there is no guaranteed global timeline across assistants. Keep sequence numbers stable and do not transfer a live session between worktrees.

## Privacy and limits

- Import batches are limited to 5 MiB; blank lines are ignored.
- Common credentials are filtered, and oversized content is shortened to the event limit of 16,384 characters.
- Binary content and environment dumps receive omission markers.
- The journal is limited to 32 MiB per worktree. An import that would exceed it is rejected.

Filtering does not guarantee that confidential information is removed. Review the record before committing or sharing it.

## Saved records

Stored events include additional repository, worktree, environment and redaction metadata. These generated fields are not accepted as custom input fields; use the input format above when writing an exporter.

Each record contains readable text, events and a manifest describing its event boundary, gaps, file hashes and association with staged code. Controlled commit records can reference earlier records for the same task. Standalone exports are snapshots with no commit association.

Assistant capture and imports are currently `partial`. Empty history is `unavailable`. Only an explicit commit-time attestation can produce `no_assistant_activity`; it is never inferred from an empty import. Parser/version metadata and coverage overrides do not certify complete capture.
