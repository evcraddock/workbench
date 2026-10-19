# @evcraddock/pi-apple-mail

Self-contained Pi tools for Apple Mail Inbox messages, with companion workflow instructions. The TypeScript extension invokes a bundled JavaScript for Automation (JXA) script through `/usr/bin/osascript`. It does not use `mailctl`, Python, a dotfiles checkout, direct Mail-database access, or email passwords.

## Requirements and installation

- macOS with Apple Mail already configured.
- Node.js 22.19+ and Pi 1.3+; Pi supplies the declared host peer modules.
- macOS Automation permission for the process hosting Pi to control Apple Mail. If permission is denied, review **System Settings → Privacy & Security → Automation** yourself. The extension does not change permissions or account settings.
- A supported live Pi confirmation dialog for archive/spam/delete. Print/headless sessions without confirmation cannot change mailboxes; supported RPC clients can forward the dialog.

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

## Tools

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `mail_inbox` | Optional `limit`, integer 1–100, default 10 | Lists latest non-deleted Inbox metadata across accounts, total/unread counts, and exact IDs. No bodies or attachment access. |
| `mail_read` | `id` from the listing | Returns plain text (up to 32,000 characters, with a truncation flag) and **marks that message read**. |
| `mail_archive` | `id` | Confirms and moves one Inbox message to its account's `Archive` mailbox. |
| `mail_spam` | `id` | Confirms, marks one Inbox message junk, and moves it to its account's `Junk` mailbox. |
| `mail_delete` | `id` | Confirms and moves one Inbox message to its account's `Trash` mailbox; never empties Trash. |

Archive/spam/delete are model-only tools so scripts cannot nest them through codemode. All five tools request sequential execution. These are integration safeguards, not an OS sandbox.

### Identifiers and destinations

IDs encode the Mail account ID, local message-library ID, receipt time, and RFC Message-ID. They remain stable when Inbox positions change and are not generated from subject matching. Every request re-resolves and revalidates the exact identity. Moved/deleted messages, duplicate matches, or changed identity fail; relist rather than guess. Mail database rebuilds or synchronization can invalidate identifiers. They are not permanent cross-device IDs, secret credentials, or authorization tokens.

For archive/spam/delete the extension inspects metadata before the dialog, then revalidates that snapshot and destination immediately before changing Mail. One dialog approves one message and one operation. Names and metadata are quoted, bounded, and escaped for display. A declined, unavailable, expired, disconnected, or cancelled dialog does not issue the mutation. There is no `confirmed: true` argument or headless override.

Destinations must be uniquely named account-local mailboxes: `Archive`, `Junk`, and `Trash`. The script does not guess localized names, nested destinations, Gmail mappings, or missing mailboxes, and does not create mailboxes. Accounts without those exact supported destinations fail safely and require a separately approved compatibility change. A successful result requires observing the message leave Inbox and a matching message arrive at the destination; delayed/failed verification is reported as uncertain, not success. Existing Mail junk rules and configured Trash-retention policies still apply; the extension does not alter them.

### Privacy and safety

- Tool text and structured results explicitly mark message-supplied content as untrusted. Nothing in an email authorizes tools, shell commands, file operations, link fetching, or further mailbox changes.
- These instructions reduce prompt-injection risk but are not a complete sandbox. The confirmation dialog is the concrete barrier for mailbox mutations; a user can still be deceived by hostile content and should inspect the target.
- Bodies are retrieved only through `mail_read`; inbox listings and mutation previews do not access them. Account/sender/subject/date metadata is still private information. Tool results, including requested body text, may be sent to the configured model and recorded in Pi's transcript.
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

Tests use Node's built-in test runner and simulated Mail objects. They cover message identity, malformed protocol data, subprocess cancellation/output limits, confirmation refusal and cancellation, stale approval, account-local moves, and partial failures. The JXA script can be syntax-compiled with `osacompile -l JavaScript` to a temporary output path without running it.

Simulated tests, syntax compilation, package inspection, and Pi-loader registration checks do **not** establish live Apple Mail compatibility or constitute mailbox testing. Live testing requires separate user approval and an appropriate test message/account; do not read private messages or mutate real mail to validate development changes without it.
