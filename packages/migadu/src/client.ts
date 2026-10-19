import { domainToASCII } from "node:url";

export const listNames = ["sender_allowlist", "sender_denylist", "recipient_denylist"] as const;
export type ListName = (typeof listNames)[number];
export type Target =
  | { scope: "domain"; domain: string }
  | { scope: "mailbox"; domain: string; localPart: string };
export type Lists = Record<ListName, string[]>;
export type Snapshot = { target: Target; lists: Lists };
export type Credentials = { user: string; apiKey: string };
export interface MigaduClient {
  get(target: Target, signal?: AbortSignal): Promise<Snapshot>;
  update(target: Target, list: ListName, entries: string[], signal?: AbortSignal): Promise<void>;
}

export class MigaduError extends Error {
  readonly code: string;
  readonly mayHaveChanged: boolean;
  constructor(code: string, message: string, mayHaveChanged = false) {
    super(
      message +
        (mayHaveChanged
          ? " Migadu state may have changed. Read the lists before retrying; no automatic retry was attempted."
          : "")
    );
    this.name = "MigaduError";
    this.code = code;
    this.mayHaveChanged = mayHaveChanged;
  }
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MigaduError("CANCELLED", "Migadu operation cancelled.");
}
export function isListName(value: unknown): value is ListName {
  return typeof value === "string" && (listNames as readonly string[]).includes(value);
}
function domainName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    /[\s/@:%\\?#]/u.test(value)
  ) {
    throw new MigaduError(
      "INVALID_ARGUMENTS",
      "Specify a DNS domain name, not a URL, address, or path."
    );
  }
  const ascii = domainToASCII(value).toLowerCase();
  if (
    !ascii ||
    ascii.length > 253 ||
    !ascii.includes(".") ||
    !ascii.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new MigaduError("INVALID_ARGUMENTS", "Specify a valid DNS domain name.");
  }
  return ascii;
}
export function parseTarget(value: unknown): Target {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["scope", "domain", "localPart"].includes(key))
  ) {
    throw new MigaduError(
      "INVALID_ARGUMENTS",
      "Specify only scope, domain, and an optional mailbox localPart."
    );
  }
  const domain = domainName(value.domain);
  if (value.scope === "domain" && !Object.hasOwn(value, "localPart"))
    return { scope: "domain", domain };
  if (
    value.scope === "mailbox" &&
    typeof value.localPart === "string" &&
    value.localPart.length <= 64 &&
    /^[A-Za-z0-9_+\-]+(?:\.[A-Za-z0-9_+\-]+)*$/.test(value.localPart)
  ) {
    return { scope: "mailbox", domain, localPart: value.localPart };
  }
  throw new MigaduError(
    "INVALID_ARGUMENTS",
    "Domain scope must omit localPart. Mailbox scope requires a local part using letters, digits, dots, underscores, plus or hyphen, not a full address or path."
  );
}
export function validateEntry(value: unknown, operation: "add" | "remove" = "add"): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2048 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    (operation === "add" && /[\s,;]/u.test(value))
  ) {
    throw new MigaduError(
      "INVALID_ARGUMENTS",
      "Specify one nonempty, control-free entry of at most 2,048 characters. Additions cannot contain whitespace, commas or semicolons; removals match one existing value exactly, never a bulk string."
    );
  }
  return value;
}
export function normalizeList(value: unknown): string[] {
  let entries: unknown[];
  if (value === "") entries = [];
  else if (typeof value === "string" && value.length <= 2048 && !/[\s,;]/u.test(value))
    entries = [value];
  else if (Array.isArray(value)) entries = value;
  else
    throw new MigaduError(
      "INVALID_RESPONSE",
      "Migadu returned an unsupported or ambiguous list representation. No delimiter format was guessed."
    );
  if (
    entries.length > 10000 ||
    !entries.every(
      (entry): entry is string =>
        typeof entry === "string" &&
        entry.length > 0 &&
        entry.length <= 2048 &&
        entry === entry.trim() &&
        !/[\u0000-\u001f\u007f-\u009f]/u.test(entry)
    ) ||
    new Set(entries).size !== entries.length
  ) {
    throw new MigaduError("INVALID_RESPONSE", "Migadu returned invalid or duplicate list entries.");
  }
  return [...entries] as string[];
}
export function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((entry) => right.includes(entry))
  );
}
function readCredentials(get: () => Credentials): Credentials {
  let credentials: Credentials;
  try {
    credentials = get();
  } catch {
    throw new MigaduError(
      "CONFIGURATION_ERROR",
      "Configure MIGADU_USER and MIGADU_API_KEY locally; never provide them as tool arguments."
    );
  }
  if (
    !credentials ||
    typeof credentials.user !== "string" ||
    credentials.user.length > 320 ||
    !/^[^@\s:]+@[^@\s:]+$/.test(credentials.user) ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(credentials.user) ||
    typeof credentials.apiKey !== "string" ||
    !credentials.apiKey ||
    credentials.apiKey.length > 4096 ||
    /[\s\u0000-\u001f\u007f-\u009f]/u.test(credentials.apiKey)
  ) {
    throw new MigaduError(
      "CONFIGURATION_ERROR",
      "Configure valid MIGADU_USER and MIGADU_API_KEY values locally; never provide them as tool arguments."
    );
  }
  return credentials;
}
export async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  let abort: () => void = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(new MigaduError("CANCELLED", "Migadu operation cancelled."));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      // Observe the underlying promise even if cancellation won the race.
      promise.then(resolve, reject);
    });
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
async function readJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json" ||
    !response.body
  ) {
    throw new MigaduError("INVALID_RESPONSE", "Migadu did not return a JSON response body.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let body = "";
  try {
    while (true) {
      const chunk = await withAbort(reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1024 * 1024)
        throw new MigaduError("INVALID_RESPONSE", "Migadu response exceeded the 1 MiB limit.");
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      throw new MigaduError("INVALID_RESPONSE", "Migadu returned invalid JSON.");
    }
    if (!isRecord(value))
      throw new MigaduError("INVALID_RESPONSE", "Migadu returned an unexpected JSON structure.");
    return value;
  } catch (error) {
    try {
      await withAbort(reader.cancel(), signal);
    } catch {
      throw new MigaduError(
        "INVALID_RESPONSE",
        "Migadu response could not be safely consumed or closed."
      );
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}
function containsCredential(value: string, credentials: Credentials): boolean {
  return (
    value.includes(credentials.apiKey) ||
    value.includes(
      Buffer.from(`${credentials.user}:${credentials.apiKey}`, "utf8").toString("base64")
    )
  );
}
function parseSnapshot(
  value: Record<string, unknown>,
  target: Target,
  credentials: Credentials
): Snapshot {
  let matches = false;
  try {
    if (target.scope === "domain") matches = domainName(value.name) === target.domain;
    else {
      const domain = domainName(value.domain_name ?? value.domain);
      matches =
        domain === target.domain &&
        value.local_part === target.localPart &&
        (!Object.hasOwn(value, "domain") || domainName(value.domain) === target.domain) &&
        (!Object.hasOwn(value, "domain_name") || domainName(value.domain_name) === target.domain) &&
        (!Object.hasOwn(value, "address") ||
          value.address === `${target.localPart}@${target.domain}`);
    }
  } catch {
    matches = false;
  }
  if (!matches)
    throw new MigaduError(
      "TARGET_MISMATCH",
      "Migadu returned a different or unidentified domain/mailbox. No target was guessed."
    );
  const lists: Lists = {
    sender_allowlist: normalizeList(value.sender_allowlist),
    sender_denylist: normalizeList(value.sender_denylist),
    recipient_denylist: normalizeList(value.recipient_denylist),
  };
  if (containsCredential(JSON.stringify({ target, lists }), credentials)) {
    throw new MigaduError(
      "INVALID_RESPONSE",
      "Migadu returned credential material in filtering data. Response withheld."
    );
  }
  return { target, lists };
}

export function createMigaduClient(
  options: {
    fetch?: typeof globalThis.fetch;
    credentials?: () => Credentials;
    timeoutMs?: number;
  } = {}
): MigaduClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  const getCredentials =
    options.credentials ??
    (() => ({ user: process.env.MIGADU_USER ?? "", apiKey: process.env.MIGADU_API_KEY ?? "" }));
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new MigaduError(
      "CONFIGURATION_ERROR",
      "Request timeout must be between 1 and 30,000 milliseconds."
    );

  async function request(
    target: Target,
    update: { list: ListName; entries: string[] } | undefined,
    signal?: AbortSignal
  ): Promise<Snapshot | undefined> {
    checkAbort(signal);
    const credentials = readCredentials(getCredentials);
    if (update?.entries.some((entry) => containsCredential(entry, credentials))) {
      throw new MigaduError(
        "INVALID_ARGUMENTS",
        "Credential material cannot be used as a filtering entry."
      );
    }
    const url =
      "https://api.migadu.com/v1/domains/" +
      encodeURIComponent(target.domain) +
      (target.scope === "mailbox" ? "/mailboxes/" + encodeURIComponent(target.localPart) : "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let writeIssued = false;
    try {
      const init: RequestInit = {
        method: update ? (target.scope === "domain" ? "PATCH" : "PUT") : "GET",
        headers: {
          accept: "application/json",
          authorization:
            "Basic " +
            Buffer.from(`${credentials.user}:${credentials.apiKey}`, "utf8").toString("base64"),
          ...(update ? { "content-type": "application/json" } : {}),
        },
        ...(update ? { body: JSON.stringify({ [update.list]: update.entries }) } : {}),
        redirect: "error",
        credentials: "omit",
        signal: combined,
      };
      writeIssued = !!update;
      const response = await withAbort(fetcher(url, init), combined);
      if (response.url && response.url !== url)
        throw new MigaduError(
          "INVALID_RESPONSE",
          "Migadu response did not match the fixed request URL."
        );
      if (!response.ok) {
        await withAbort(response.body?.cancel() ?? Promise.resolve(), combined);
        const code =
          response.status === 401 || response.status === 403
            ? "AUTHORIZATION_FAILED"
            : response.status === 429
              ? "RATE_LIMITED"
              : "HTTP_ERROR";
        throw new MigaduError(
          code,
          `Migadu request failed (HTTP ${response.status}). Server response text was withheld.`
        );
      }
      const value = await readJson(response, combined);
      return update ? undefined : parseSnapshot(value, target, credentials);
    } catch (error) {
      if (signal?.aborted)
        throw new MigaduError("CANCELLED", "Migadu operation cancelled.", writeIssued);
      if (controller.signal.aborted)
        throw new MigaduError("TIMEOUT", "Migadu request exceeded its time limit.", writeIssued);
      if (error instanceof MigaduError)
        throw new MigaduError(error.code, error.message, writeIssued || error.mayHaveChanged);
      throw new MigaduError(
        "NETWORK_ERROR",
        "Migadu request failed. Transport details were withheld to protect credentials.",
        writeIssued
      );
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
  return {
    async get(value, signal) {
      const target = parseTarget(value);
      const snapshot = await request(target, undefined, signal);
      if (!snapshot)
        throw new MigaduError("INVALID_RESPONSE", "No Migadu filtering snapshot returned.");
      return snapshot;
    },
    async update(value, list, entries, signal) {
      const target = parseTarget(value);
      if (!isListName(list) || !Array.isArray(entries))
        throw new MigaduError(
          "INVALID_ARGUMENTS",
          "Only the three supported filtering lists may be updated."
        );
      const normalized = normalizeList(entries);
      await request(target, { list, entries: normalized }, signal);
    },
  };
}
