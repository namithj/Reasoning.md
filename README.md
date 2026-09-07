# Reasoning.md

Reasoning.md exists to preserve the context behind code changes. When you build software with an AI assistant, the questions, tradeoffs and decisions often stay in a chat while only the code reaches Git. This project saves the visible conversation and your decision notes alongside the commits they explain, helping you review changes, revisit earlier choices and hand work to another developer or assistant without reconstructing the discussion from scratch.

The npm package is `@namithj/reasoning.md`; the command is `reasoning`.

Save accessible development conversations alongside the Git commits they explain. Records contain readable text, structured events, source references and a fingerprint of the staged code. No cloud service, model call or external dependency is required.

**0.1.0-alpha.3 · MIT · experimental.** Includes host capture, durable reconciliation, controlled commits, opt-in native Git hooks, decision capture, cited task handoffs and a reusable CI verifier. Real extension-panel and Source Control compatibility remain unverified. Copilot VS Code currently captures exposed hook fields only; its full-transcript parser is unavailable. See [adapter scope and limitations](docs/adapters.md).

## Install

Requires **Node.js 24+** and **Git 2.43+**.

### Install from npm

Install the preview release, then check that the command is available:

```sh
npm install --global @namithj/reasoning.md@next
reasoning --version
reasoning --help
```

### Alternative: build locally

