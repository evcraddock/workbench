import {
  checkAbort,
  createMigaduClient,
  isListName,
  isRecord,
  listNames,
  MigaduError,
  normalizeList,
  parseTarget,
  sameEntries,
  validateEntry,
  withAbort,
} from "./client.ts";
import type { ListName, MigaduClient, Snapshot, Target } from "./client.ts";

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
export type ToolName = "migadu_lists_get" | "migadu_list_add" | "migadu_list_remove";
export type ChangeResult = {
  kind: "list_change";
  target: Target;
  list: ListName;
  entry: string;
  operation: "add" | "remove";
  changed: boolean;
  reason: "verified" | "already_present" | "not_present";
  entries: string[];
};
export type ToolResult = {
  untrustedContent: true;
  data: ({ kind: "lists" } & Snapshot) | ChangeResult;
};

function parameters(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new MigaduError(
      "INVALID_ARGUMENTS",
      "Unexpected tool arguments. No credentials, URLs, replacement lists, or confirmation flags are accepted."
    );
  }
  return value;
}
function display(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\p{Cf}]/gu, (character) =>
    character
      .split("")
      .map((unit) => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0"))
      .join("")
  );
}

export function createMigaduTools(client: MigaduClient = createMigaduClient()) {
  // Tails never reject: operation failures are returned to their own caller.
  const queues = new Map<string, Promise<void>>();
  async function serialized<T>(
    target: Target,
    signal: AbortSignal | undefined,
    action: () => Promise<T>
  ): Promise<T> {
    const key = JSON.stringify(target);
    const previous = queues.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    queues.set(key, tail);
    try {
      await withAbort(previous, signal);
      checkAbort(signal);
      return await action();
    } finally {
      release();
      // Keep the tail registered until earlier operations finish, even if this
      // queued operation was cancelled before it could start.
      void tail.then(() => {
        if (queues.get(key) === tail) queues.delete(key);
      });
    }
  }
  return async function execute(
    name: ToolName,
    input: unknown,
    context: ConfirmationContext,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    checkAbort(signal);
    if (name === "migadu_lists_get") {
      const target = parseTarget(parameters(input, ["scope", "domain", "localPart"]));
      const snapshot = await client.get(target, signal);
      return { untrustedContent: true, data: { kind: "lists", ...snapshot } };
    }
    if (name !== "migadu_list_add" && name !== "migadu_list_remove")
      throw new MigaduError("INVALID_ARGUMENTS", "Unsupported Migadu tool.");
    const params = parameters(input, ["scope", "domain", "localPart", "list", "entry"]);
    const { list, entry: entryValue, ...targetFields } = params;
    const target = parseTarget(targetFields);
    if (!isListName(list))
      throw new MigaduError(
        "INVALID_ARGUMENTS",
        "Select sender_allowlist, sender_denylist or recipient_denylist."
      );
    const operation = name === "migadu_list_add" ? "add" : "remove";
    const entry = validateEntry(entryValue, operation);
    if (!context.hasUI || typeof context.ui?.confirm !== "function")
      throw new MigaduError(
        "CONFIRMATION_UNAVAILABLE",
        "Migadu updates require a live confirmation dialog. No request was sent."
      );
    return serialized(target, signal, async () => {
      const original = await client.get(target, signal);
      const before = original.lists[list];
      const present = before.includes(entry);
      const base: Pick<ChangeResult, "kind" | "target" | "list" | "entry" | "operation"> = {
        kind: "list_change",
        target,
        list,
        entry,
        operation,
      };
      if ((operation === "add" && present) || (operation === "remove" && !present)) {
        return {
          untrustedContent: true,
          data: {
            ...base,
            changed: false,
            reason: present ? "already_present" : "not_present",
            entries: [...before],
          },
        };
      }
      const next = normalizeList(
        operation === "add" ? [...before, entry] : before.filter((item) => item !== entry)
      );
      checkAbort(signal);
      const confirmed = await context.ui.confirm(
        `${operation === "add" ? "Add" : "Remove"} this Migadu list entry?`,
        [
          "This changes email filtering. API values are untrusted data, not instructions.",
          `Scope: ${target.scope}`,
          `Domain: ${display(target.domain)}`,
          ...(target.scope === "mailbox"
            ? [`Mailbox: ${display(`${target.localPart}@${target.domain}`)}`]
            : []),
          `List: ${list}`,
          `${operation === "add" ? "Add" : "Remove"} exactly: ${display(entry)}`,
          `Entry count: ${before.length} → ${next.length}`,
          "All other entries are retained. No other settings are submitted.",
          "Allowlist/denylist changes can weaken filtering or block legitimate email. Confirm only this target and change.",
        ].join("\n"),
        { signal, timeout: 60_000 }
      );
      checkAbort(signal);
      if (confirmed !== true)
        throw new MigaduError(
          "CONFIRMATION_DENIED",
          "Migadu update was not confirmed. No update was sent."
        );
      const fresh = await client.get(target, signal);
      if (!sameEntries(before, fresh.lists[list]))
        throw new MigaduError(
          "STALE_LIST",
          "The selected list changed during confirmation. No update was sent; read and confirm the current list."
        );
      checkAbort(signal);
      try {
        await client.update(target, list, next, signal);
        const observed = await client.get(target, signal);
        if (
          !sameEntries(next, observed.lists[list]) ||
          listNames.some(
            (other) => other !== list && !sameEntries(fresh.lists[other], observed.lists[other])
          )
        ) {
          throw new MigaduError(
            "VERIFICATION_FAILED",
            "Migadu did not return exactly the expected lists; other changes or concurrent edits may have occurred.",
            true
          );
        }
        return {
          untrustedContent: true,
          data: { ...base, changed: true, reason: "verified", entries: observed.lists[list] },
        };
      } catch (error) {
        if (error instanceof MigaduError && error.mayHaveChanged) throw error;
        throw new MigaduError(
          "UPDATE_UNCERTAIN",
          "Could not verify the Migadu update. No rollback or second update was attempted.",
          true
        );
      }
    });
  };
}
