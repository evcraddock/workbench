import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkRelease } from "../scripts/release-check.mjs";

const root = { private: true };
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const files = [
  "README.md",
  "index.ts",
  "package.json",
  "scripts/mail.js",
  "skills/apple-mail/SKILL.md",
  "src/bridge.ts",
  "src/tools.ts",
];
const pack = () => [{
  name: manifest.name,
  version: manifest.version,
  filename: `evcraddock-pi-apple-mail-${manifest.version}.tgz`,
  integrity: "sha512-" + Buffer.alloc(64).toString("base64"),
  files: files.map((path) => ({ path })),
  bundled: [],
}];
const tag = `apple-mail-v${manifest.version}`;

test("release metadata selects only the public Apple Mail workspace in a private root", () => {
  const result = checkRelease(root, manifest, tag, pack());
  assert.equal(result.package_name, "@evcraddock/pi-apple-mail");
  assert.equal(result.version, manifest.version);
  assert.equal(result.tag, tag);
  assert.equal(result.tarball, `evcraddock-pi-apple-mail-${manifest.version}.tgz`);
  assert.equal(checkRelease(root, manifest, "").tag, tag);
});

test("release metadata refuses other workspaces, public roots and mismatched publishing settings", () => {
  assert.throws(() => checkRelease({ private: false }, manifest, tag));
  for (const changed of [
    { ...manifest, name: "@evcraddock/pi-migadu" },
    { ...manifest, publishConfig: { access: "restricted" } },
    { ...manifest, private: true },
    { ...manifest, repository: { ...manifest.repository, url: "git+https://forge.caradoc.com/erik/workbench.git" } },
    { ...manifest, repository: { ...manifest.repository, directory: "packages/migadu" } },
  ]) {
    assert.throws(() => checkRelease(root, changed, tag));
  }
});

test("release tags require an exact stable Apple Mail version and reject shell-like inputs", () => {
  for (const invalid of [
    "v0.1.0", "migadu-v0.1.0", "apple-mail-v9.9.9", "apple-mail-v01.1.0",
    "apple-mail-v0.1.0-rc.1", "apple-mail-v0.1.0+build", "apple-mail-v0.1.0\necho injected",
    "$(touch /tmp/not-run)", "refs/heads/main",
  ]) {
    assert.throws(() => checkRelease(root, manifest, invalid));
  }
  for (const version of ["01.1.0", "0.1.0-rc.1", "0.1.0+build", "0.1"]) {
    assert.throws(() => checkRelease(root, { ...manifest, version }, `apple-mail-v${version}`));
  }
});

test("release tarballs must contain exactly the package-local runtime, skill and documentation files", () => {
  for (const path of files) {
    const missing = pack();
    missing[0].files = missing[0].files.filter((file) => file.path !== path);
    assert.throws(() => checkRelease(root, manifest, tag, missing));
  }
  for (const path of ["tests/release.test.ts", ".npmrc", "../migadu/index.ts", "scripts/release-check.mjs"]) {
    const extra = pack();
    extra[0].files.push({ path });
    assert.throws(() => checkRelease(root, manifest, tag, extra));
  }
  const duplicate = pack();
  duplicate[0].files.push(duplicate[0].files[0]);
  assert.throws(() => checkRelease(root, manifest, tag, duplicate));
});

test("release tarballs reject multiple packages, wrong identity, unsafe filenames and missing integrity", () => {
  for (const report of [[], [...pack(), ...pack()]]) {
    assert.throws(() => checkRelease(root, manifest, tag, report));
  }
  for (const changes of [
    { name: "@evcraddock/pi-migadu" },
    { version: "9.9.9" },
    { filename: "../other.tgz" },
    { integrity: "" },
    { bundled: ["unapproved-dependency"] },
  ]) {
    const changed = pack();
    Object.assign(changed[0], changes);
    assert.throws(() => checkRelease(root, manifest, tag, changed));
  }
});
