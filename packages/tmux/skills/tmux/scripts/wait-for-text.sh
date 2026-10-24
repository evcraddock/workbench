#!/usr/bin/env bash
# Read-only, bounded synchronization with an explicitly selected pane.
set -euo pipefail
error() { printf 'Error: %s\n' "$1" >&2; exit 2; }
usage() {
  printf '%s\n' \
    'Usage: wait-for-text.sh --target %ID --pattern PATTERN [options]' \
    '  -t, --target %ID      Exact pane ID, required' \
    '  -p, --pattern TEXT    Extended regex (or literal with --fixed), required' \
    '  -S, --socket-path P   Private socket (default: $TMUX_SKILL_SOCKET_DIR/tmux-skill.sock)' \
    '  -F, --fixed           Literal pattern' \
    '  -T, --timeout N       1..120 seconds (default: 15); allow an extra clock tick plus polling/capture time' \
    '  -i, --interval N      0.01..1 seconds (default: 0.1)' \
    '  -l, --lines N         Positive history line count (default: 1000)' \
    '  -h, --help            Show help' \
    'Exit 0: text observed (not command success); 124: timeout; 2: invalid input/capture failure.' \
    'Owns no sessions or observers; caller must clean up its resources on every exit path.'
}
target="" pattern="" socket_path="" grep_flag=-E timeout=15 interval=0.1 lines=1000
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--target|-p|--pattern|-S|--socket-path|-T|--timeout|-i|--interval|-l|--lines)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || error "Missing value for $1"
      case "$2" in -t|-p|-S|-T|-i|-l|-F|-h) error "Missing value for $1" ;; esac
      case "$1" in
        -t|--target) target="$2" ;;
        -p|--pattern) pattern="$2" ;;
        -S|--socket-path) socket_path="$2" ;;
        -T|--timeout) timeout="$2" ;;
        -i|--interval) interval="$2" ;;
        -l|--lines) lines="$2" ;;
      esac
      shift 2 ;;
    -F|--fixed) grep_flag=-F; shift ;;
    -h|--help) usage; exit 0 ;;
    *) error "Unknown option: $1" ;;
  esac
done
[[ "$target" =~ ^%[0-9]+$ ]] || error '--target must be an exact pane ID (%N)'
[[ -n "$pattern" ]] || error '--pattern is required'
[[ "$timeout" =~ ^[1-9][0-9]*$ && ${#timeout} -le 3 ]] || error '--timeout must be 1..120 seconds'
(( timeout <= 120 )) || error '--timeout must be 1..120 seconds; respect the active tool timeout'
[[ "$lines" =~ ^[1-9][0-9]*$ && ${#lines} -le 6 ]] || error '--lines must be a positive integer of at most six digits'
[[ "$interval" =~ ^[0-9]*\.?[0-9]+$ ]] || error '--interval must be 0.01..1 seconds'
awk -v value="$interval" 'BEGIN {exit !(value >= 0.01 && value <= 1)}' || error '--interval must be 0.01..1 seconds'
if [[ "$grep_flag" == -E ]]; then
  regex_status=0
  printf '' | grep -E -- "$pattern" >/dev/null 2>&1 || regex_status=$?
  [[ "$regex_status" -ne 2 ]] || error 'Invalid regex pattern'
fi
command -v tmux >/dev/null || error 'tmux not found in PATH'
socket_path="${socket_path:-${TMUX_SKILL_SOCKET_DIR:-${TMPDIR:-/tmp}/tmux-skill-sockets}/tmux-skill.sock}"
trap 'exit 130' INT
trap 'exit 143' TERM
SECONDS=0
# Bash 3.2 may advance its integer SECONDS counter at the next clock tick,
# less than one elapsed second after reset. One extra tick prevents an early
# timeout; reserve this slack plus polling/capture time in the outer tool bound.
timeout_tick=$((timeout + 1))
while true; do
  if ! pane_text=$(tmux -S "$socket_path" capture-pane -p -J -t "$target" -S "-$lines" 2>&1); then
    error "Cannot capture pane $target on $socket_path: $pane_text"
  fi
  if printf '%s\n' "$pane_text" | grep "$grep_flag" -- "$pattern" >/dev/null; then
    exit 0
  fi
  if (( SECONDS >= timeout_tick )); then
    printf 'Timed out after %ss waiting for text in %s. Last capture (diagnostics only):\n%s\n' \
      "$timeout" "$target" "$pane_text" >&2
    exit 124
  fi
  sleep "$interval"
done
