# @evcraddock/pi-tmux

A skills-only Pi package for **explicitly requested tmux terminal control**, visible observers, and detached sessions. It is not a sub-agent runner and does not select a delegation mechanism for generic agent requests.

## Contents and requirements

- `skills/tmux/SKILL.md`: routing, exact resource ownership, bounded waits, and cleanup.
- `skills/tmux/ADVANCED.md`: read-only discovery, optional visible observers, and raw terminal recipes.
- Three executable Bash helpers: `start-session.sh`, `wait-for-text.sh`, and `find-sessions.sh`.

Requires an existing `tmux` installation, Bash, and standard Unix utilities (`awk`, `grep`, `sleep`, `mkdir`). No npm runtime dependencies or extension entry point. Integration checks were run on macOS with tmux 3.6a; Linux and older tmux releases are not yet verified. Helpers do not install tools or edit personal tmux configuration.

## Installation (after a separately approved publication)

```bash
pi install npm:@evcraddock/pi-tmux
```

The npm name is selected, not reserved or published by this task. For development, load just the skill for one invocation without modifying Pi settings:

```bash
pi --no-skills --skill ./packages/tmux/skills/tmux
```

Do not load both copies of the `tmux` skill: Pi warns on duplicate names and keeps the first discovered one. If `todu-workflow` remains installed, exclude its tmux skill in the existing package's `skills` filter before enabling this package (for example, `"skills": ["skills/**", "!skills/tmux/**"]`). Preserve its other resources and settings; this is a user-authorized migration, not an automated install step.

## Use

Ask Pi explicitly for tmux, a visible terminal, or a detached terminal session, or invoke `/skill:tmux`. Script paths in the skill are relative to `skills/tmux/`, not your working directory. For example, from that directory:

```bash
./scripts/start-session.sh --session debug-shell --detached
```

Record the returned socket and exact session/window/pane IDs **as data, never with `eval`**. Successful startup transfers cleanup responsibility to the caller; it does not prove any command completed. Capture and clean up only owned resources, including observers, on every later completion/error/timeout path. Read the skill before interacting; a discovered session is not an owned session.

The default socket is `${TMUX_SKILL_SOCKET_DIR:-${TMPDIR:-/tmp}/tmux-skill-sockets}/tmux-skill.sock`. An isolated socket can still be shared by workflows; never use server-wide cleanup. Visible observers require an explicitly selected existing observer socket and pane. Detached sessions do not open a terminal window automatically.

## Development

From the Workbench root:

```bash
npm test --workspace @evcraddock/pi-tmux
npm pack --workspace @evcraddock/pi-tmux --dry-run --json
```

Tests use Node's built-in test runner and require tmux. They create short-lived sessions on unique temporary sockets, retain exact IDs for cleanup, and check that unrelated fixture sessions survive. They never start agents or use personal tmux servers. No dependency installation is necessary. The tarball contains only this README, the manifest, and the five skill files; development tests and repository research are excluded.

## Migration and extension research

Imported from [`evcraddock/todu-workflow`](https://github.com/evcraddock/todu-workflow/tree/1c9ee0c6266af18f6cdcadaf79c414eba665b80e/skills/tmux) at commit `1c9ee0c6266af18f6cdcadaf79c414eba665b80e`; helpers and optional recipes are unchanged. Only the skill's repository-development check instructions were adapted.

Upstream removal is deliberately deferred until distribution and a user-approved migration are ready. This task does not change `todu-workflow`, installed Pi resources, npm, or release automation. Publication needs separate authorization and package-specific release preparation per [Workbench packaging guidance](../../docs/PACKAGES.md) (repository link, not an installed runtime dependency).

See [the extension research](../../docs/TMUX_EXTENSION_RESEARCH.md) in the source repository for the guide assessment, proposed tools/lifecycle, safety constraints, and recommendation. No extension is implemented in this package yet.
