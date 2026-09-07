# Reasoning.md

The npm package is `@namithj/reasoning.md`; the command is `reasoning`.

Save accessible development conversations alongside the Git commits they explain. Records contain readable text, structured events, source references and a fingerprint of the staged code. No cloud service, model call or external dependency is required.

**0.1.0-alpha.3 · MIT · experimental.** Includes host capture, durable reconciliation, controlled commits, opt-in native Git hooks, decision capture, cited task handoffs and a reusable CI verifier. Real extension-panel and Source Control compatibility remain unverified. Copilot VS Code currently captures exposed hook fields only; its full-transcript parser is unavailable. See [adapter scope and limitations](docs/adapters.md).

## Install

Requires **Node.js 24+** and **Git 2.43+**. From a checkout of [namithj/Reasoning.md](https://github.com/namithj/Reasoning.md):

```sh
npm run build
node dist/cli.js --help
npm install --global .
```

Or install the supplied compiled package with `npm install --global ./namithj-reasoning.md-0.1.0-alpha.3.tgz`. The build erases TypeScript types using Node; it does not perform static type checking.

Once the preview is published to npm, install it with `npm install --global @namithj/reasoning.md@next`.

## First repository

Use a disposable repository for your first [capture check](docs/adapters.md#verify-capture). Run these commands yourself from the project whose conversation you intend to save:

```sh
reasoning init --publication private
reasoning task start "Fix the greeting"
reasoning adapter enable claude-code
reasoning skill install --host claude-code
reasoning doctor
```

Select your actual host; see [adapter configuration and scope](docs/adapters.md). Task creation is optional: otherwise each unbound source session gets its own task. Explicitly bind sessions when several assistants work on one task. A configured adapter is not a verified adapter.

After working in the assistant, stage the intended changes and inspect the record:

```sh
reasoning reconcile
git add .ai-history/config.json path/to/your-change
reasoning preview --staged --task TASK_ID
reasoning commit -m "Fix the greeting" --task TASK_ID
reasoning verify HEAD
reasoning show HEAD
```

`reasoning commit` creates a commit only when invoked. It preserves partial staging and appends `Reasoning-Record: <uuid>` to the message. The commit includes:

```text
.ai-history/records/<uuid>/reasoning.txt
.ai-history/records/<uuid>/events.jsonl
.ai-history/records/<uuid>/manifest.json
```

New events are exported once per reachable archive; later records reference earlier context. `export --staged` produces a separate untracked snapshot, which must not be staged as a controlled commit record. No command pushes or publishes.

To test ordinary staged `git commit`, explicitly install native integration with `reasoning hooks install`. It changes local `core.hooksPath` for the repository and linked worktrees, delegates existing executable hooks, and can be removed with `reasoning hooks uninstall`. **Use the [supported Git workflow](docs/controlled-commits.md); amend, merges, replay operations and temporary-index commits are outside this alpha's support.** A real IDE Commit action still needs its own test.

## Retrieve the discussion

```sh
reasoning decision "Keep the old API because existing callers depend on it" --task TASK_ID
reasoning search "old API"
reasoning context --task TASK_ID --limit 12000
reasoning explain --file path/to/your-change
reasoning show HEAD
```

Context packets quote saved evidence and cite event/record IDs. They do not invent conclusions or execute historical instructions. Tracked history works on a fresh clone without the original assistant account. Pending local conversations do not travel with a clone.

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
