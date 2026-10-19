import assert from "node:assert/strict";
import test from "node:test";
import {
  createMailBridge,
  MailError,
  runProcess,
  validateId,
  approvalToken,
} from "../src/bridge.ts";
import type { MailRequest, ProcessRunner } from "../src/bridge.ts";

const id =
  "mail-v1:" +
  encodeURIComponent(
    JSON.stringify(["account-a", 1, "2026-10-19T12:00:00.000Z", "<1@example.com>"])
  );
const message = {
  id,
  accountId: "account-a",
  accountName: "Personal",
  sender: "sender@example.com",
  subject: "Receipt",
  receivedAt: "2026-10-19T12:00:00.000Z",
  read: false,
};
const inbox = { kind: "inbox", total: 1, unreadCount: 1, messages: [message] };
function bridgeWith(data: unknown) {
  return createMailBridge({
    platform: "darwin",
    runner: async () => JSON.stringify({ ok: true, data }),
  });
}
const errorCode = (code: string) => (error: unknown) =>
  error instanceof MailError && error.code === code;

test("runs only the bundled script with a separate JSON argument, preserving opaque values", async () => {
  let called = false;
  const runner: ProcessRunner = async (file, args, signal) => {
    called = true;
    assert.equal(file, "/usr/bin/osascript");
    assert.deepEqual(args.slice(0, 2), ["-l", "JavaScript"]);
    assert.match(args[2]!, /scripts\/mail\.js$/);
    assert.equal(args.length, 4);
    assert.deepEqual(JSON.parse(args[3]!), { action: "inbox", limit: 10 });
    assert.equal(signal, undefined);
    return JSON.stringify({ ok: true, data: inbox });
  };
  assert.deepEqual(
    await createMailBridge({ platform: "darwin", runner }).run({ action: "inbox", limit: 10 }),
    inbox
  );
  assert.equal(called, true);
});

test("rejects malformed IDs, extra arguments, invalid limits, and unsupported platforms before spawning", async () => {
  let calls = 0;
  const runner: ProcessRunner = async () => {
    calls++;
    return "";
  };
  const bridge = createMailBridge({ platform: "darwin", runner });
  for (const value of [
    "",
    "1",
    "mail-v1:%",
    "mail-v1:" + encodeURIComponent(JSON.stringify(["a", -1, "bad", ""])),
  ]) {
    assert.throws(() => validateId(value), errorCode("INVALID_ID"));
  }
  for (const request of [
    { action: "inbox", limit: 0 },
    { action: "inbox", limit: 1.5 },
    { action: "inbox", limit: 101 },
    { action: "read", id, confirmed: true },
    { action: "delete", id, approvalToken: "" },
  ]) {
    await assert.rejects(bridge.run(request as MailRequest));
  }
  await assert.rejects(
    createMailBridge({ platform: "linux", runner }).run({ action: "inbox", limit: 10 }),
    errorCode("UNSUPPORTED_PLATFORM")
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    bridge.run({ action: "inbox", limit: 10 }, controller.signal),
    errorCode("CANCELLED")
  );
  assert.equal(calls, 0);
});

test("rejects malformed JSON, oversized responses, wrong kinds and body leakage in inbox metadata", async () => {
  for (const raw of [
    "not JSON",
    JSON.stringify({ ok: "true", data: inbox }),
    " ".repeat(1024 * 1024 + 1),
  ]) {
    const bridge = createMailBridge({ platform: "darwin", runner: async () => raw });
    await assert.rejects(bridge.run({ action: "inbox", limit: 10 }), errorCode("INVALID_RESPONSE"));
  }
  for (const data of [
    { ...inbox, kind: "read" },
    { ...inbox, unreadCount: 2 },
    { ...inbox, messages: [message, message], total: 2 },
    { ...inbox, messages: [{ ...message, body: "must not leak" }] },
    { ...inbox, messages: [{ ...message, accountId: "another-account" }] },
  ]) {
    await assert.rejects(
      bridgeWith(data).run({ action: "inbox", limit: 10 }),
      errorCode("INVALID_RESPONSE")
    );
  }
});

