# tmux skill migration and Pi extension research

Task: `task-a01593e5`. Decision: ship a skills-only package now; recommend a narrowly scoped extension as separate work. No extension, npm publication, release workflow, installed-resource change, or upstream deletion is included here.

## Sources and evidence boundary

1. [crystl: tmux for AI agents](https://crystl.dev/guides/tmux-for-ai-agents/) — the requested reference, read in full. Useful terminal patterns and an explicit explanation of screen-scraping limits; its product comparisons and Claude Code flags are the author's claims, not features verified for Pi.
2. [tmux 3.6a manual](https://github.com/tmux/tmux/blob/3.6a/tmux.1) — primary reference for sockets, target IDs, creation output, literal keys, capture, and control mode. Local checks used tmux 3.6a on macOS; no compatibility claim for older versions or Linux follows from that.
3. Pi **1.4.0 installed documentation**: `docs/extensions.md`, `docs/skills.md`, `docs/packages.md`, `docs/tui.md`, `docs/cli.md`, and `docs/rpc-extension-ui.md`, plus `dist/core/extensions/types.d.ts` and `dist/core/exec.d.ts`. Public upstream entry points: [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), [skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md), [packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md), and [types](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts). Upstream `main` can change; recheck contracts against the supported Pi version before implementation.
4. Pi's checked extension examples: [`interactive-shell.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/interactive-shell.ts), [`todo.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/todo.ts), and [`permission-gate.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/permission-gate.ts). These demonstrate integration patterns, not production tmux ownership enforcement.
5. [Original tmux skill and helpers](https://github.com/evcraddock/todu-workflow/tree/1c9ee0c6266af18f6cdcadaf79c414eba665b80e/skills/tmux). The earlier helper tests at commit `7e7b955` were also inspected; they were later removed from the source repository. This package uses Node's existing built-in runner rather than introducing pytest.

## What is migrated

`packages/tmux/` is the independent `@evcraddock/pi-tmux` package, version `0.1.0`, with `pi.skills: ["./skills"]` and no `pi.extensions`. The five runtime files are the skill, optional recipes, and three executable helpers. They contain no imports from other packages or upstream checkouts. README and manifest are also in the npm artifact. Research and development tests are repository-only.

`ADVANCED.md`, `start-session.sh`, and `find-sessions.sh` are unchanged from the source commit. The skill's final development paragraph now names checks that exist in Workbench instead of the removed upstream pytest file and upstream pre-PR script. Independent review found an inherited Bash 3.2 bug: resetting integer `SECONDS` can leave a fractional tick, making waits expire before the requested duration. `wait-for-text.sh` now allows one extra clock tick before timeout, with lower-bound and delayed-readiness regression tests. The skill documents reserving that slack (up to one second plus polling/capture) inside the outer tool deadline; other helper behavior is unchanged.

Retained behavior:

- Explicit terminal/session intent only, not implicit delegation or agent orchestration.
- Private worker socket by default; creation without personal tmux configuration, never attach-or-create reuse.
- Socket-qualified exact creation IDs for workers and observers; discovery grants no ownership.
- Visible observer in an explicitly selected existing tmux pane/server; not an automatic OS terminal launcher.
- Bounded text waits (1–120 seconds), timeout diagnostics, and separate command/outcome verification.
- Prompt observer-first cleanup of owned resources after success, failure, interruption, or timeout. Successful helper startup transfers later cleanup responsibility to the caller.

## Applying the requested guide

| Guide idea | Decision for Pi |
| --- | --- |
| Detached terminals survive disconnects | Keep: appropriate for explicitly requested terminal persistence. A detached process is not reboot persistence or durable transcript storage. |
| Named sessions per repo and `new-session -A` | Names can label resources, but do **not** use attach-or-create for automation ownership. Existing sessions stay unowned unless the user selects/authorizes them. Keep exact socket+ID handles. |
| Windows, panes, and visible layouts | Keep as optional terminal controls; do not create multiple agents, worktrees, or tiled dashboards automatically. |
| `send-keys -l`, separate Enter, joined `capture-pane -J` | Keep literal text separate from control keys. Argument arrays avoid shell quoting errors but do not eliminate tmux's own command parsing (notably semicolon separators). Test hostile literal input before exposing an input tool. |
| A short sleep before submitting text | Not a completion contract. Prefer a bounded, explicit readiness observation where possible; do not bake an arbitrary delay into success claims. |
| Global `.tmux.conf` changes and huge history buffers | Do not edit user configuration or impose history limits. Any future options should be limited to explicitly owned resources with bounded capture sizes. |
| Screen-scraped agent activity / `monitor-silence` | Observation only, never proof of idle, approval-needed, completion, or success. Silence can mean computation or a stalled process. |
| `pipe-pane`, status scripts, SSH | Defer. Logging can capture secrets and needs a retention policy; shell hooks and remote sessions add execution/security surface beyond the requested migration. |
| Product-specific agent state and approvals | Not provided by tmux. Do not claim a wrapper discovers another agent's tool outcomes or safely answers its prompts. |

For future subscriptions, tmux **control mode** (`-C`) provides command result blocks (`%begin`/`%end`/`%error`) and terminal notifications. It could reduce polling, but it adds a persistent subprocess, framing, cancellation, and backpressure work. Its events still do not describe agent task success. Start with short, bounded CLI calls; evaluate control mode only if real latency/volume warrants it.

## Is an extension worthwhile?

Yes, if repeated terminal operations need enforced contracts rather than instructions alone. The skill already covers occasional expert use. An extension's concrete value would be validated parameters, ownership handles, bounded output, structured errors, and reliable cleanup across tool failures/reloads. It would not turn a terminal into an agent protocol or sandbox.

Alternatives:

- **Keep only the skill:** smallest operational surface, reusable scripts, no host API compatibility burden. Ownership and cleanup still depend on caller discipline. This is the delivered migration.
- **Wrap helpers in an extension:** reuse startup logic; parse `KEY=value` as data. Fastest prototype, but a killed Bash wrapper can leave a tmux resource, and schema validation cannot cure shell-command injection or stale IDs. Requires cancellation/failure tests before release.
- **Typed tmux adapter in an extension (recommended next):** invoke fixed tmux subcommands with argument arrays, record ownership immediately, use bounded subprocesses and a centralized cleanup registry. More code than a wrapper, but enforcement is in one place. Keep the skill as companion instructions rather than duplicating policy in separate packages.
- **Agent orchestration / RPC:** separate problem. If future work needs Pi-agent messages and tool outcomes, investigate Pi's JSON/RPC/SDK interfaces instead of parsing terminal screens. Not selected or implemented here.

## Proposed extension contract (not implemented)

Keep the current package and add `index.ts` through `pi.extensions` only in an approved follow-up. Declare Pi-provided `@earendil-works/pi-coding-agent` and `typebox` as `"*"` peer dependencies if actually used; no new build step or tmux library is necessary. Resolve any bundled helper relative to the module, never from the user's cwd.

Candidate direct tools, with names subject to API design review:

| Operation | Inputs and output | Constraints |
| --- | --- | --- |
| `tmux_start` | Valid label, explicit cwd, detached mode by default; optional explicitly intended command. Returns opaque resource handle and socket/session/window/pane metadata. | No default agent; no automatic worktree or package installation. A command string is executable shell input, not data. Prefer a validated executable+argv API if feasible. |
| `tmux_capture` | Owned/explicitly selected pane handle, bounded history lines and bytes. Returns captured text, truncation flag, and observation metadata. | No arbitrary ambient target or unlimited scrollback. Terminal output is untrusted and may contain secrets/control sequences. Sanitize rendering. |
| `tmux_send_text` | Authorized pane handle and literal text. | No implicit Enter. Newlines/control bytes can execute commands even in literal mode; require explicit semantics/authorization, not a misleading “safe text” promise. Test tmux metacharacters or use a tested buffer-based transport. |
| `tmux_send_key` | Authorized handle plus allowlisted key (e.g. Enter or C-c). | Separate from text; never auto-answer another agent's approval or enter secrets. |
| `tmux_wait_text` | Handle, literal pattern by default, timeout below outer tool deadline. | Cancellation-aware and bounded output; distinguish observed, timed out, capture failed, and cancelled. Observation is not exit status. Regex support can wait until bounded matching is designed. |
| `tmux_close` | Owned handle. | Observer-first exact-resource cleanup, idempotent, verified. Unowned/discovered targets fail closed. Report remaining socket+IDs on partial failure. |

Read-only discovery could be a user command, `/tmux`, with an explicit socket selector. Keep “discovered” separate from “owned”; any later interaction with existing user resources needs explicit selection/authorization and must never transfer ownership of the surrounding window/session. Visible observers should initially remain a user-triggered capability requiring an observer socket and pane, not an implicit side effect of start.

Use `pi.registerTool()` with TypeBox schemas and structured `details`; declare an `outputSchema` and matching `structuredContent` for programmatic callers. Throw/mark failed results explicitly; returning an error string is not success. Use sequential execution for state-mutating operations (or per-resource locking); sibling tool calls can otherwise race start/send/close. Read-only operations also need coordination with close.

`pi.exec(command, args, { cwd, signal, timeout })` supports cancellation and millisecond deadlines, but is a short-lived command interface, not a terminal/PTY API. Its result (`stdout`, `stderr`, `code`, `killed`) must be checked. A custom `spawn` adapter may be needed for strict byte limits and streamed output. Neither a tmux CLI exit code nor a text marker proves that the process in the pane completed successfully.

### Lifecycle, state, and mode handling

- Do not spawn processes or start watchers in the extension factory: Pi may load it for non-session invocations. Initialize registry state in `session_start` or on explicit use; create tmux resources only when requested.
- Use `try/finally` for startup and operation failure, plus idempotent `session_shutdown` cleanup for shutdown, reload, and session replacement. Do not blanket-close ongoing sessions at `agent_end`: that is one low-level run boundary, not final idle or terminal lifetime.
- Keep resource lifetime explicit: ordinary task terminals close after result capture; an explicitly ongoing interactive terminal may remain until closed or shutdown. Report its handle and lifetime. Persisting past Pi shutdown would require a separately approved transfer-of-ownership design, not a silent leak.
- Store metadata in `details` or `pi.appendEntry()` as appropriate, but **never** rebuild destructive cleanup authority just from historical/branched entries. Unlike todos, tmux resources are external mutable processes and are not rewound by session-tree navigation. Resumed/forked histories must revalidate liveness and owner identity before any mutation.
- Record server identity as well as exact IDs and a per-resource ownership token; `$0`/`%0` can be reused after a server restart. A recreated socket path is not proof of the original server. If ownership cannot be established, report rather than delete. Fail closed on concurrent close/restart/ID-reuse uncertainty.
- Keep terminal tools usable without custom UI. Use `ctx.ui.notify()`/`setStatus()` for optional feedback. `ctx.hasUI` includes RPC clients; only `ctx.mode === "tui"` permits terminal attachment/custom TUI components. For confirmations, fail closed when a required dialog cannot be shown.
- `interactive-shell.ts` demonstrates stopping/restarting Pi's TUI around inherited-stdio subprocesses; a future attach command must restore the TUI in `finally`. It is not an approval to launch terminals automatically. A simple external observer avoids embedding another terminal renderer in Pi.
- Pi lifecycle events describe the **current Pi instance**, not a different program inside a pane. `agent_settled` is appropriate for that instance's notification-only final-idle signal, not tmux command or remote-agent success.
- `SIGKILL`, machine failure, and a stuck tmux server can defeat shutdown hooks. State this limit, preserve diagnostics for manual recovery, and never compensate with `kill-server` or enumerate-and-delete cleanup.

## Follow-up implementation acceptance gates

1. Unit tests with an injected executor: schemas, exact target/socket validation, owned versus discovered resources, metacharacter/newline handling, bounded captures, explicit tool failures, concurrent close/send, and cancellation during creation.
2. Local tmux integration tests on private temporary sockets: worker and observer IDs, unrelated session/pane survival, timeout and interruption at every startup stage, observer-first cleanup, repeated close, stale handles after server restart, and cleanup failure diagnostics. No live agents or personal tmux servers.
3. Pi mode/lifecycle checks: TUI, print/JSON, RPC, reload, switch/fork/tree navigation, abort, shutdown, missing tmux, unsupported versions, and no-UI required confirmations.
4. Validate the isolated package tarball and companion skill paths. Do not add CI, dependencies, or release automation without approval. Review the implementation separately; this research is not evidence those gates have passed.

## Migration completion and deferred work

The Workbench package is self-contained. Independent npm publication is not performed, and the chosen name is not reserved (an unauthenticated registry read returned 404 during research). Before publication, recheck availability and follow the repository's separate publication approval rules.

Before enabling it in an existing Pi installation, exclude upstream `skills/tmux/**` while preserving the other `todu-workflow` skills; Pi keeps the first discovered duplicate skill name. Filter changes and installation require a separate user request. After distribution and user migration are ready, remove the upstream skill/helpers and stale references in a coordinated `todu-workflow` PR, including its required plugin version decision/checks. That removal was explicitly deferred in the confirmed task plan.

There is no tmux CI workflow in this repository; existing Apple Mail/Migadu workflows are path-scoped release checks, not tmux verification. This PR supplies local checks and tarball evidence; obtain the delivery decision for local-check fallback before treating the CI gate as satisfied.
