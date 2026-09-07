# Normalized event contract v1

`reasoning import` without `--host` accepts UTF-8 JSONL: one event object per line. Blank lines are ignored. This is the recorder's own interchange format, not any host's transcript format. A caller must already have legitimately accessible conversation content; the recorder never reconstructs hidden or missing messages.

```json
{
  "schema_version": 1,
  "source": {
    "tool": "codex",
    "session_id": "session-123",
    "event_id": "source-event-4",
    "surface": "extension",
    "host_version": null,
    "extension_version": null,
    "locator": "session-export:4"
  },
  "task_id": "task-123",
  "sequence": 3,
  "timestamp": "2026-09-07T12:00:03Z",
  "type": "tool_result",
  "content": "1 test passed.",
  "tool_call_id": "call-1",
  "model": null
}
```

Required fields: `schema_version`, `source`, `task_id`, `sequence`, `type`, and `content`. Within `source`, `tool`, `session_id`, `event_id`, `surface`, and `locator` are required. `timestamp`, model/version fields and `tool_call_id` default to null. Identifiers are 1–160 characters, starting with a letter or digit and using letters, digits, `.`, `_`, `:`, `/` or `-`. Content is a string; explicitly serialize structured tool payloads as text. Unknown fields and schema versions fail the entire batch. Error messages do not echo malformed source content.

`source.tool` is `claude-code`, `codex`, `copilot`, `chatgpt`, legacy `copilot-vscode`, or `manual`; it describes the source, not a promise of an enabled native adapter. `surface` is `extension`, `cli`, `desktop` or `import`. Use null for unavailable runtime, extension and model versions. `tool_call_id` links a result to its call when exposed by the source.

Event types:

- `user_message`
- `assistant_message`
- `tool_call`
- `tool_result`
- `explicit_decision`
- `compaction_boundary`
- `capture_gap`
- `imported_content`

Assign a stable source event ID and sequence from the source. Never generate a new ID every time an event is replayed. Repeated messages with different source IDs remain distinct events. Sequences are non-negative safe integers, unique within a tool/session and monotonically ordered in exported records. Late events can be imported out of order and fill gaps. A compaction summary should be labelled as such inside a `compaction_boundary`; it does not replace missing messages.

The recorder derives its stable event ID from the tool, source session ID and source event ID. It ignores surface/version/locator changes when deduplicating a resumed session. A replay with different normalized content, task, sequence, timestamp, model or tool-call ID fails without modifying the journal. Changes that redact to identical normalized content are intentionally indistinguishable. Session event identity is deduplicated within a worktree; cross-worktree session transfer is not supported yet.

Stored events add repository, worktree and environment identities and a redaction report. Machine identifiers are opaque hashes; no environment dump is included. Exports group sessions in first-observed order and sort by source sequence within each session. This does not imply a global chronology across independently running assistants.

Snapshot manifests contain the selected event boundary, session ranges, observed versions and event types, known gaps, staged paths, staged-code fingerprint, redaction summary and SHA-256 hashes of `reasoning.txt` and `events.jsonl`. The manifest has no containing-commit hash and does not hash itself. Generated record paths are excluded from the code fingerprint. Paths are redacted for display when a credential pattern is detected; the fingerprint still uses the actual Git diff.

All nonempty snapshots are `partial`: explicit imports cannot prove full host capture. An empty journal is `unavailable`, never `no_assistant_activity`. No command emits `complete_for_declared_scope` until a native source and its frozen boundary are verified. Standalone snapshots have no commit association or previous-record references. Controlled commit records set `snapshot: false` and reference earlier records for the same task. Only an explicit `--no-assistant-activity` attestation can produce that status; it is never inferred. The commit message references the record UUID, while the containing commit hash is stored only in the rebuildable local index.


Native adapters normalize into the same contract. `capture_sources` records configured parser versions and declared host metadata; `queued_capture_deliveries` records excluded deliveries. Neither field certifies capture. `capture_override` is null unless the caller supplied an explicit partial-coverage reason during controlled commit preparation. The readable record includes that reason. Hook-derived sequences preserve capture arrival when late transcript records arrive; see [adapter source limits](adapters.md).
