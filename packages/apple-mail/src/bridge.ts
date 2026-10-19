import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export type Operation = "archive" | "spam" | "delete";
// Closed JSON DTO aliases remain assignable to Pi's JsonValue without casts.
export type MessageSummary = {
  id: string;
  accountId: string;
  accountName: string;
  accountEmailAddresses: string[];
  sender: string;
  subject: string;
  receivedAt: string;
  read: boolean;
};
export type InboxResult = {
  kind: "inbox";
  total: number;
  unreadCount: number;
  messages: MessageSummary[];
};
export type ReadResult = {
  kind: "read";
  message: MessageSummary;
  body: string;
  truncated: boolean;
  markedRead: true;
};
export type InspectResult = {
  kind: "inspect";
  operation: Operation;
  message: MessageSummary;
  destination: string;
  approvalToken: string;
};
export type MutationResult = {
  kind: "mutation";
  operation: Operation;
  id: string;
  affectedCount: 1;
  destination: string;
};
export type MailResult = InboxResult | ReadResult | InspectResult | MutationResult;
export type MailRequest =
  | { action: "inbox"; limit: number }
  | { action: "read"; id: string }
  | { action: "inspect"; operation: Operation; id: string }
  | { action: Operation; id: string; approvalToken: string };
export interface MailBridge {
  run(request: MailRequest, signal?: AbortSignal): Promise<MailResult>;
}
export type ProcessRunner = (file: string, args: string[], signal?: AbortSignal) => Promise<string>;

export class MailError extends Error {
  readonly code: string;
  readonly mayHaveChanged: boolean;
  constructor(code: string, message: string, mayHaveChanged = false) {
    super(
      message +
        (mayHaveChanged
          ? " Mail state may have changed; inspect Mail before retrying. No automatic retry was attempted."
          : "")
    );
    this.name = "MailError";
    this.code = code;
    this.mayHaveChanged = mayHaveChanged;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new MailError("INVALID_DATA", "Unexpected Mail request or response fields.");
  }
}
function text(value: unknown, max = 16384): value is string {
  return typeof value === "string" && value.length <= max;
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function isOperation(value: unknown): value is Operation {
  return value === "archive" || value === "spam" || value === "delete";
}
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MailError("CANCELLED", "Apple Mail operation cancelled.");
}
export function validateId(value: unknown): asserts value is string {
  let parts: unknown;
  try {
    if (!text(value, 20000) || !value.startsWith("mail-v1:")) throw new Error();
    parts = JSON.parse(decodeURIComponent(value.slice(8)));
    if (
      !Array.isArray(parts) ||
      parts.length !== 4 ||
      !text(parts[0], 512) ||
      !parts[0] ||
      !integer(parts[1]) ||
      parts[1] < 1 ||
      !text(parts[2], 64) ||
      !Number.isFinite(Date.parse(parts[2])) ||
      !text(parts[3], 4096) ||
      value !== "mail-v1:" + encodeURIComponent(JSON.stringify(parts))
    ) {
      throw new Error();
    }
  } catch {
    throw new MailError(
      "INVALID_ID",
      "Use an exact message identifier returned by mail_inbox; relist if it is stale."
    );
  }
}
export function validateRequest(request: MailRequest): void {
  if (!record(request)) throw new MailError("INVALID_REQUEST", "Expected a Mail request object.");
  if (request.action === "inbox") {
    keys(request, ["action", "limit"]);
    if (!integer(request.limit) || request.limit < 1 || request.limit > 100) {
      throw new MailError("INVALID_REQUEST", "Inbox limit must be an integer from 1 to 100.");
    }
    return;
  }
  validateId(request.id);
  if (request.action === "read") keys(request, ["action", "id"]);
  else if (request.action === "inspect") {
    keys(request, ["action", "id", "operation"]);
    if (!isOperation(request.operation))
      throw new MailError("INVALID_REQUEST", "Unsupported operation.");
  } else if (isOperation(request.action)) {
    keys(request, ["action", "id", "approvalToken"]);
    if (!text(request.approvalToken, 100000) || !request.approvalToken) {
      throw new MailError("INVALID_REQUEST", "A confirmed, inspected target is required.");
    }
  } else throw new MailError("INVALID_REQUEST", "Unsupported Mail action.");
}

