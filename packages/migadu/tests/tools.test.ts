import assert from "node:assert/strict";
import test from "node:test";
import { createMigaduTools } from "../src/tools.ts";
import type { ConfirmationContext } from "../src/tools.ts";
import { createMigaduClient, listNames, MigaduError } from "../src/client.ts";
import type { Lists, MigaduClient, Snapshot, Target } from "../src/client.ts";

const errorCode = (code: string) => (error: unknown) =>
  error instanceof MigaduError && error.code === code;
const domain: Target = { scope: "domain", domain: "example.com" };
const mailbox: Target = { scope: "mailbox", domain: "example.com", localPart: "me" };
function fixture(target: Target = domain) {
  const lists: Lists = {
    sender_allowlist: ["friend@example.net"],
    sender_denylist: ["spam@example.net"],
    recipient_denylist: ["blocked@example.net"],
  };
  const calls: string[] = [];
  const writes: { list: string; entries: string[] }[] = [];
  let dialog = "";
  let confirmation = true;
  let failWrite = false;
  let failVerify = false;
  let changeOther = false;
  let ignoreWrite = false;
  const client: MigaduClient = {
    async get(requestTarget): Promise<Snapshot> {
      calls.push("get");
      assert.deepEqual(requestTarget, target);
      if (failVerify && writes.length) throw new Error("unsafe transport details");
      return { target: structuredClone(target), lists: structuredClone(lists) };
    },
    async update(requestTarget, list, entries) {
      calls.push("update");
      assert.deepEqual(requestTarget, target);
      writes.push({ list, entries: [...entries] });
      if (failWrite) throw new MigaduError("NETWORK_ERROR", "Write failed.", true);
      if (!ignoreWrite) lists[list] = [...entries];
      if (changeOther) lists.sender_denylist = ["unexpected@example.org"];
    },
  };
  const context: ConfirmationContext = {
    hasUI: true,
    ui: {
      async confirm(title, message) {
        dialog = title + "\n" + message;
        return confirmation;
      },
    },
  };
  return {
    execute: createMigaduTools(client),
    client,
    lists,
    calls,
    writes,
    context,
    dialog: () => dialog,
    decline: () => {
      confirmation = false;
    },
    failWrite: () => {
      failWrite = true;
    },
    failVerify: () => {
      failVerify = true;
    },
    changeOther: () => {
      changeOther = true;
    },
    ignoreWrite: () => {
      ignoreWrite = true;
    },
  };
}

test("read returns all three lists as untrusted data and never requests confirmation", async () => {
  const f = fixture();
  const result = await f.execute("migadu_lists_get", domain, f.context);
  assert.equal(result.untrustedContent, true);
  assert.equal(result.data.kind, "lists");
  assert.deepEqual(f.calls, ["get"]);
  assert.equal(f.dialog(), "");
});

for (const target of [domain, mailbox]) {
  for (const list of listNames) {
    for (const operation of ["add", "remove"] as const) {
      test(`${target.scope} ${list}: ${operation} changes one exact entry and preserves all others`, async () => {
        const f = fixture(target);
        const original = structuredClone(f.lists);
        const entry = operation === "add" ? "new@example.org" : f.lists[list][0]!;
        const result = await f.execute(
          `migadu_list_${operation}`,
          { ...target, list, entry },
          f.context
        );
        assert.equal(result.data.kind, "list_change");
        if (result.data.kind !== "list_change") throw new Error("Unexpected result");
        assert.equal(result.data.changed, true);
        assert.equal(result.data.reason, "verified");
        assert.deepEqual(f.calls, ["get", "get", "update", "get"]);
        assert.equal(f.writes.length, 1);
        assert.deepEqual(f.writes[0], {
          list,
          entries: operation === "add" ? [...original[list], entry] : [],
        });
        for (const other of listNames.filter((name) => name !== list))
          assert.deepEqual(f.lists[other], original[other]);
        assert.match(f.dialog(), /example\.com/);
        assert.ok(f.dialog().includes(list));
        assert.ok(f.dialog().includes(entry));
        if (target.scope === "mailbox") assert.match(f.dialog(), /me@example\.com/);
      });
    }
  }
}

