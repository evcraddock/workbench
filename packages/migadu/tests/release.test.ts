import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkRelease, waitForPublished } from "../scripts/release-check.mjs";

const root = { private: true };
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const files = [
  "README.md",
  "index.ts",
  "package.json",
  "skills/migadu/SKILL.md",
  "src/client.ts",
  "src/tools.ts",
];
const integrity = "sha512-" + Buffer.alloc(64).toString("base64");
const tag = `migadu-v${manifest.version}`;
const pack = () => [{
  name: manifest.name,
  version: manifest.version,
  filename: `evcraddock-pi-migadu-${manifest.version}.tgz`,
  integrity,
  files: files.map((path) => ({ path })),
  bundled: [],
}];
const expected = { package_name: "@evcraddock/pi-migadu", version: manifest.version, integrity };
const published = () => ({ name: expected.package_name, version: expected.version, dist: { integrity } });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

test("release metadata selects only public Migadu within the private workspace root", () => {
  const result = checkRelease(root, manifest, tag, pack());
  assert.equal(result.package_name, "@evcraddock/pi-migadu");
  assert.equal(result.version, manifest.version);
  assert.equal(result.tag, tag);
  assert.equal(result.tarball, `evcraddock-pi-migadu-${manifest.version}.tgz`);
  assert.equal(result.integrity, integrity);
  assert.equal(checkRelease(root, manifest, "").tag, tag);
});

test("release metadata rejects Apple Mail, public roots, private packages and wrong publisher settings", () => {
  assert.throws(() => checkRelease({ private: false }, manifest, tag));
  for (const changed of [
    { ...manifest, name: "@evcraddock/pi-apple-mail" },
    { ...manifest, private: true },
    { ...manifest, publishConfig: { access: "restricted" } },
    { ...manifest, publishConfig: { access: "public", registry: "https://other.invalid" } },
    { ...manifest, repository: { ...manifest.repository, url: "git+https://forge.caradoc.com/erik/workbench.git" } },
    { ...manifest, repository: { ...manifest.repository, directory: "packages/apple-mail" } },
  ]) assert.throws(() => checkRelease(root, changed, tag));
});

test("release tags require the exact stable Migadu version and cannot inject workflow output", () => {
  for (const invalid of [
    "v0.1.0", "apple-mail-v0.1.0", "migadu-v9.9.9", "migadu-v01.1.0",
    "migadu-v0.1.0-rc.1", "migadu-v0.1.0+build", "migadu-v0.1.0\necho injected",
    "$(touch /tmp/not-run)", "refs/heads/main",
  ]) assert.throws(() => checkRelease(root, manifest, invalid));
  for (const version of ["01.1.0", "0.1.0-rc.1", "0.1.0+build", "0.1"]) {
    assert.throws(() => checkRelease(root, { ...manifest, version }, `migadu-v${version}`));
  }
});

test("release tarballs contain exactly the six reviewed package-local files", () => {
  for (const path of files) {
    const missing = pack();
    missing[0].files = missing[0].files.filter((file) => file.path !== path);
    assert.throws(() => checkRelease(root, manifest, tag, missing));
  }
  for (const path of ["tests/release.test.ts", ".npmrc", "../apple-mail/index.ts", "scripts/release-check.mjs"]) {
    const extra = pack();
    extra[0].files.push({ path });
    assert.throws(() => checkRelease(root, manifest, tag, extra));
  }
  const duplicate = pack();
  duplicate[0].files.push(duplicate[0].files[0]);
  assert.throws(() => checkRelease(root, manifest, tag, duplicate));
});

test("release tarballs reject multiple packages, wrong identity, unsafe filenames, bundles and missing integrity", () => {
  for (const report of [[], [...pack(), ...pack()]]) {
    assert.throws(() => checkRelease(root, manifest, tag, report));
  }
  for (const changes of [
    { name: "@evcraddock/pi-apple-mail" }, { version: "9.9.9" },
    { filename: "../other.tgz" }, { integrity: "" }, { bundled: ["unapproved-dependency"] },
  ]) {
    const changed = pack();
    Object.assign(changed[0], changes);
    assert.throws(() => checkRelease(root, manifest, tag, changed));
  }
});

