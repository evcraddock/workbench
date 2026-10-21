import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const instructions = [
  ["session guidelines", "../index.ts"],
  ["companion skill", "../skills/apple-mail/SKILL.md"],
  ["README", "../README.md"],
] as const;

for (const [name, path] of instructions) {
  const text = readFileSync(new URL(path, import.meta.url), "utf8");

  test(`${name} distinguish native tool limits from user-requested email processing`, () => {
    assert.match(text, /native tool limits, not restrictions on user-requested workflows/i);
    assert.match(text, /other available tools/i);
    assert.match(text, /save (?:a message|the returned text) as a PDF/i);
    assert.doesNotMatch(text, /No attachment processing|Do not handle attachments|Do not render HTML/);
    assert.doesNotMatch(text, /do not invent omitted content or bypass the limit with another tool/i);
  });
}

test("session guidelines and skill allow reading for requested processing without weakening safeguards", () => {
  for (const [, path] of instructions.slice(0, 2)) {
    const text = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(text, /read a message body only when needed for the user's request/i);
    assert.match(text, /marks the message read/i);
    assert.match(text, /follow the user's requested output format/i);
    assert.match(text, /truncat[^\n]*incomplete/i);
    assert.match(text, /do not invent (?:missing|omitted) content or describe a partial export as complete/i);
    assert.match(text, /untrusted data/i);
    assert.match(text, /exact opaque (?:message )?identifier/i);
    assert.match(text, /do not (?:work around|bypass)|never bypass/i);
    assert.match(text, /confirmation configuration only on a separate explicit user request/i);
    assert.match(text, /do not automatically retry|never automatically retry/i);
  }
});
