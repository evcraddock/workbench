#!/usr/bin/env bash
# Explicit tmux session creation, not an agent runner or completion protocol.
set -euo pipefail
error() { printf 'Error: %s\n' "$1" >&2; exit 1; }
usage() {
  printf '%s\n' \
    'Usage: start-session.sh --session NAME [options]' \
    '  -s, --session NAME       Session name base (a unique suffix is added)' \
    '  -S, --socket-path PATH   Private worker socket (default: $TMUX_SKILL_SOCKET_DIR/tmux-skill.sock)' \
    '  -n, --window-name NAME   Initial window name (default: shell)' \
    '  -c, --command COMMAND    Explicit shell command (default: interactive shell)' \
    '  -d, --detached           No observer (default)' \
    '  -v, --visible            Create an observer in the explicitly selected terminal' \
    '  --observer-socket PATH   Existing observer server socket; required with --visible' \
    '  --observer-target %ID    Existing observer pane; required with --visible' \
    '  --display-mode MODE     window (default) or pane' \
    '  --split h|v             Split direction for pane mode (default: h)' \
    '  -h, --help              Show help' \
    'Outputs SOCKET, SESSION, SESSION_ID, WINDOW_ID, PANE_ID and any OBSERVER_* IDs.' \
    'Successful sessions are caller-owned. Startup failure/interruption cleans only created resources.'
}
session_base="" socket_path="" window_name=shell command=""
visible=false observer_socket="" observer_target="" display_mode=window split=h
while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--session|-S|--socket-path|-n|--window-name|-c|--command|--observer-socket|--observer-target|--display-mode|--split)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || error "Missing value for $1"
      case "$2" in -s|-S|-n|-c|-d|-v|-h) error "Missing value for $1" ;; esac
      case "$1" in
        -s|--session) session_base="$2" ;;
        -S|--socket-path) socket_path="$2" ;;
        -n|--window-name) window_name="$2" ;;
        -c|--command) command="$2" ;;
        --observer-socket) observer_socket="$2" ;;
        --observer-target) observer_target="$2" ;;
        --display-mode) display_mode="$2" ;;
        --split) split="$2" ;;
      esac
      shift 2 ;;
    -v|--visible) visible=true; shift ;;
    -d|--detached) visible=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) error "Unknown option: $1" ;;
  esac
done
[[ "$session_base" =~ ^[a-zA-Z0-9_-]+$ ]] || error '--session must contain only letters/digits/_-'
[[ "$window_name" =~ ^[a-zA-Z0-9_-]+$ ]] || error '--window-name must contain only letters/digits/_-'
[[ "$display_mode" == window || "$display_mode" == pane ]] || error '--display-mode must be window or pane'
[[ "$split" == h || "$split" == v ]] || error '--split must be h or v'
if $visible; then
  [[ -n "$observer_socket" && "$observer_target" =~ ^%[0-9]+$ ]] ||
    error '--visible requires --observer-socket PATH and --observer-target %ID'
elif [[ -n "$observer_socket" || -n "$observer_target" ]]; then
  error 'Observer options require --visible'
