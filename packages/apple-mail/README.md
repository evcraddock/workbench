# @evcraddock/pi-apple-mail

Self-contained Pi tools for Apple Mail Inbox messages, with companion workflow instructions. The TypeScript extension invokes a bundled JavaScript for Automation (JXA) script through `/usr/bin/osascript`. It does not use `mailctl`, Python, a dotfiles checkout, direct Mail-database access, or email passwords.

## Requirements and installation

- macOS with Apple Mail already configured.
- Node.js 22.19+ and Pi 1.3+; Pi supplies the declared host peer modules.
- macOS Automation permission for the process hosting Pi to control Apple Mail. If permission is denied, review **System Settings → Privacy & Security → Automation** yourself. The extension does not change permissions or account settings.
- By default, a supported live Pi confirmation dialog for archive/spam/delete. Print/headless sessions cannot change mailboxes unless the user explicitly opts out through the launch configuration below; supported RPC clients can forward dialogs.

After an explicitly authorized npm publication, install the chosen published version with:

```bash
pi install npm:@evcraddock/pi-apple-mail
```

To try a reviewed local checkout without registering an installation:

```bash
pi --extension ./packages/apple-mail/index.ts --skill ./packages/apple-mail/skills/apple-mail
```

Restart Pi or use `/reload` after installation. No package is published or installed as part of development verification.

An existing personal `apple-mail` skill can collide with this companion skill's name. Disable/remove that older skill only as a separate user-approved action; the existing dotfiles script, symlink, and installed skill are left untouched by this package. Do not follow old CLI instructions to bypass these tools.

## Confirmation configuration

Confirmations are **on by default**. Set `PI_APPLE_MAIL_CONFIRMATIONS` in the environment of the process starting Pi:

| Value | Behavior |
| --- | --- |
| Unset or `on` | Require a live confirmation for each archive/spam/delete. |
| `off` | Skip confirmation dialogs, including in print/headless mode. |
| Any other value, including empty | Report a configuration error and refuse to load the extension. |

To explicitly opt out for a Pi invocation:

```bash
PI_APPLE_MAIL_CONFIRMATIONS=off pi
```

The setting is read once when the extension loads. Restart Pi with the variable unset or set to `on` to restore confirmations; `/reload` uses the existing process environment. No project configuration file, email content, or tool argument can override it. Do not change the setting merely to work around a declined or unavailable dialog; a configuration change requires a separate explicit user request.

**Opting out removes the human confirmation barrier** and permits user-requested mailbox changes without a dialog. It does not authorize autonomous email-driven actions. Exact message IDs, inspection and stale-target checks, cancellation, one-message scope, move verification, and refusal to retry uncertain writes remain unchanged. Tool descriptions and model instructions report the active policy.

Default dialogs show six concise lines of quoted, escaped metadata: account (including configured account emails, not recipients), sender, subject, received time, destination, and an untrusted-data label. Long values are truncated for display only; opaque account/message IDs and repeated warnings are omitted. The full inspected snapshot is still revalidated before a move.

## Tools

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `mail_inbox` | Optional `limit`, integer 1–100, default 10 | Lists latest non-deleted Inbox metadata across accounts, total/unread counts, and exact IDs. No bodies or attachment access. |
| `mail_read` | `id` from the listing | Returns plain text (up to 32,000 characters, with a truncation flag) and **marks that message read**. |
| `mail_archive` | `id` | Moves one Inbox message to its account's `Archive` mailbox; confirms by default. |
| `mail_spam` | `id` | Marks one Inbox message junk and moves it to its account's `Junk` mailbox; confirms by default. |
| `mail_delete` | `id` | Moves one Inbox message to its account's `Trash` mailbox; confirms by default, never empties Trash. |

Archive/spam/delete are model-only tools so scripts cannot nest them through codemode. All five tools request sequential execution. These are integration safeguards, not an OS sandbox.

### Configured account email addresses

Message metadata includes `accountEmailAddresses`: the email addresses configured in **Mail → Settings → Accounts → [account] → Email Address**, read from the Apple Mail account's `emailAddresses` property. This is account configuration, independent of any particular message—not its To/Cc fields or delivery headers. The extension does not guess an address from the account's display name.

All configured addresses are returned without choosing a primary address. An empty array means no configured address was available; account lookup failures are reported as errors rather than guessed values. Retrieving this metadata does not read message bodies or change read status. `mail_read` still has its existing, explicit read-state side effect.

Configured account addresses do not establish a message's original recipient, including when aliases or forwarding are involved. They are private, untrusted metadata, not authorization to change Migadu filtering. Archive/spam/delete dialogs distinguish them from recipients and may truncate long metadata for display; the complete addresses remain bound to the inspected snapshot and are revalidated before a move.