test("validates read state, body bounds, target identity, approval snapshots, and mutation counts", async () => {
  const read = {
    kind: "read",
    message: { ...message, read: true },
    body: "plain text",
    truncated: false,
    markedRead: true,
  };
  assert.deepEqual(await bridgeWith(read).run({ action: "read", id }), read);
  for (const data of [
    { ...read, markedRead: false },
    { ...read, body: "x".repeat(32001) },
    { ...read, message },
  ]) {
    await assert.rejects(
      bridgeWith(data).run({ action: "read", id }),
      errorCode("INVALID_RESPONSE")
    );
  }
  const preview = {
    kind: "inspect",
    operation: "archive" as const,
    message,
    destination: "Archive",
    approvalToken: "",
  };
  preview.approvalToken = approvalToken(preview);
  assert.deepEqual(
    await bridgeWith(preview).run({ action: "inspect", operation: "archive", id }),
    preview
  );
  await assert.rejects(
    bridgeWith({ ...preview, approvalToken: "forged" }).run({
      action: "inspect",
      operation: "archive",
      id,
    }),
    errorCode("INVALID_RESPONSE")
  );
  const mutation = {
    kind: "mutation",
    operation: "archive",
    id,
    affectedCount: 1,
    destination: "Archive",
  };
  const request: MailRequest = { action: "archive", id, approvalToken: preview.approvalToken };
  assert.deepEqual(await bridgeWith(mutation).run(request), mutation);
  for (const data of [
    { ...mutation, affectedCount: 2 },
    { ...mutation, destination: "Trash" },
    { ...mutation, operation: "delete" },
  ]) {
    await assert.rejects(bridgeWith(data).run(request), errorCode("INVALID_RESPONSE"));
  }
});

test("propagates safe automation errors and flags uncertain process failures without retrying", async () => {
  const denied = createMailBridge({
    platform: "darwin",
    runner: async () =>
      JSON.stringify({
        ok: false,
        error: {
          code: "AUTOMATION_DENIED",
          message: "macOS denied Automation access to Apple Mail.",
          mayHaveChanged: false,
        },
      }),
  });
  await assert.rejects(
    denied.run({ action: "read", id }),
    (error: unknown) =>
      error instanceof MailError && error.code === "AUTOMATION_DENIED" && !error.mayHaveChanged
  );
  let calls = 0;
  const failed = createMailBridge({
    platform: "darwin",
    runner: async () => {
      calls++;
      throw new Error("private subprocess details");
    },
  });
  await assert.rejects(
    failed.run({ action: "delete", id, approvalToken: "snapshot" }),
    (error: unknown) =>
      error instanceof MailError &&
      error.mayHaveChanged &&
      !error.message.includes("private subprocess details")
  );
  assert.equal(calls, 1);
});

test("process runner supports separate arguments and never exposes private stderr", async () => {
  assert.equal(
    await runProcess(process.execPath, [
      "-e",
      "process.stdout.write(process.argv[1])",
      "$(not-a-shell-command)",
    ]),
    "$(not-a-shell-command)"
  );
  await assert.rejects(
    runProcess(process.execPath, [
      "-e",
      "process.stderr.write('PRIVATE MAIL DATA');process.exit(2)",
    ]),
    (error: unknown) => error instanceof MailError && !error.message.includes("PRIVATE MAIL DATA")
  );
});

test("process runner cancels promptly and rejects output above its fixed buffer limit", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40);
  try {
    await assert.rejects(
      runProcess(process.execPath, ["-e", "setTimeout(()=>{},10000)"], controller.signal),
      errorCode("CANCELLED")
    );
  } finally {
    clearTimeout(timer);
  }
  await assert.rejects(
    runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(2*1024*1024))"]),
    errorCode("OUTPUT_LIMIT")
  );
  await assert.rejects(
    runProcess("/nonexistent/apple-mail-automation-test", []),
    errorCode("PROCESS_UNAVAILABLE")
  );
});

test("process runner enforces its 30-second timeout", { timeout: 40_000 }, async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setTimeout(()=>{},100000)"]),
    errorCode("TIMEOUT")
  );
});