test("already present additions and absent removals are no-ops without a write or dialog", async () => {
  for (const [operation, entry] of [
    ["add", "friend@example.net"],
    ["remove", "absent@example.net"],
  ] as const) {
    const f = fixture();
    const result = await f.execute(
      `migadu_list_${operation}`,
      { ...domain, list: "sender_allowlist", entry },
      f.context
    );
    assert.equal(result.data.kind, "list_change");
    if (result.data.kind !== "list_change") throw new Error();
    assert.equal(result.data.changed, false);
    assert.deepEqual(f.calls, ["get"]);
    assert.equal(f.dialog(), "");
  }
});

test("no UI, forged confirmation flags, invalid scope/list, and bulk values fail before API calls", async () => {
  const f = fixture();
  const input = { ...domain, list: "sender_allowlist", entry: "new@example.org" };
  await assert.rejects(
    f.execute("migadu_list_add", input, { ...f.context, hasUI: false }),
    errorCode("CONFIRMATION_UNAVAILABLE")
  );
  for (const invalid of [
    { ...input, confirmed: true },
    { ...input, list: "password" },
    { ...input, entry: ["a", "b"] },
    { ...input, entry: "a,b" },
    { ...input, localPart: "unexpected" },
    { ...input, apiKey: "must-not-be-accepted" },
  ])
    await assert.rejects(
      f.execute("migadu_list_add", invalid, f.context),
      errorCode("INVALID_ARGUMENTS")
    );
  assert.deepEqual(f.calls, []);
});

test("declined, failed and cancelled dialogs never write", async () => {
  const input = { ...domain, list: "sender_allowlist", entry: "new@example.org" };
  const f = fixture();
  f.decline();
  await assert.rejects(
    f.execute("migadu_list_add", input, f.context),
    errorCode("CONFIRMATION_DENIED")
  );
  assert.deepEqual(f.calls, ["get"]);
  const controller = new AbortController();
  f.context.ui.confirm = async (_title, _text, options) => {
    assert.equal(options?.signal, controller.signal);
    assert.equal(options?.timeout, 60_000);
    controller.abort();
    return true;
  };
  await assert.rejects(
    f.execute("migadu_list_add", input, f.context, controller.signal),
    errorCode("CANCELLED")
  );
  f.context.ui.confirm = async () => {
    throw new Error("UI disconnected");
  };
  await assert.rejects(f.execute("migadu_list_add", input, f.context), /UI disconnected/);
  assert.equal(f.writes.length, 0);
});

test("stale list changes during confirmation refuse writes; reordering alone is harmless", async () => {
  const input = { ...domain, list: "sender_allowlist", entry: "new@example.org" };
  const f = fixture();
  f.context.ui.confirm = async () => {
    f.lists.sender_allowlist.push("concurrent@example.org");
    return true;
  };
  await assert.rejects(f.execute("migadu_list_add", input, f.context), errorCode("STALE_LIST"));
  assert.equal(f.writes.length, 0);
  const ordered = fixture();
  ordered.lists.sender_allowlist.push("other@example.org");
  ordered.context.ui.confirm = async () => {
    ordered.lists.sender_allowlist.reverse();
    return true;
  };
  const result = await ordered.execute("migadu_list_add", input, ordered.context);
  assert.equal(result.data.kind, "list_change");
  assert.deepEqual(
    new Set(ordered.lists.sender_allowlist),
    new Set(["friend@example.net", "other@example.org", "new@example.org"])
  );
});

test("uncertain writes and failed verification do not retry or roll back", async () => {
  const input = { ...domain, list: "sender_allowlist", entry: "new@example.org" };
  for (const mode of ["write", "verify", "other-list", "unchanged-list"] as const) {
    const f = fixture();
    if (mode === "write") f.failWrite();
    if (mode === "verify") f.failVerify();
    if (mode === "other-list") f.changeOther();
    if (mode === "unchanged-list") f.ignoreWrite();
    await assert.rejects(
      f.execute("migadu_list_add", input, f.context),
      (error: unknown) =>
        error instanceof MigaduError &&
        error.mayHaveChanged &&
        !error.message.includes("unsafe transport details")
    );
    assert.equal(f.writes.length, 1);
    assert.equal(f.calls.filter((call) => call === "update").length, 1);
  }
});