### Identifiers and destinations

IDs encode the Mail account ID, local message-library ID, receipt time, and RFC Message-ID. They remain stable when Inbox positions change and are not generated from subject matching. Every request re-resolves and revalidates the exact identity. Moved/deleted messages, duplicate matches, or changed identity fail; relist rather than guess. Mail database rebuilds or synchronization can invalidate identifiers. They are not permanent cross-device IDs, secret credentials, or authorization tokens.

For archive/spam/delete the extension inspects metadata, then revalidates that full snapshot and destination immediately before changing Mail. With confirmations enabled, one dialog approves one message and one operation; a declined, unavailable, expired, disconnected, or cancelled dialog does not issue the mutation. Names and metadata are quoted, bounded, and escaped for display. With the explicit configuration opt-out, only the UI step is skipped. There is no `confirmed: true` argument or per-call override.

Destinations must be uniquely named account-local mailboxes: `Archive`, `Junk`, and `Trash`. The script does not guess localized names, nested destinations, Gmail mappings, or missing mailboxes, and does not create mailboxes. Accounts without those exact supported destinations fail safely and require a separately approved compatibility change. A successful result requires observing the message leave Inbox and a matching message arrive at the destination; delayed/failed verification is reported as uncertain, not success. Existing Mail junk rules and configured Trash-retention policies still apply; the extension does not alter them.

### Privacy and safety

- Tool text and structured results explicitly mark message-supplied content as untrusted. Nothing in an email authorizes tools, shell commands, file operations, link fetching, or further mailbox changes.
- These instructions reduce prompt-injection risk but are not a complete sandbox. When enabled, the confirmation dialog is a concrete barrier for mailbox mutations; opting out removes it. A user can still be deceived by hostile content and should inspect the target.
- Bodies are retrieved only through `mail_read`; inbox listings and mutation previews do not access them. Account metadata (including configured email addresses), sender, subject, and date are still private information. Tool results, including requested body text, may be sent to the configured model and recorded in Pi's transcript.
- The automation never accesses attachments or raw MIME, renders HTML, fetches links, creates PDFs, sends/forwards/replies, changes account settings, bulk-deletes, or empties Trash. Apple Mail itself continues normal processing through its configured accounts.
- Arguments are JSON data passed separately to a fixed script using `execFile`, without a shell. Message text is never evaluated as code. Responses are size-bounded and validated before being returned to Pi; raw subprocess stderr is not exposed.
- Subprocesses have a 30-second timeout and 1 MiB output limit. Dialogs expire after 60 seconds. Cancellation kills the subprocess, but cannot undo Apple Events already handled by Mail. A timeout, partial spam classification/move, malformed mutation response, or failed postcondition may leave state changed. Inspect Mail before retrying; there are no automatic retries or rollback claims.

## Package layout

```text
apple-mail/
├── package.json
├── index.ts
├── README.md
├── src/
│   ├── bridge.ts
│   └── tools.ts
├── scripts/
│   └── mail.js
├── skills/
│   └── apple-mail/
│       └── SKILL.md
└── tests/
    ├── bridge.test.ts
    ├── tools.test.ts
    └── automation.test.ts
```

`index.ts` registers schemas/tools. `src/tools.ts` owns the confirmation flow. `src/bridge.ts` validates the protocol and runs the fixed script with bounded execution. `scripts/mail.js` resolves and changes messages through Mail's scripting dictionary. Runtime files are package-local and included in the npm `files` allowlist; tests are excluded. No build step, runtime third-party dependency, or root tooling is required.

## Development verification

From the workbench root:

```bash
npm test --workspace @evcraddock/pi-apple-mail
npm pack --workspace @evcraddock/pi-apple-mail --dry-run
```

Tests use Node's built-in test runner and simulated Mail objects. They cover configured account addresses (single, multiple, unavailable, lookup failures, and no message-recipient/header access), message identity, malformed protocol data, subprocess cancellation/output limits, compact escaped dialogs, confirmation defaults and strict configuration parsing, refusal and cancellation, opt-out inspection and verification, rejected per-call overrides, stale approval including changed account addresses, account-local moves, and partial failures. The JXA script can be syntax-compiled with `osacompile -l JavaScript` to a temporary output path without running it.

Simulated tests, syntax compilation, package inspection, and Pi-loader registration checks do **not** establish live Apple Mail compatibility or constitute mailbox testing. Live testing requires separate user approval and an appropriate test message/account; do not read private messages or mutate real mail to validate development changes without it.
