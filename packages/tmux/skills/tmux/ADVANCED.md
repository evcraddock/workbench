# tmux — Optional Terminal Recipes

Load only for explicitly requested tmux/terminal work. These are terminal-control recipes, not a sub-agent or task lifecycle. Use the ownership and cleanup rules in [SKILL.md](SKILL.md).

## Read-only discovery

```bash
./scripts/find-sessions.sh                    # skill's private socket
./scripts/find-sessions.sh -S "$SOCKET"       # explicitly selected socket
./scripts/find-sessions.sh --all              # skill socket directory only
./scripts/find-sessions.sh -S "$SOCKET" -q debug
```

Queries are literal, case-insensitive session-name substrings. Output includes exact session IDs; it does not grant ownership or authorize stopping anything. An explicit `-L NAME` selects a named socket instead of the private default.

For a user-selected existing server, inspect its sessions/windows/panes without guessing a target:

```bash
tmux -S "$OBSERVER_SOCKET" list-panes -a \
  -F '#{session_id} #{window_id} #{pane_id} #{pane_title}'
```

## Visible observer

First establish which existing terminal pane should host the observer. Supply its exact pane ID and socket explicitly; the helper never guesses them from the current terminal or modifies a default/personal server implicitly.

```bash
./scripts/start-session.sh --session debug-shell --visible \
  --observer-socket "$OBSERVER_SOCKET" --observer-target "$EXISTING_PANE_ID" \
  --display-mode window
```

For a split observer, use `--display-mode pane --split h` (left/right) or `--split v` (top/bottom). Record all returned `OBSERVER_*` fields along with worker metadata. The helper selects the created window/pane; the original host pane remains unrelated and must survive cleanup. Startup failures/interruption clean up only newly created resources.

After successful startup, the caller must clean observers and worker sessions on later completion, error, interruption, or timeout. Kill only the created observer **pane** in split mode, not its pre-existing window. Kill only the created observer **window** in window mode, not its existing host session. Do this promptly after collecting results, before any human approval gate. Then kill the owned worker session. There is no server-wide or enumerate-and-delete cleanup recipe; a shared automation socket does not make other workflows' sessions disposable.

## Raw windows and panes

Creation output is the ownership record. For example, inside an already authorized target session/window:

```bash
WINDOW_ID=$(tmux -S "$SOCKET" new-window -d -t "$SESSION_ID:" \
  -n debug -P -F '#{window_id}')
PANE_ID=$(tmux -S "$SOCKET" split-window -d -h -t "$EXISTING_PANE_ID" \
  -P -F '#{pane_id}')
```

Record IDs immediately and arrange exact-resource cleanup before subsequent operations. Creating a pane inside an existing window does not transfer ownership of the window or session. Use IDs together with their recorded socket, not `:0.0`, a name prefix, or whichever terminal happens to be active.

## Input and output

```bash
# Literal text; press Enter separately only when intended.
tmux -S "$SOCKET" send-keys -t "$PANE_ID" -l -- "$text"
tmux -S "$SOCKET" send-keys -t "$PANE_ID" Enter
# Control keys for an authorized interactive terminal.
tmux -S "$SOCKET" send-keys -t "$PANE_ID" C-c
# Joined wrapped lines from a selected pane.
tmux -S "$SOCKET" capture-pane -p -J -t "$PANE_ID" -S -200
```

For Python REPLs, use `PYTHON_BASIC_REPL=1` when needed to avoid enhanced REPL control sequences. For debugging, use the project's available debugger (`lldb` or `gdb`), not a hardcoded default agent.

## Synchronization

Prefer the bounded read-only helper for a specific prompt:

```bash
./scripts/wait-for-text.sh -S "$SOCKET" -t "$PANE_ID" -p '^>>>' -T 15 -l 4000
```

Raw `tmux wait-for` signals are not command exit statuses and provide no timeout by themselves. Use them only with a separate tool-driven bound and known ownership/cleanup; never wait beyond the active tool timeout. Do not instruct an agent to emit markers or signal completion as a substitute for command/task verification.