test("tools and real client interoperate through mocked HTTP for every list/scope", async () => {
  for (const target of [domain, mailbox]) {
    for (const list of listNames) {
      const lists: Lists = {
        sender_allowlist: ["existing@example.net"],
        sender_denylist: [],
        recipient_denylist: [],
      };
      const requests: string[] = [];
      const client = createMigaduClient({
        credentials: () => ({ user: "admin@example.com", apiKey: "fake-integration-key-not-real" }),
        fetch: async (_url, init) => {
          requests.push(init!.method!);
          if (init!.method !== "GET") {
            assert.equal(init!.method, target.scope === "domain" ? "PATCH" : "PUT");
            const body = JSON.parse(init!.body as string) as Record<string, string[]>;
            assert.deepEqual(Object.keys(body), [list]);
            lists[list] = body[list]!;
          }
          const data =
            target.scope === "domain"
              ? { name: target.domain, ...lists }
              : { domain_name: target.domain, local_part: target.localPart, ...lists };
          return new Response(JSON.stringify(data), {
            headers: { "content-type": "application/json" },
          });
        },
      });
      const execute = createMigaduTools(client);
      const context: ConfirmationContext = { hasUI: true, ui: { confirm: async () => true } };
      for (const operation of ["add", "remove"] as const) {
        requests.length = 0;
        const result = await execute(
          `migadu_list_${operation}`,
          { ...target, list, entry: "chosen@example.org" },
          context
        );
        assert.deepEqual(requests, [
          "GET",
          "GET",
          target.scope === "domain" ? "PATCH" : "PUT",
          "GET",
        ]);
        assert.equal(result.data.kind, "list_change");
        if (result.data.kind !== "list_change") throw new Error();
        assert.equal(result.data.changed, true);
        assert.equal(result.data.entries.includes("chosen@example.org"), operation === "add");
        assert.equal(JSON.stringify(result).includes("fake-integration-key-not-real"), false);
      }
    }
  }
});

test("confirmation escapes hostile display characters without hiding the exact entry", async () => {
  const f = fixture();
  const entry = "hostile\u202e\u200b\u{E0001}@example.org";
  await f.execute("migadu_list_add", { ...domain, list: "sender_allowlist", entry }, f.context);
  assert.equal(f.dialog().includes("\u202e"), false);
  assert.equal(f.dialog().includes("\u200b"), false);
  assert.equal(f.dialog().includes("\u{E0001}"), false);
  assert.match(f.dialog(), /\\u202e/);
  assert.match(f.dialog(), /\\u200b/);
  assert.match(f.dialog(), /\\udb40\\udc01/);
  assert.equal(f.lists.sender_allowlist.includes(entry), true);
});

test("local updates serialize per target; a cancelled queued operation does not unlock its predecessor", async () => {
  const f = fixture();
  let releaseFirst: (value: boolean) => void = () => {};
  let firstShown: () => void = () => {};
  const shown = new Promise<void>((resolve) => {
    firstShown = resolve;
  });
  let dialogs = 0;
  f.context.ui.confirm = async () => {
    dialogs++;
    if (dialogs === 1) {
      firstShown();
      return new Promise<boolean>((resolve) => {
        releaseFirst = resolve;
      });
    }
    return true;
  };
  const first = f.execute(
    "migadu_list_add",
    { ...domain, list: "sender_allowlist", entry: "first@example.org" },
    f.context
  );
  await shown;
  const controller = new AbortController();
  const second = f.execute(
    "migadu_list_add",
    { ...domain, list: "sender_allowlist", entry: "second@example.org" },
    f.context,
    controller.signal
  );
  controller.abort();
  await assert.rejects(second, errorCode("CANCELLED"));
  const third = f.execute(
    "migadu_list_add",
    { ...domain, list: "sender_allowlist", entry: "third@example.org" },
    f.context
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  releaseFirst(true);
  await Promise.all([first, third]);
  assert.equal(dialogs, 2);
  assert.deepEqual(f.lists.sender_allowlist, [
    "friend@example.net",
    "first@example.org",
    "third@example.org",
  ]);
});