fi
socket_path="${socket_path:-${TMUX_SKILL_SOCKET_DIR:-${TMPDIR:-/tmp}/tmux-skill-sockets}/tmux-skill.sock}"
# An observer may have a different cwd; ownership metadata must use absolute paths.
[[ "$socket_path" == /* ]] || socket_path="$PWD/$socket_path"
if [[ -n "$observer_socket" && "$observer_socket" != /* ]]; then observer_socket="$PWD/$observer_socket"; fi
for value in "$socket_path" "$observer_socket"; do
  case "$value" in *$'\n'*|*$'\t'*) error 'Socket paths must not contain tabs/newlines' ;; esac
done
command -v tmux >/dev/null || error 'tmux not found in PATH'
mkdir -p "$(dirname "$socket_path")"
# IDs are meaningful only together with their socket. Names guard against a server
# restart reusing an ID during startup failure cleanup.
session="$session_base-$RANDOM-$RANDOM"
session_id="" observer_window="" observer_pane="" created=false success=false
creation_stage="" ids=""
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  # A signal can arrive just after command substitution captures creation output
  # but before the following read records IDs. Recover only that returned metadata.
  if [[ "$creation_stage" == worker && -n "$ids" ]]; then
    IFS=$'\t' read -r session_id window_id pane_id <<< "$ids"
    if [[ "$session_id" =~ ^\$[0-9]+$ ]]; then created=true; fi
  elif [[ "$creation_stage" == observer && -n "$ids" ]]; then
    IFS=$'\t' read -r observer_window observer_pane <<< "$ids"
    if [[ ! "$observer_window" =~ ^@[0-9]+$ || ! "$observer_pane" =~ ^%[0-9]+$ ]]; then
      observer_pane=""
    fi
  fi
  if ! $success; then
    if [[ -n "$observer_pane" ]]; then
      if [[ "$display_mode" == window ]]; then
        tmux -S "$observer_socket" kill-window -t "$observer_window" || printf 'Observer cleanup unconfirmed: socket=%s window=%s pane=%s\n' "$observer_socket" "$observer_window" "$observer_pane" >&2
      else
        tmux -S "$observer_socket" kill-pane -t "$observer_pane" || printf 'Observer cleanup unconfirmed: socket=%s pane=%s\n' "$observer_socket" "$observer_pane" >&2
      fi
    fi
    if $created && tmux -S "$socket_path" has-session -t "=$session" 2>/dev/null; then
      tmux -S "$socket_path" kill-session -t "=$session" || printf 'Worker cleanup unconfirmed: socket=%s session=%s name=%s\n' "$socket_path" "$session_id" "$session" >&2
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

args=(new-session -d -s "$session" -n "$window_name" -P -F $'#{session_id}\t#{window_id}\t#{pane_id}')
[[ -z "$command" ]] || args+=("$command")
# Do not source personal tmux configuration when starting an isolated server.
creation_stage=worker
if ! ids=$(tmux -f /dev/null -S "$socket_path" "${args[@]}"); then
  error 'Cannot create tmux session; no existing session was reused'
fi
created=true
IFS=$'\t' read -r session_id window_id pane_id <<< "$ids"
[[ "$session_id" =~ ^\$[0-9]+$ && "$window_id" =~ ^@[0-9]+$ && "$pane_id" =~ ^%[0-9]+$ ]] ||
  error 'tmux did not return exact session/window/pane IDs'
creation_stage=""
printf 'SOCKET=%s\nSESSION=%s\nSESSION_ID=%s\nWINDOW_ID=%s\nPANE_ID=%s\n' \
  "$socket_path" "$session" "$session_id" "$window_id" "$pane_id"

if $visible; then
  observer_session=$(tmux -S "$observer_socket" display-message -p -t "$observer_target" '#{session_id}') ||
    error 'Cannot resolve observer target'
  actual_pane=$(tmux -S "$observer_socket" display-message -p -t "$observer_target" '#{pane_id}') ||
    error 'Cannot resolve observer pane'
  [[ "$actual_pane" == "$observer_target" ]] || error 'Observer target is not the exact selected pane'
  printf -v attach 'exec env -u TMUX tmux -S %q attach-session -t %q' "$socket_path" "$session_id"
  format=$'#{window_id}\t#{pane_id}'
  creation_stage=observer
  ids=""
  if [[ "$display_mode" == window ]]; then
    ids=$(tmux -S "$observer_socket" new-window -d -t "$observer_session:" -n "$session" -P -F "$format" "$attach") ||
      error 'Cannot create observer window'
  else
    ids=$(tmux -S "$observer_socket" split-window -d "-$split" -t "$observer_target" -P -F "$format" "$attach") ||
      error 'Cannot create observer pane'
  fi
  IFS=$'\t' read -r observer_window observer_pane <<< "$ids"
  [[ "$observer_window" =~ ^@[0-9]+$ && "$observer_pane" =~ ^%[0-9]+$ ]] || error 'Invalid observer IDs from tmux'
  creation_stage=""
  printf 'OBSERVER_SOCKET=%s\nOBSERVER_KIND=%s\nOBSERVER_WINDOW_ID=%s\nOBSERVER_PANE_ID=%s\n' \
    "$observer_socket" "$display_mode" "$observer_window" "$observer_pane"
  actual_pane=$(tmux -S "$observer_socket" display-message -p -t "$observer_pane" '#{pane_id}') ||
    error 'Cannot verify created observer'
  [[ "$actual_pane" == "$observer_pane" ]] || error 'Created observer no longer exists'
  if [[ "$display_mode" == window ]]; then
    tmux -S "$observer_socket" select-window -t "$observer_window" || error 'Cannot select observer window'
  else
    tmux -S "$observer_socket" select-pane -t "$observer_pane" || error 'Cannot select observer pane'
  fi
fi
success=true
