# @evcraddock/pi-migadu

Pi tools for managing three Migadu filtering lists at domain or mailbox scope: `sender_allowlist`, `sender_denylist`, and `recipient_denylist`. Includes companion workflow instructions. Uses Node's built-in HTTPS `fetch`; no runtime dependencies other than Pi-provided host modules, no build step, and no admin-panel automation.

## Requirements and configuration

- Node.js 22.19+ and Pi 1.3+.
- A Migadu API key with permission for the selected target and the Migadu account email associated with it. Obtain/manage the key yourself through Migadu's account settings; this extension does not create credentials or change permissions.
- Set `MIGADU_USER` to that account email and `MIGADU_API_KEY` to the key in the local environment of the process starting Pi. Use your local secret-management workflow. Never put a real key in chat, tool arguments, command-line arguments, committed files, or shell history.
- A live Pi confirmation dialog for changes. Print/headless modes without dialog support cannot update lists; supported RPC clients may forward the dialog.

The extension reads credentials only when an API operation is requested, not during loading. They are never tool parameters. Authentication uses HTTP Basic over HTTPS to the fixed `https://api.migadu.com/v1/` endpoint. Redirects are refused, cookies are omitted, and errors do not expose raw transport/server text or headers. Filtering responses that contain the configured key or full Basic-auth credential encoding are withheld. This is not a sandbox: other trusted code running inside Pi has the same operating-system/environment access.

After a separately authorized npm publication:

```bash
pi install npm:@evcraddock/pi-migadu
```

For a separately authorized local test without registering a persistent installation, start Pi from the repository root with:

```bash
pi --extension ./packages/migadu/index.ts --skill ./packages/migadu/skills/migadu
```

Use `/reload` or restart Pi after installing/updating resources. This implementation has not installed the package or configured credentials for you.

## Tools and arguments

| Tool | Purpose | Arguments |
| --- | --- | --- |
| `migadu_lists_get` | Read all three explicit filtering lists for one target | `scope`, `domain`, and `localPart` for mailbox scope only |
| `migadu_list_add` | Add one exact entry to one list, preserving all existing entries | Target arguments plus `list` and `entry` |
| `migadu_list_remove` | Remove one exact entry from one list, retaining all other entries | Target arguments plus `list` and `entry` |

`scope` is `domain` or `mailbox`. `domain` is a DNS name; it is lowercased and IDNA-normalized, not interpreted as a URL. Mailbox scope requires a local part, such as `erik` or `erik+tag`, and domain scope must omit it. Supported local-part characters are letters, digits, underscore, plus, hyphen, and dot-separated segments; exotic/quoted local parts fail rather than being guessed. The API response must identify the same target.

Example read arguments:

```json
{ "scope": "domain", "domain": "example.com" }
```

Example mailbox-scoped addition arguments (still requires the tool's confirmation dialog):

```json
{
  "scope": "mailbox",
  "domain": "example.com",
  "localPart": "erik",
  "list": "sender_denylist",
  "entry": "blocked@example.net"
}
```

These are examples, not requests to access or change any account. An entry is an exact opaque value interpreted by Migadu: the extension does not expand patterns, infer precedence, or automatically case-fold entries. New entries must be nonempty, at most 2,048 characters, and contain no whitespace, commas, semicolons, or control characters. Do not pass CSV/bulk values. Existing array entries are preserved exactly, including valid opaque patterns. Domain and mailbox settings are returned separately; the tools do not calculate inherited/effective filtering behavior.

## Update safeguards

1. Validate the target, selected list, and single entry. Refuse updates without a supported UI before any API request.
2. Read the current filtering snapshot. An already-present addition or absent removal is a no-op with no write or dialog.
3. Show a concrete confirmation dialog with scope, exact domain/mailbox, list, complete escaped entry, and count change. Nothing in API/email text is authorization. A direct user request does not bypass this dialog; there is no `confirmed` argument or headless override.
4. Re-read after confirmation. If the selected list changed, refuse before sending an update. Reordering alone is not treated as a policy change.
5. Send only the selected list field: domain updates use `PATCH`, mailbox updates use `PUT`, as documented by Migadu. No full account object is submitted.
6. Read back all three lists. Report success only when the selected entries match and the other two lists are unchanged from the pre-write snapshot. Uncertain transport, malformed write response, failed verification, or unexpected concurrent changes produce an uncertainty error—not a rollback or second write.

Mutating calls are model-only and all tools request sequential execution. This extension also serializes its own updates per target, including the confirmation interval. Queued cancellation does not permit another update to jump past an earlier operation.

**Remote updates are not atomic.** Migadu's documented API does not specify conditional writes/CAS or server-side entry-level mutations. Another client can change the same list between the final read and the write, and that edit can be overwritten without detection. Local queuing, stale checks, and read-back verification cannot eliminate that race. Coordinate administrators/other writers when changing the same target; do not treat this extension as a distributed lock or transactional policy manager.

The tools do not expose whole-list replacement or clearing. Removing the only entry intentionally leaves an empty selected list, but the user still confirms that specific removal. There is no domain/mailbox creation or deletion, password/forwarding management, or other account administration. A Mail spam/delete/archive request does not also authorize a Migadu policy change.

## API representation, limits, and errors

The [Migadu API documentation](https://www.migadu.com/api/) inconsistently describes filtering values as strings/lists while showing arrays in response examples. This client accepts arrays, the empty string as an empty list, and a single unambiguous string entry. It **refuses** ambiguous multi-entry strings containing separators/whitespace rather than guessing a delimiter and rewriting the wrong rules. Duplicate, missing, or malformed lists fail closed. Writes use JSON arrays, consistent with the documented examples; no fallback write with a different representation is attempted.

Every request and response-body read has a shared 30-second deadline and a 1 MiB response limit; normalized lists have a 10,000-entry safety limit. Confirmation expires after 60 seconds. Credentials/configuration failures occur before network access; 401/403, rate limits, unexpected content types/targets, invalid JSON, transport failures, timeouts, and cancellation have safe contextual errors. No request is automatically retried. An error after a write may mean state changed; read the current lists before considering another explicitly authorized attempt.

API values are returned as untrusted structured data. Only target/filtering fields are returned, not account passwords, forwarding information, or other settings. Filtering values may still be private and are sent to the configured model and recorded in Pi tool transcripts. The confirmation gate and instructions reduce risk but do not isolate Pi from malicious text or other privileged extensions.

## Layout and development checks

```text
migadu/
├── package.json
├── index.ts
├── README.md
├── src/
│   ├── client.ts
│   └── tools.ts
├── skills/
│   └── migadu/
│       └── SKILL.md
└── tests/
    ├── client.test.ts
    └── tools.test.ts
```

From the repository root:

```bash
npm test --workspace @evcraddock/pi-migadu
npm pack --workspace @evcraddock/pi-migadu --dry-run
```

Tests use Node's built-in runner, injected fake credentials, and mocked HTTP responses. They do not read real keys or call Migadu. Tests and repository tooling are excluded from the npm artifact. Root configuration and the Apple Mail package are not modified by this package.

**Live Migadu compatibility and real account changes have not been tested.** Mock tests and Pi-loader/package checks are not evidence of server acceptance of every field representation. Any live testing, credential setup, installation, or npm publication requires separate explicit authorization; publishing is not implied by merging the implementation.
