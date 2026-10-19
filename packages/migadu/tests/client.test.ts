import assert from "node:assert/strict";
import test from "node:test";
import {
  createMigaduClient,
  listNames,
  MigaduError,
  normalizeList,
  parseTarget,
  validateEntry,
} from "../src/client.ts";
import type { Target } from "../src/client.ts";

const credentials = () => ({
  user: "admin@example.com",
  apiKey: "unit-test-key-not-a-real-secret",
});
const domain: Target = { scope: "domain", domain: "example.com" };
const mailbox: Target = { scope: "mailbox", domain: "example.com", localPart: "me+tag" };
const fields = {
  sender_allowlist: ["friend@example.net"],
  sender_denylist: [],
  recipient_denylist: "",
};
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
const errorCode = (code: string) => (error: unknown) =>
  error instanceof MigaduError && error.code === code;

test("normalizes only unambiguous string/array lists without changing entry spelling", () => {
  assert.deepEqual(normalizeList(""), []);
  assert.deepEqual(normalizeList("*@Example.net"), ["*@Example.net"]);
  assert.deepEqual(normalizeList(["*@Example.net", "pattern,with,commas"]), [
    "*@Example.net",
    "pattern,with,commas",
  ]);
  for (const value of [null, undefined, {}, [1], [""], ["a", "a"], "a,b", "a\nb", " a "]) {
    assert.throws(() => normalizeList(value), errorCode("INVALID_RESPONSE"));
  }
});

test("canonicalizes DNS targets and rejects ambiguous scope/path input", () => {
  assert.deepEqual(parseTarget({ scope: "domain", domain: "EXAMPLE.COM" }), domain);
  assert.equal(
    parseTarget({ scope: "domain", domain: "bücher.example" }).domain,
    "xn--bcher-kva.example"
  );
  assert.deepEqual(parseTarget(mailbox), mailbox);
  for (const target of [
    { scope: "domain", domain: "https://example.com" },
    { scope: "domain", domain: "example.com/../other" },
    { scope: "domain", domain: "example.com", localPart: "me" },
    { scope: "mailbox", domain: "example.com" },
    { scope: "mailbox", domain: "example.com", localPart: ".." },
    { scope: "mailbox", domain: "example.com", localPart: "me/../../other" },
    { scope: "mailbox", domain: "example.com", localPart: "me@elsewhere.com" },
    { scope: "domain", domain: "example.com", url: "https://evil.invalid" },
  ])
    assert.throws(() => parseTarget(target), errorCode("INVALID_ARGUMENTS"));
  for (const entry of ["", " a@example.com", "a,b", "a\nb", "a b", "a\u0000b"]) {
    assert.throws(() => validateEntry(entry), errorCode("INVALID_ARGUMENTS"));
  }
  assert.equal(validateEntry("*@example.net"), "*@example.net");
});

for (const target of [domain, mailbox]) {
  test(`reads only filtering fields and validates ${target.scope} identity`, async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const data =
      target.scope === "domain"
        ? { name: target.domain, ...fields }
        : {
            domain_name: target.domain,
            local_part: target.localPart,
            address: `${target.localPart}@${target.domain}`,
            ...fields,
          };
    const client = createMigaduClient({
      credentials,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return response({
          ...data,
          password: "must not be returned",
          forwarding: ["unrelated@example.org"],
        });
      },
    });
    const result = await client.get(target);
    assert.deepEqual(result, {
      target,
      lists: {
        sender_allowlist: ["friend@example.net"],
        sender_denylist: [],
        recipient_denylist: [],
      },
    });
    assert.equal(JSON.stringify(result).includes("password"), false);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]!.url,
      "https://api.migadu.com/v1/domains/example.com" +
        (target.scope === "mailbox" ? "/mailboxes/me%2Btag" : "")
    );
    assert.equal(calls[0]!.init.method, "GET");
    assert.equal(calls[0]!.init.redirect, "error");
    assert.equal(calls[0]!.init.credentials, "omit");
    assert.equal(
      new Headers(calls[0]!.init.headers).get("authorization"),
      "Basic " + Buffer.from("admin@example.com:unit-test-key-not-a-real-secret").toString("base64")
    );
    const wrong = createMigaduClient({
      credentials,
      fetch: async () =>
        response({
          ...data,
          ...(target.scope === "domain" ? { name: "other.com" } : { local_part: "other" }),
        }),
    });
    await assert.rejects(wrong.get(target), errorCode("TARGET_MISMATCH"));
  });

  test(`updates ${target.scope} with only the selected field and correct HTTP method`, async () => {
    const calls: RequestInit[] = [];
    const client = createMigaduClient({
      credentials,
      fetch: async (_url, init) => {
        calls.push(init!);
        return response({});
      },
    });
    await client.update(target, "recipient_denylist", ["blocked@example.net"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, target.scope === "domain" ? "PATCH" : "PUT");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      recipient_denylist: ["blocked@example.net"],
    });
    assert.equal(new Headers(calls[0]!.headers).get("content-type"), "application/json");
    await assert.rejects(
      client.update(target, "password" as never, []),
      errorCode("INVALID_ARGUMENTS")
    );
    assert.equal(calls.length, 1);
  });
}