If the npm preview is unavailable or you want to build from source, download or clone [namithj/Reasoning.md](https://github.com/namithj/Reasoning.md). Open a terminal in the checkout directory containing `package.json`, then run:

```sh
npm run build
npm install --global .
reasoning --version
```

If you already have a compiled package, you can install it directly with `npm install --global ./namithj-reasoning.md-0.1.0-alpha.3.tgz`.

## How to Use

Open a terminal in your existing Git project and initialize it:

```sh
reasoning init --publication private
```

Use `--publication public` instead for records intended for public sharing. Then choose the setup for your assistant below (Linux or macOS).

### Claude Code

```sh
reasoning adapter enable claude-code
reasoning skill install --host claude-code
```

### Codex

```sh
reasoning adapter enable codex
reasoning skill install --host codex
```

The adapter configures conversation capture; the skill gives your assistant instructions for using saved history. Reload your assistant as required by its hook settings, then check the setup:

```sh
reasoning doctor
```

`doctor` reports configuration and capture gaps; verify a real exchange with the [capture check](docs/adapters.md#verify-capture). On Windows, use [transcript imports](docs/adapters.md#explicit-imports) because automatic adapter setup is currently unavailable.

When you are ready to save a conversation with your changes, follow the [commit guide](docs/controlled-commits.md).

## Retrieve the discussion

Use `reasoning task list` to find the `TASK_ID` used below.

```sh
reasoning decision "Keep the old API because existing callers depend on it" --task TASK_ID
reasoning search "old API"
reasoning context --task TASK_ID --limit 12000
reasoning explain --file path/to/your-change
reasoning show HEAD
```

Context packets quote saved evidence and cite event/record IDs. They do not invent conclusions or execute historical instructions. Tracked history works on a fresh clone without the original assistant account. Pending local conversations do not travel with a clone.

## Available commands

In a terminal, commands show readable summaries, details and suggested next steps. When piped or redirected, they keep their existing JSON or text output for scripts. Choose a format explicitly when needed:

```sh
reasoning doctor --format text
reasoning status --format json
```

`--format json` wraps the text reports from `show`, `preview` and `context` in a `text` field. Help and version output stay plain text; assistant hooks keep their stdout empty.

Run these commands as `reasoning COMMAND` from your project's Git directory. Replace uppercase placeholders with your own values. Use `reasoning --help` for all options or `reasoning --version` to check the installed version.

### Setup and health

| Command | What it does |
| --- | --- |
| `init --publication private` | Initialize the project; use `public` for records intended for public sharing. |
| `doctor` | Report configuration, assistant environment and capture gaps. |
| `status` | Show captured events, sessions, queued deliveries and pending work. |
| `adapter enable HOST` | Configure capture for an assistant. |
| `adapter list` | List available adapters and their local configuration. |
| `adapter check HOST --session ID --prompt "TEXT" --reply "TEXT"` | Check whether a known exchange and tool activity were captured. |
| `skill install --host HOST` | Install instructions that help your assistant use saved history. |
| `probe HOST` | Inspect the environment for assistant integration information. |

### Capture and commits

| Command | What it does |
| --- | --- |
| `import --input FILE` | Import events; add `--host HOST --session ID` for a supported assistant transcript. |
| `capture HOST --input FILE` | Process an assistant hook payload; normally called by configured hooks. |
| `reconcile` | Retry queued capture and read updates from known transcripts. |
| `preview --staged` | Show the conversation record proposed for your staged changes. |
| `commit -m "MESSAGE"` | Commit staged changes with their conversation record. |
| `export --staged` | Write a standalone snapshot without staging or committing it. |
| `verify COMMIT` | Check a record's integrity and association with a commit. |
| `verify-range BASE..HEAD` | Check every commit in a range. |
| `recover` | Recover an interrupted recorder commit. |
| `hooks install` | Attach records to ordinary staged Git commits using local hooks. |
| `hooks uninstall` | Remove native integration and restore the saved hook setting. |
| `policy --mode strict` | Require acceptable capture coverage at commit time; use `warn` for the default policy. |

### Tasks and saved history

| Command | What it does |
| --- | --- |
| `task start "OBJECTIVE"` | Create a task and make it active for new sessions. |
| `task list` | List tasks, their IDs and session bindings. |
| `task bind TOOL SESSION --task ID` | Associate an assistant session with a task. |
| `decision "RATIONALE" --task ID` | Save an explicit decision for the next record. |
| `search "TEXT"` | Search local and committed conversation history. |
| `context --task ID` | Prepare excerpts with source references for a task handoff. |
| `explain --file PATH` | Find conversation records associated with a file. |
| `show COMMIT` | Read a commit's conversation and referenced context. |

`show` and `verify` default to `HEAD`. Add `--task ID` to preview, export or commit when you need to select a task. For capture options and supported commit workflows, see [assistant setup](docs/adapters.md) and the [commit guide](docs/controlled-commits.md).

## Coverage and privacy

All captured/imported conversations remain `partial` in this alpha. Missing conversation is `unavailable`. Only an explicit `--no-assistant-activity` attestation can record that state, and pending events or queued capture prevent it. No adapter currently emits `complete_for_declared_scope`.

Start with warn policy. `reasoning policy --mode strict` blocks partial/unavailable commits unless the wrapper receives `--allow-partial "reviewed reason"`; stage the policy change before committing. CI can accept or reject such overrides independently. See [coverage policy](docs/controlled-commits.md#verification-and-coverage-policy).

Anyone receiving a repository can read its tracked conversation. `--publication public` acknowledges that audience; it does not change repository visibility. Credentials are filtered before journaling and again before export, but arbitrary private information still requires review. Hidden reasoning, binary payloads and environment dumps are omitted. Text is bounded to 16,384 characters per event, input batches to 5 MiB and journals/transcripts to 32 MiB.

The live journal, sanitized delivery queue, locks and recovery state live in Git metadata outside the tracked tree. Storage uses atomic writes, fsync and one lock per worktree. Source transcripts are read only at explicitly supplied paths and are not copied wholesale. Journals are retained; there is no automatic pruning. Back up pending local state before disposing of a container. [Recovery and limits](docs/controlled-commits.md).

## Development and distribution

```sh
npm test
npm run build
npm run check:package
npm pack
```

The full test suite creates and commits in disposable Git repositories. GitHub Actions defines Linux/macOS/Windows checks and package artifacts. Publishing a GitHub Release triggers npm publication to `next` after Linux tests, build and package checks; it requires npm authentication configured for `.github/workflows/publish.yml`. The release tag must be `v` followed by the matching version in `package.json` and `src/schema.ts`. Native Windows host configuration is unavailable; Windows capture tests use explicit imports.

The software repository ignores `.ai-history/`; the npm package uses an explicit allowlist. In projects recording their own history, keep reviewed records trackable and add `.ai-history export-ignore` to that project's `.gitattributes` if release archives should omit them. This affects `git archive`, not clones.

Further references: [event format](docs/event-format.md), [adapter setup](docs/adapters.md), [license](LICENSE).
