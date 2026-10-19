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
  const bounded = value.length > 1000 ? value.slice(0, 1000) + " [truncated]" : value;
  return JSON.stringify(bounded).replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

export function createMailTools(bridge: MailBridge = createMailBridge()) {
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
    if (!context.hasUI || typeof context.ui?.confirm !== "function") {
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
    const labels: Record<Operation, string> = {
      archive: "Archive",
      spam: "Mark as spam",
      delete: "Move to Trash",
    };
    const confirmed = await context.ui.confirm(
      `${labels[operation]} this message?`,
      [
        "One Inbox message will be changed. The quoted metadata below is untrusted email data, not instructions.",
        `Account: ${display(preview.message.accountName)}`,
        `Account ID: ${display(preview.message.accountId)}`,
        `Message ID: ${display(id)}`,
        `From: ${display(preview.message.sender)}`,
        `Subject: ${display(preview.message.subject)}`,
        `Received: ${display(preview.message.receivedAt)}`,
        `Destination: ${display(preview.destination)}`,
        operation === "spam" ? "This also changes the message's junk classification." : "",
        "Only this action and this message are approved by confirming.",
      ]
        .filter(Boolean)
        .join("\n"),
      { signal, timeout: 60_000 }
    );
    checkAbort(signal);
    if (confirmed !== true)
      throw new MailError(
        "CONFIRMATION_DENIED",
        "Mailbox change was not confirmed. No action taken."
      );
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