test("missing/bad credentials and pre-aborted calls never start a request", async () => {
  let calls = 0;
  for (const configuration of [
    { user: "", apiKey: "" },
    { user: "bad:user", apiKey: "secret" },
    { user: "admin@example.com", apiKey: "secret\n" },
  ]) {
    const client = createMigaduClient({
      credentials: () => configuration,
      fetch: async () => {
        calls++;
        return response({});
      },
    });
    await assert.rejects(client.get(domain), errorCode("CONFIGURATION_ERROR"));
  }
  const controller = new AbortController();
  controller.abort();
  const client = createMigaduClient({
    credentials,
    fetch: async () => {
      calls++;
      return response({});
    },
  });
  await assert.rejects(client.get(domain, controller.signal), errorCode("CANCELLED"));
  assert.equal(calls, 0);
});

test("rejects missing fields, credential echoes, invalid JSON/content types and oversized bodies", async () => {
  for (const body of [
    { name: "example.com", sender_allowlist: [] },
    { name: "example.com", ...fields, sender_allowlist: [credentials().apiKey] },
    {
      name: "example.com",
      ...fields,
      recipient_denylist: [
        Buffer.from(`${credentials().user}:${credentials().apiKey}`).toString("base64"),
      ],
    },
    { name: "example.com", ...fields, sender_denylist: "a,b" },
  ]) {
    await assert.rejects(
      createMigaduClient({ credentials, fetch: async () => response(body) }).get(domain),
      errorCode("INVALID_RESPONSE")
    );
  }
  for (const reply of [
    new Response("not JSON", { headers: { "content-type": "application/json" } }),
    new Response("{}", { headers: { "content-type": "text/html" } }),
    new Response(JSON.stringify({ padding: "x".repeat(1024 * 1024) }), {
      headers: { "content-type": "application/json" },
    }),
  ]) {
    await assert.rejects(
      createMigaduClient({ credentials, fetch: async () => reply }).get(domain),
      errorCode("INVALID_RESPONSE")
    );
  }
});

for (const status of [301, 400, 401, 403, 429, 500]) {
  test(`HTTP ${status} never exposes server bodies or retries a write`, async () => {
    let calls = 0;
    const client = createMigaduClient({
      credentials,
      fetch: async () => {
        calls++;
        return response({ error: credentials().apiKey, message: "PRIVATE SERVER DATA" }, status);
      },
    });
    await assert.rejects(
      client.update(domain, "sender_denylist", ["blocked@example.net"]),
      (error: unknown) => {
        assert.ok(error instanceof MigaduError);
        assert.equal(error.mayHaveChanged, true);
        assert.equal(error.message.includes(credentials().apiKey), false);
        assert.equal(error.message.includes("PRIVATE SERVER DATA"), false);
        return true;
      }
    );
    assert.equal(calls, 1);
  });
}

for (const [label, apiKey] of [
  ["quote", 'fake-key-with-"quote"'],
  ["backslash", "fake-key-with-" + String.fromCharCode(92) + "-backslash"],
] as const) {
  test(`withholds ${label} credential echoes before serialization in every list and scope`, async () => {
    for (const target of [domain, mailbox]) {
      for (const list of listNames) {
        const identity =
          target.scope === "domain"
            ? { name: target.domain }
            : { domain_name: target.domain, local_part: target.localPart };
        const client = createMigaduClient({
          credentials: () => ({ user: "admin@example.com", apiKey }),
          fetch: async () =>
            response({ ...identity, ...fields, [list]: [`prefix-${apiKey}-suffix`] }),
        });
        await assert.rejects(client.get(target), (error: unknown) => {
          assert.ok(error instanceof MigaduError);
          assert.equal(error.code, "INVALID_RESPONSE");
          assert.equal(error.message.includes(apiKey), false);
          assert.equal(JSON.stringify(error).includes(apiKey), false);
          return true;
        });
      }
    }
  });
}

test("network failures, cancellation, timeout, and uncertain responses do not retry", async () => {
  const failure = createMigaduClient({
    credentials,
    fetch: async () => {
      throw new Error(credentials().apiKey);
    },
  });
  await assert.rejects(
    failure.get(domain),
    (error: unknown) =>
      error instanceof MigaduError &&
      !error.message.includes(credentials().apiKey) &&
      !error.mayHaveChanged
  );
  const hang = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  const timed = createMigaduClient({ credentials, fetch: hang, timeoutMs: 20 });
  await assert.rejects(
    timed.update(domain, "sender_allowlist", ["ok@example.net"]),
    (error: unknown) =>
      error instanceof MigaduError && error.code === "TIMEOUT" && error.mayHaveChanged
  );
  const controller = new AbortController();
  const cancelled = createMigaduClient({ credentials, fetch: hang });
  const pending = cancelled.get(domain, controller.signal);
  controller.abort();
  await assert.rejects(pending, errorCode("CANCELLED"));
  const malformed = createMigaduClient({
    credentials,
    fetch: async () => new Response("bad", { headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(
    malformed.update(mailbox, "sender_denylist", ["bad@example.net"]),
    (error: unknown) =>
      error instanceof MigaduError && error.code === "INVALID_RESPONSE" && error.mayHaveChanged
  );
});

test("response-body reads share the request timeout and are size bounded", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const client = createMigaduClient({
    credentials,
    timeoutMs: 20,
    fetch: async () => new Response(stream, { headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(client.get(domain), errorCode("TIMEOUT"));
  assert.equal(cancelled, true);
});
