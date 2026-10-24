---
name: tmux
description: Control tmux terminals when the user explicitly requests tmux, a visible terminal session, or a detached terminal session. Do not use for generic sub-agent requests, routine delegation, or ordinary shell commands.
---

# tmux

Use tmux only for an explicitly requested terminal/session capability. A generic request to use a sub-agent does not select this skill or prescribe any delegation mechanism. Report missing tmux honestly; do not install it or introduce another orchestration platform implicitly.

## Ownership first

- Use an isolated socket for workflow-created sessions, normally `${TMUX_SKILL_SOCKET_DIR:-${TMPDIR:-/tmp}/tmux-skill-sockets}/tmux-skill.sock`. Other workflows may share it: an isolated socket is **not** permission to remove every session on it.
- Record each created resource's socket and exact session (`$N`), window (`@N`), or pane (`%N`) ID from tmux's creation output. Discovery does not establish ownership. Do not target resources by guessed names, prefixes, or ambient defaults.
- Record observer resources separately, including their socket: a visible observer may be on another server. A new observer **pane** does not make its pre-existing window/session yours to close.
- After capturing a completed result, promptly remove the created observer and worker resources before waiting for human approval or moving on. Also clean them up on failure, timeout, or interruption. Never close unrelated user resources. Keep an explicitly requested ongoing interactive session only while it is still in use, and report that ownership/lifetime clearly.

## Create and capture

The focused helpers live in `scripts/` relative to this skill:

```bash
./scripts/start-session.sh --session debug-shell --detached
```

Record its `SOCKET`, `SESSION`, `SESSION_ID`, `WINDOW_ID`, and `PANE_ID` output as data—never `eval` it. The helper starts an isolated server without sourcing personal tmux configuration. It does not reuse existing sessions or run a default agent. `--command` accepts an explicitly intended shell command; it is not a safe container for interpolated untrusted text.

Successful creation hands resource ownership to the caller. Creation success says nothing about a command's exit status or task completion. The helper cleans up resources it created if startup fails or is interrupted; after successful startup the caller owns cleanup on **all** later exit paths.

Use the recorded socket and pane ID to inspect or interact:

```bash
tmux -S "$SOCKET" capture-pane -p -J -t "$PANE_ID" -S -200
tmux -S "$SOCKET" send-keys -t "$PANE_ID" -l -- "$text"
```

## Bound waits and clean up

```bash
./scripts/wait-for-text.sh -S "$SOCKET" -t "$PANE_ID" --fixed -p 'ready' -T 15
```

Set a wait below the active tool timeout, leaving time for an extra clock tick, polling/capture, and cleanup. The helper accepts waits of 1–120 seconds, exits 124 on timeout, and reports capture/input errors immediately. Its coarse-clock deadline may add up to one second plus polling/capture time, but must not expire before the requested interval. It owns no sessions and never removes the caller's resources. Text or a synchronization signal is evidence of observation, **not** proof that a command succeeded; verify the actual requested outcome separately. Timeout capture is diagnostic output, not a successful result.

On every completed/failed path, remove any recorded observer first: `kill-window -t "$OBSERVER_WINDOW_ID"` for an owned observer window, or `kill-pane -t "$OBSERVER_PANE_ID"` for an owned pane, using its recorded `OBSERVER_SOCKET`. Then remove the worker using its recorded socket and exact session ID:

```bash
tmux -S "$SOCKET" kill-session -t "$SESSION_ID"
```

Verify only those resources are gone. If cleanup cannot be confirmed, report the exact remaining IDs instead of claiming success or broadening cleanup.

## Optional recipes and checks

Load [ADVANCED.md](ADVANCED.md) only for explicit observer windows/panes, raw terminal operations, or read-only discovery. There is no agent-command wrapper, completion-marker protocol, or default sub-agent profile.

When developing this package in Workbench, run `npm test --workspace @evcraddock/pi-tmux` and `npm pack --workspace @evcraddock/pi-tmux --dry-run --json` from the repository root. Tests require tmux and create only isolated local test sessions with exact-resource cleanup; they do not launch agents or touch personal terminal servers. Tests are not shipped in the installed package.
