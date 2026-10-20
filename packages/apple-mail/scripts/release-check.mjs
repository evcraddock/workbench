import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageName = "@evcraddock/pi-apple-mail";
const runtimeFiles = [
  "README.md",
  "index.ts",
  "package.json",
  "scripts/mail.js",
  "skills/apple-mail/SKILL.md",
  "src/bridge.ts",
  "src/tools.ts",
];

// This helper is release-only and deliberately excluded from the npm files allowlist.
export function checkRelease(root, manifest, tag, pack) {
  assert.equal(root.private, true, "The workspace root must remain private");
  assert.equal(manifest.name, packageName, "Only Apple Mail may be released");
  assert.notEqual(manifest.private, true, "Apple Mail must be publishable");
  assert.equal(manifest.publishConfig?.access, "public", "Apple Mail must use public npm access");
  assert.equal(manifest.repository?.url, "git+https://github.com/evcraddock/workbench.git",
    "The repository must match the npm trusted publisher");
  assert.equal(manifest.repository?.directory, "packages/apple-mail");
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
    "Releases require a stable semantic version");
  const expectedTag = `apple-mail-v${manifest.version}`;
  assert.equal(tag || expectedTag, expectedTag, "The Apple Mail tag must match its package version");
  const metadata = { package_name: packageName, version: manifest.version, tag: expectedTag };
  if (pack !== undefined) {
    assert.equal(pack.length, 1, "Pack exactly one workspace");
    const entry = pack[0];
    assert.equal(entry.name, packageName, "The tarball must contain Apple Mail");
    assert.equal(entry.version, manifest.version, "The tarball version must match the release");
    assert.equal(entry.filename, `evcraddock-pi-apple-mail-${manifest.version}.tgz`);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, "Require SHA-512 tarball integrity");
    assert.deepEqual(entry.bundled, [], "Do not publish bundled dependencies");
    assert.deepEqual(entry.files.map((file) => file.path).sort(), [...runtimeFiles].sort(),
      "The tarball must contain exactly the reviewed Apple Mail runtime files");
    metadata.tarball = entry.filename;
    metadata.integrity = entry.integrity;
  }
  return metadata;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
  const metadata = checkRelease(
    readJson(resolve(root, "package.json")),
    readJson(resolve(root, "packages/apple-mail/package.json")),
    process.argv[2],
    process.argv[3] ? readJson(process.argv[3]) : undefined,
  );
  for (const [key, value] of Object.entries(metadata)) console.log(`${key}=${value}`);
}
