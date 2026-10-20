import {
  approvalToken,
  checkAbort,
  createMailBridge,
  isOperation,
  MailError,
  validateId,
} from "./bridge.ts";
import type { MailBridge, MailResult, Operation } from "./bridge.ts";

export interface ConfirmationContext {
  hasUI: boolean;
  ui: {
    confirm(
      title: string,
      message: string,
      options?: { signal?: AbortSignal; timeout?: number }
    ): Promise<boolean>;
  };
}
export type UntrustedMailResult = {
  untrustedContent: true;
  data: Exclude<MailResult, { kind: "inspect" }>;
};
export type ToolName = "mail_inbox" | "mail_read" | "mail_archive" | "mail_spam" | "mail_delete";

function parameters(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    throw new MailError(
      "INVALID_ARGUMENTS",
      "Unexpected tool arguments. No commands or confirmation flags are accepted."
    );
  }
  return value as Record<string, unknown>;
}
function display(value: string): string {
  let result = '"';
  const suffix = '…" [truncated]';
  for (const character of value) {
    const escaped = JSON.stringify(character).slice(1, -1).replace(
      /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
      (control) => "\\u" + control.charCodeAt(0).toString(16).padStart(4, "0")
    );
    if (result.length + escaped.length + suffix.length > 120) return result + suffix;
    result += escaped;
  }
  return result + '"';
}

export function parseConfirmationSetting(value: string | undefined): boolean {
  if (value === undefined || value === "on") return true;
  if (value === "off") return false;
  throw new MailError(
    "INVALID_CONFIGURATION",
    "PI_APPLE_MAIL_CONFIRMATIONS must be on or off, or unset for on."
  );
}

export function createMailTools(bridge: MailBridge = createMailBridge(), confirmations = true) {
  if (typeof confirmations !== "boolean")
    throw new MailError("INVALID_CONFIGURATION", "Confirmation configuration must be a boolean.");
  return async function execute(
    name: ToolName,
    input: unknown,
    context: ConfirmationContext,
    signal?: AbortSignal
  ): Promise<UntrustedMailResult> {
    checkAbort(signal);
    if (name === "mail_inbox") {
      const params = parameters(input, ["limit"]);
      const limit = params.limit ?? 10;
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
        throw new MailError("INVALID_ARGUMENTS", "Inbox limit must be an integer from 1 to 100.");
      }
      const data = await bridge.run({ action: "inbox", limit: limit as number }, signal);
      if (data.kind !== "inbox")
        throw new MailError("INVALID_RESPONSE", "Expected inbox metadata.");
      return { untrustedContent: true, data };
    }
    const params = parameters(input, ["id"]);
    validateId(params.id);
    const id = params.id;
    if (name === "mail_read") {
      const data = await bridge.run({ action: "read", id }, signal);
      if (data.kind !== "read")
        throw new MailError("INVALID_RESPONSE", "Expected a message read result.");
      return { untrustedContent: true, data };
    }
    const operation = name.slice("mail_".length);
    if (!isOperation(operation)) throw new MailError("INVALID_ARGUMENTS", "Unsupported Mail tool.");
    if (confirmations && (!context.hasUI || typeof context.ui?.confirm !== "function")) {
      throw new MailError(
        "CONFIRMATION_UNAVAILABLE",
        "Mailbox changes require a live confirmation dialog. No action taken."
      );
    }
    const preview = await bridge.run({ action: "inspect", operation, id }, signal);
    if (
      preview.kind !== "inspect" ||
      preview.operation !== operation ||
      preview.message.id !== id ||
      preview.approvalToken !== approvalToken(preview)
    ) {
      throw new MailError("INVALID_RESPONSE", "Could not identify the exact confirmation target.");
    }
    checkAbort(signal);
    if (confirmations) {
      const labels: Record<Operation, string> = {
        archive: "Archive message",
        spam: "Mark as spam",
        delete: "Move to Trash",
      };
      const confirmed = await context.ui.confirm(
        `${labels[operation]}?`,
        [
          "Untrusted message details:",
          `Account: ${display(preview.message.accountName)} (email(s), not recipients: ${display(preview.message.accountEmailAddresses.join(", ") || "unavailable")})`,
          `From: ${display(preview.message.sender)}`,
          `Subject: ${display(preview.message.subject)}`,
          `Received: ${display(preview.message.receivedAt)}`,
          `Destination: ${display(preview.destination)}${operation === "spam" ? " (marks as junk)" : ""}`,
        ].join("\n"),
        { signal, timeout: 60_000 }
      );
      checkAbort(signal);
      if (confirmed !== true)
        throw new MailError(
          "CONFIRMATION_DENIED",
          "Mailbox change was not confirmed. No action taken."
        );
    }
    const data = await bridge.run(
      { action: operation, id, approvalToken: preview.approvalToken },
      signal
    );
    if (
      data.kind !== "mutation" ||
      data.operation !== operation ||
      data.id !== id ||
      data.affectedCount !== 1
    ) {
      throw new MailError(
        "INVALID_RESPONSE",
        "Mail did not return the expected action result.",
        true
      );
    }
    return { untrustedContent: true, data };
  };
}
