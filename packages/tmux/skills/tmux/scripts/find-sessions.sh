#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: find-sessions.sh [-L socket-name|-S socket-path|-A] [-q pattern]

List tmux sessions with exact IDs (default: the skill's private socket).
Discovery is read-only and does not establish resource ownership.

Options:
  -L, --socket       tmux socket name (passed to tmux -L)
  -S, --socket-path  tmux socket path (passed to tmux -S)
  -A, --all          scan all sockets under TMUX_SKILL_SOCKET_DIR
  -q, --query        case-insensitive substring to filter session names
  -h, --help         show this help
USAGE
}

socket_name=""
socket_path=""
query=""
scan_all=false
socket_dir="${TMUX_SKILL_SOCKET_DIR:-${TMPDIR:-/tmp}/tmux-skill-sockets}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -L|--socket|-S|--socket-path|-q|--query)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || { printf 'Missing value for %s\n' "$1" >&2; exit 2; }
      case "$2" in -L|-S|-q|-A|-h) printf 'Missing value for %s\n' "$1" >&2; exit 2 ;; esac
      case "$1" in
        -L|--socket) socket_name="$2" ;;
        -S|--socket-path) socket_path="$2" ;;
        -q|--query) query="$2" ;;
      esac
      shift 2 ;;
    -A|--all)         scan_all=true; shift ;;
    -h|--help)        usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ "$scan_all" == true && ( -n "$socket_name" || -n "$socket_path" ) ]]; then
  echo "Cannot combine --all with -L or -S" >&2
  exit 1
fi

if [[ -n "$socket_name" && -n "$socket_path" ]]; then
  echo "Use either -L or -S, not both" >&2
  exit 1
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found in PATH" >&2
  exit 1
fi

list_sessions() {
  local label="$1"; shift
  local tmux_cmd=(tmux "$@")
  local tab=$'\t'

  if ! sessions="$("${tmux_cmd[@]}" list-sessions -F "#{session_id}${tab}#{session_name}${tab}#{session_attached}${tab}#{session_created_string}" 2>/dev/null)"; then
    echo "No tmux server found on $label" >&2
    return 1
  fi

  if [[ -n "$query" ]]; then
    sessions="$(printf '%s\n' "$sessions" | while IFS=$'\t' read -r id name attached created; do
      if printf '%s\n' "$name" | grep -iF -- "$query" >/dev/null; then
        printf '%s\t%s\t%s\t%s\n' "$id" "$name" "$attached" "$created"
      fi
    done)"
  fi

  if [[ -z "$sessions" ]]; then
    echo "No sessions found on $label"
    return 0
  fi

  echo "Sessions on $label:"
  printf '%s\n' "$sessions" | while IFS=$'\t' read -r id name attached created; do
    attached_label=detached
    if [[ "$attached" =~ ^[0-9]+$ ]] && (( attached > 0 )); then
      attached_label=attached
    fi
    printf '  - %s %s (%s, started %s)\n' "$id" "$name" "$attached_label" "$created"
  done
}

if [[ "$scan_all" == true ]]; then
  if [[ ! -d "$socket_dir" ]]; then
    echo "Socket directory not found: $socket_dir" >&2
    exit 1
  fi

  shopt -s nullglob
  sockets=("$socket_dir"/*)
  shopt -u nullglob

  if [[ "${#sockets[@]}" -eq 0 ]]; then
    echo "No sockets found under $socket_dir" >&2
    exit 1
  fi

  exit_code=0
  found_socket=false
  for sock in "${sockets[@]}"; do
    if [[ ! -S "$sock" ]]; then
      continue
    fi
    found_socket=true
    list_sessions "socket path '$sock'" -S "$sock" || exit_code=$?
  done
  if ! $found_socket; then
    printf 'No sockets found under %s\n' "$socket_dir" >&2
    exit 1
  fi
  exit "$exit_code"
fi

tmux_cmd=(tmux)
socket_label="private socket '$socket_dir/tmux-skill.sock'"

if [[ -n "$socket_name" ]]; then
  tmux_cmd+=(-L "$socket_name")
  socket_label="socket name '$socket_name'"
else
  socket_path="${socket_path:-$socket_dir/tmux-skill.sock}"
  tmux_cmd+=(-S "$socket_path")
  socket_label="socket path '$socket_path'"
fi

list_sessions "$socket_label" "${tmux_cmd[@]:1}"