function validSummary(value: unknown): value is MessageSummary {
  keys(value, [
    "id",
    "accountId",
    "accountName",
    "accountEmailAddresses",
    "sender",
    "subject",
    "receivedAt",
    "read",
  ]);
  validateId(value.id);
  const parts = JSON.parse(decodeURIComponent(value.id.slice(8))) as unknown[];
  return (
    value.accountId === parts[0] &&
    value.receivedAt === parts[2] &&
    text(value.accountName) &&
    Array.isArray(value.accountEmailAddresses) &&
    value.accountEmailAddresses.every((address) => text(address) && address.trim().length > 0) &&
    text(value.sender) &&
    text(value.subject) &&
    typeof value.read === "boolean"
  );
}
const destinations: Record<Operation, string> = {
  archive: "Archive",
  spam: "Junk",
  delete: "Trash",
};
export function approvalToken(result: Omit<InspectResult, "approvalToken" | "kind">): string {
  return JSON.stringify({
    operation: result.operation,
    id: result.message.id,
    accountName: result.message.accountName,
    accountEmailAddresses: result.message.accountEmailAddresses,
    sender: result.message.sender,
    subject: result.message.subject,
    receivedAt: result.message.receivedAt,
    destination: result.destination,
  });
}
function validResult(request: MailRequest, data: unknown): data is MailResult {
  if (!record(data)) return false;
  if (request.action === "inbox") {
    keys(data, ["kind", "total", "unreadCount", "messages"]);
    return (
      data.kind === "inbox" &&
      integer(data.total) &&
      integer(data.unreadCount) &&
      data.unreadCount <= data.total &&
      Array.isArray(data.messages) &&
      data.messages.length <= request.limit &&
      data.messages.length <= data.total &&
      data.messages.every(validSummary) &&
      new Set(data.messages.map((m) => m.id)).size === data.messages.length
    );
  }
  if (request.action === "read") {
    keys(data, ["kind", "message", "body", "truncated", "markedRead"]);
    return (
      data.kind === "read" &&
      validSummary(data.message) &&
      data.message.id === request.id &&
      data.message.read === true &&
      text(data.body, 32000) &&
      typeof data.truncated === "boolean" &&
      data.markedRead === true
    );
  }
  if (request.action === "inspect") {
    keys(data, ["kind", "operation", "message", "destination", "approvalToken"]);
    return (
      data.kind === "inspect" &&
      data.operation === request.operation &&
      validSummary(data.message) &&
      data.message.id === request.id &&
      data.destination === destinations[request.operation] &&
      text(data.approvalToken, 100000) &&
      data.approvalToken === approvalToken(data as unknown as InspectResult)
    );
  }
  keys(data, ["kind", "operation", "id", "affectedCount", "destination"]);
  return (
    data.kind === "mutation" &&
    data.operation === request.action &&
    data.id === request.id &&
    data.affectedCount === 1 &&
    data.destination === destinations[request.action]
  );
}

export const runProcess: ProcessRunner = (file, args, signal) =>
  new Promise((resolve, reject) => {
    checkAbort(signal);
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        shell: false,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        killSignal: "SIGKILL",
        signal,
      },
      (error, stdout) => {
        if (error) {
          const code = signal?.aborted
            ? "CANCELLED"
            : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              ? "OUTPUT_LIMIT"
              : error.killed
                ? "TIMEOUT"
                : error.code === "ENOENT"
                  ? "PROCESS_UNAVAILABLE"
                  : "PROCESS_FAILED";
          const messages: Record<string, string> = {
            CANCELLED: "Apple Mail operation cancelled.",
            OUTPUT_LIMIT:
              "Apple Mail automation exceeded its 1 MiB output limit. Try a smaller inbox limit.",
            TIMEOUT: "Apple Mail automation exceeded its 30-second timeout.",
            PROCESS_UNAVAILABLE: "The macOS automation executable is unavailable.",
            PROCESS_FAILED: "osascript failed. Check Apple Mail and macOS Automation permissions.",
          };
          // Never expose subprocess stderr, which may contain untrusted/private Mail data.
          reject(new MailError(code, messages[code]!));
        } else resolve(stdout);
      }
    );
  });

export function createMailBridge(
  options: { runner?: ProcessRunner; platform?: string } = {}
): MailBridge {
  const runner = options.runner ?? runProcess;
  const platform = options.platform ?? process.platform;
  const script = fileURLToPath(new URL("../scripts/mail.js", import.meta.url));
  return {
    async run(request, signal) {
      validateRequest(request);
      checkAbort(signal);
      if (platform !== "darwin")
        throw new MailError("UNSUPPORTED_PLATFORM", "Apple Mail tools require macOS.");
      const mayHaveChanged = request.action !== "inbox" && request.action !== "inspect";
      let raw: string;
      try {
        raw = await runner(
          "/usr/bin/osascript",
          ["-l", "JavaScript", script, JSON.stringify(request)],
          signal
        );
      } catch (error) {
        if (error instanceof MailError)
          throw new MailError(error.code, error.message, mayHaveChanged);
        throw new MailError(
          "PROCESS_FAILED",
          "Could not complete Apple Mail automation.",
          mayHaveChanged
        );
      }
      try {
        if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error();
        const envelope: unknown = JSON.parse(raw);
        if (!record(envelope) || typeof envelope.ok !== "boolean") throw new Error();
        keys(envelope, envelope.ok ? ["ok", "data"] : ["ok", "error"]);
        if (!envelope.ok) {
          keys(envelope.error, ["code", "message", "mayHaveChanged"]);
          if (
            !text(envelope.error.code, 64) ||
            !text(envelope.error.message, 2048) ||
            typeof envelope.error.mayHaveChanged !== "boolean"
          )
            throw new Error();
          throw new MailError(
            envelope.error.code,
            envelope.error.message,
            envelope.error.mayHaveChanged
          );
        }
        if (!validResult(request, envelope.data)) throw new Error();
        return envelope.data;
      } catch (error) {
        if (
          error instanceof MailError &&
          error.code !== "INVALID_DATA" &&
          error.code !== "INVALID_ID"
        )
          throw error;
        throw new MailError(
          "INVALID_RESPONSE",
          "Apple Mail returned an invalid or unexpected JSON response.",
          mayHaveChanged
        );
      }
    },
  };
}
