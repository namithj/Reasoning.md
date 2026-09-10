# Reasoning.md

Reasoning.md exists to preserve the context behind code changes. When you build software with an AI assistant, the questions, tradeoffs and decisions often stay in a chat while only the code reaches Git. This project saves the visible conversation and your decision notes alongside the commits they explain, helping you review changes, revisit earlier choices and hand work to another developer or assistant without reconstructing the discussion from scratch.

The npm package is `@namithj/reasoning.md`; the command is `reasoning`.

Save accessible development conversations alongside the Git commits they explain. Records contain readable text, structured events, source references and a fingerprint of the staged code. No cloud service, model call or external dependency is required.

**0.1.0-alpha.5 · MIT · experimental.** Includes host capture, durable reconciliation, controlled commits, opt-in native Git hooks, decision capture, cited task handoffs and a reusable CI verifier. Live VS Code panel capture has been verified in a Linux remote environment for Claude Code 2.1.267 (prompt, reply, tool call and tool result) and Codex 26.903.61454 (prompt and reply); both records remain partial. Source Control compatibility remains unverified. Copilot VS Code imports and reconciles v1 session-event transcripts, including full exposed replies and tool activity. See [adapter scope and limitations](docs/adapters.md) and the [implementation and acceptance status](docs/implementation-status.md).

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

Use this route for the changes in this checkout; the published npm preview may contain an earlier implementation.

If the npm preview is unavailable or you want to build from source, download or clone [namithj/Reasoning.md](https://github.com/namithj/Reasoning.md). Open a terminal in the checkout directory containing `package.json`, then run:

```sh
npm run build
npm install --global .
reasoning --version
```

If you already have a compiled package, you can install it directly with `npm install --global ./namithj-reasoning.md-0.1.0-alpha.5.tgz`.

## How to Use

Run setup once from your Git project or a workspace parent:

```sh
reasoning setup --host codex --publication private
```

Replace `codex` with `claude-code`, `copilot-vscode` or `copilot-cli`. On Windows, automatic setup currently supports `claude-code` and `copilot-cli`; use explicit imports for the other hosts. Use `--publication public` only when the saved conversation is intended for public sharing. If a workspace contains several repositories, add `--repo PATH`.

Setup initializes the repository, selects a persistent project task, configures the assistant adapter and companion skill, and installs native Git hooks. It does not stage, commit or push anything. Run it once for each checkout and execution environment because generated hooks use local absolute paths. A repeat run repairs Reasoning.md owned hooks and preserves repository policy, the active task, session bindings, unrelated hooks and customized companion skills.

After setup, open or resume a supported assistant session in the project. Session startup and later assistant hooks automatically capture visible conversation and reconcile known transcripts. A bare editor folder-open with no assistant session is not a universal host event. In Codex, use `/hooks` to review and trust the exact project hook once; setup cannot bypass that trust decision.


Use the normal Git routine. Include the tracked configuration on the first commit:

```sh
git add .ai-history/config.json path/to/changed-file
git commit -m "Describe your change"
reasoning verify HEAD
```

Later commits only need the files you intended to stage. Native hooks reconcile capture, add the conversation record and trailer, and preserve unrelated staging and executable hooks. Everyone who receives the repository can read committed records, including records made with the private publication policy. That policy describes the intended audience; it is not encryption or Git access control.

Run `reasoning doctor` after a real exchange and commit. It checks current hook files and launchers and provides repair steps. Configuration alone does not prove that an assistant panel or editor Commit button executed the hooks. `reasoning reconcile`, the individual `init`/`adapter`/`skill`/`hooks` commands and `reasoning commit` remain available for recovery and advanced workflows. See [assistant setup](docs/adapters.md) and the [commit guide](docs/controlled-commits.md).

## Retrieve the discussion

Use `reasoning task list` to find the `TASK_ID` used below. Run `reasoning task resume TASK_ID` to make an existing task active for new sessions and decision entries, including on a fresh clone.

```sh
reasoning decision "Keep the old API because existing callers depend on it" --task TASK_ID
reasoning search "old API"
reasoning context --task TASK_ID --limit 12000
reasoning explain --file path/to/your-change
reasoning show HEAD
```

Context packets quote saved evidence and cite event/record IDs. They do not invent conclusions or execute historical instructions. Tracked history works on a fresh clone without the original assistant account. Pending local conversations do not travel with a clone. Search, context and file explanations also inspect records retained in the current branch’s Git history after later archive removals, and cite a commit where the evidence remains readable.

## Available commands

In a terminal, commands show readable summaries, details and suggested next steps. When piped or redirected, they keep their existing JSON or text output for scripts. Choose a format explicitly when needed:

```sh
reasoning doctor --format text
reasoning status --format json
```

`--format json` wraps the text reports from `show`, `preview` and `context` in a `text` field. Help and version output stay plain text; assistant hooks keep their stdout empty.

Run these commands as `reasoning COMMAND` from the initialized repository or its bound workspace. Use `--repo PATH` to select a repository explicitly when discovery is ambiguous. Replace uppercase placeholders with your own values. Use `reasoning --help` for all options or `reasoning --version` to check the installed version.

### Setup and health

| Command | What it does |
| --- | --- |
| `setup --host HOST --publication private\|public [--repo PATH]` | Configure automatic assistant capture and ordinary Git commits in one step. |
| `init --publication private [--repo PATH]` | Advanced: initialize storage without enabling new capture. |
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
| `commit -m "MESSAGE"` | Commit staged changes with their conversation record; add `--amend` to replace the current commit while retaining its earlier archive. |
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
| `task resume ID` | Activate a saved task for new sessions without duplicating its objective or changing existing session bindings. |
| `task list` | List local and archived tasks, their IDs and local session bindings, including on a fresh clone. |
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

The full test suite creates and commits in disposable Git repositories. `check:package` also packs and installs the actual tarball offline, then checks setup, commits, native hooks and fresh-clone retrieval. GitHub Actions defines Linux/macOS/Windows checks and package artifacts. Publishing a GitHub Release triggers npm publication to `next` after Linux tests, build and package checks; it requires npm authentication configured for `.github/workflows/publish.yml`. The release tag must be `v` followed by the matching version in `package.json` and `src/schema.ts`. Windows direct-hook tests cover Claude Code and Copilot CLI. Other Windows capture paths use explicit imports; real host-panel compatibility remains a separate gate.

The software repository ignores `.ai-history/`; the npm package uses an explicit allowlist. In projects recording their own history, keep reviewed records trackable and add `.ai-history export-ignore` to that project's `.gitattributes` if release archives should omit them. This affects `git archive`, not clones.

Further references: [event format](docs/event-format.md), [adapter setup](docs/adapters.md), [license](LICENSE).