test("registry verification tolerates delayed npm processing with only bounded unauthenticated GETs", async () => {
  let reads = 0;
  const sleeps: number[] = [];
  const result = await waitForPublished(expected, {
    request: async (url: string, options: RequestInit) => {
      assert.equal(url, `https://registry.npmjs.org/%40evcraddock%2Fpi-migadu/${manifest.version}`);
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers, undefined);
      assert(options.signal instanceof AbortSignal);
      return ++reads < 5 ? json({ error: "processing" }, 404) : json(published());
    },
    sleep: async (ms: number) => { sleeps.push(ms); },
    log: () => {},
  });
  assert.deepEqual(result, published());
  assert.equal(reads, 5);
  assert.deepEqual(sleeps, [30000, 30000, 30000, 30000]);
});

test("registry verification retries transient network/server responses but never a publish write", async () => {
  let reads = 0;
  const result = await waitForPublished(expected, {
    request: async () => {
      reads++;
      if (reads === 1) throw new TypeError("simulated network reset");
      if (reads === 2) return json({}, 429);
      if (reads === 3) return json({}, 503);
      return json(published());
    },
    sleep: async () => {},
    log: () => {},
  });
  assert.deepEqual(result, published());
  assert.equal(reads, 4);
});

for (const error of [
  new TypeError("simulated response-body connection reset"),
  new DOMException("simulated response-body deadline", "TimeoutError"),
]) {
  test(`registry verification retries a transient ${error.name} during response-body reading`, async () => {
    let reads = 0;
    const sleeps: number[] = [];
    const result = await waitForPublished(expected, {
      request: async () => {
        reads++;
        if (reads === 1) {
          return new Response(new ReadableStream({
            start(controller) { controller.error(error); },
          }));
        }
        return json(published());
      },
      sleep: async (ms: number) => { sleeps.push(ms); },
      log: () => {},
    });
    assert.deepEqual(result, published());
    assert.equal(reads, 2);
    assert.deepEqual(sleeps, [30000]);
  });
}

test("registry verification stops immediately on mismatched identity/integrity or malformed success data", async () => {
  for (const data of [
    { ...published(), name: "@evcraddock/pi-apple-mail" },
    { ...published(), version: "9.9.9" },
    { ...published(), dist: { integrity: "sha512-wrong" } },
    {}, null, [],
  ]) {
    let reads = 0;
    await assert.rejects(waitForPublished(expected, {
      request: async () => { reads++; return json(data); },
      sleep: async () => { assert.fail("Do not retry mismatched success data"); },
      log: () => {},
    }));
    assert.equal(reads, 1);
  }
  await assert.rejects(waitForPublished(expected, {
    request: async () => new Response("not JSON"),
    sleep: async () => { assert.fail("Malformed JSON is not a transient transport error"); },
    log: () => {},
  }), /JSON/);
});

test("registry verification fails fast on authorization errors and invalid expected metadata", async () => {
  for (const status of [400, 401, 403]) {
    await assert.rejects(waitForPublished(expected, {
      request: async () => json({}, status),
      sleep: async () => { assert.fail("Do not retry non-transient errors"); },
      log: () => {},
    }), new RegExp(`HTTP ${status}`));
  }
  for (const changed of [
    { ...expected, package_name: "@evcraddock/pi-apple-mail" },
    { ...expected, version: "../other" },
    { ...expected, integrity: "" },
  ]) {
    await assert.rejects(waitForPublished(changed, {
      request: async () => { assert.fail("Invalid metadata must not reach the registry"); },
    }));
  }
});

test("registry processing has a finite 21-read window and never sleeps after the final read", async () => {
  let reads = 0;
  const sleeps: number[] = [];
  await assert.rejects(waitForPublished(expected, {
    request: async () => { reads++; return json({}, 404); },
    sleep: async (ms: number) => { sleeps.push(ms); },
    log: () => {},
  }), /21 reads.*Do not rerun npm publish/);
  assert.equal(reads, 21);
  assert.equal(sleeps.length, 20);
  assert(sleeps.every((ms) => ms === 30000));
});
