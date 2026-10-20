import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const packageName = "@evcraddock/pi-migadu";
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const sha512Integrity = /^sha512-[A-Za-z0-9+/]{86}==$/;
const runtimeFiles = [
  "README.md",
  "index.ts",
  "package.json",
  "skills/migadu/SKILL.md",
  "src/client.ts",
  "src/tools.ts",
];

// Release-only: neither this helper nor its tests are included in the npm artifact.
export function checkRelease(root, manifest, tag, pack) {
  assert.equal(root.private, true, "The workspace root must remain private");
  assert.equal(manifest.name, packageName, "Only Migadu may be released");
  assert.notEqual(manifest.private, true, "Migadu must be publishable");
  assert.deepEqual(manifest.publishConfig, { access: "public" }, "Use only public npm publishing settings");
  assert.equal(manifest.repository?.url, "git+https://github.com/evcraddock/workbench.git",
    "The repository must match the npm trusted publisher");
  assert.equal(manifest.repository?.directory, "packages/migadu");
  assert.match(manifest.version, stableVersion, "Releases require a stable semantic version");
  const expectedTag = `migadu-v${manifest.version}`;
  assert.equal(tag || expectedTag, expectedTag, "The Migadu tag must match its package version");
  const metadata = { package_name: packageName, version: manifest.version, tag: expectedTag };
  if (pack !== undefined) {
    assert.equal(pack.length, 1, "Pack exactly one workspace");
    const entry = pack[0];
    assert.equal(entry.name, packageName, "The tarball must contain Migadu");
    assert.equal(entry.version, manifest.version, "The tarball version must match the release");
    assert.equal(entry.filename, `evcraddock-pi-migadu-${manifest.version}.tgz`);
    assert.match(entry.integrity, sha512Integrity, "Require SHA-512 tarball integrity");
    assert.deepEqual(entry.bundled, [], "Do not publish bundled dependencies");
    assert.deepEqual(entry.files.map((file) => file.path).sort(), [...runtimeFiles].sort(),
      "The tarball must contain exactly the reviewed Migadu runtime files");
    metadata.tarball = entry.filename;
    metadata.integrity = entry.integrity;
  }
  return metadata;
}

// Publication itself is never retried. Only public, unauthenticated registry reads
// are retried while npm processes the accepted version (about ten minutes).
export async function waitForPublished(metadata, {
  request = globalThis.fetch,
  sleep = delay,
  log = console.log,
} = {}) {
  assert.equal(metadata.package_name, packageName, "Only verify the Migadu package");
  assert.match(metadata.version, stableVersion);
  assert.match(metadata.integrity, sha512Integrity);
  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${metadata.version}`;
  const attempts = 21;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let data;
    let complete = false;
    try {
      const response = await request(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      // Fetch resolves at headers. Both reading and disposing a body can still fail.
      if (response.status === 200) {
        data = await response.json();
        complete = true;
      } else {
        if (![404, 408, 429].includes(response.status) && !(response.status >= 500 && response.status <= 599)) {
          throw new Error(`Registry verification refused HTTP ${response.status}`);
        }
        log(`Registry read ${attempt}/${attempts}: HTTP ${response.status}; version not yet verified`);
        await response.body?.cancel();
      }
    } catch (error) {
      if (!(error instanceof TypeError) &&
          !(error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name))) throw error;
      log(`Registry read ${attempt}/${attempts}: transient ${error.name}`);
    }
    // Invalid success data is not a transport failure and must never be retried.
    if (complete) {
      assert.equal(data?.name, packageName, "Published package name mismatch");
      assert.equal(data.version, metadata.version, "Published version mismatch");
      assert.equal(data.dist?.integrity, metadata.integrity, "Published tarball integrity mismatch");
      log(`${packageName}@${metadata.version} is available with the verified tarball integrity`);
      return data;
    }
    if (attempt < attempts) await sleep(30000);
  }
  throw new Error(`Accepted publication could not be verified after ${attempts} reads. Inspect npm state. Do not rerun npm publish blindly.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
  const verify = process.argv[2] === "--verify-published";
  const metadata = checkRelease(
    readJson(resolve(root, "package.json")),
    readJson(resolve(root, "packages/migadu/package.json")),
    verify ? process.env.RELEASE_TAG : process.argv[2],
    !verify && process.argv[3] ? readJson(process.argv[3]) : undefined,
  );
  if (verify) {
    assert(process.env.RELEASE_TAG, "Verification requires the actual release tag");
    assert.equal(process.env.PACKAGE_NAME, metadata.package_name);
    assert.equal(process.env.VERSION, metadata.version);
    await waitForPublished({ ...metadata, integrity: process.env.INTEGRITY });
  } else {
    for (const [key, value] of Object.entries(metadata)) console.log(`${key}=${value}`);
  }
}
