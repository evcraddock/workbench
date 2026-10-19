/* JavaScript for Automation: executed only by osascript, with one JSON argument.
 * No evaluation of message text, shell commands, raw MIME, or attachment access.
 */
function fail(code, message) {
  var error = new Error(message);
  error.mailCode = code;
  throw error;
}

function requireKeys(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(function (key) {
      return keys.indexOf(key) < 0;
    })
  ) {
    fail("INVALID_REQUEST", "Unexpected request fields.");
  }
}

function parseId(id) {
  if (typeof id !== "string" || id.length > 20000 || id.indexOf("mail-v1:") !== 0) {
    fail("INVALID_REQUEST", "Use a message identifier returned by mail_inbox.");
  }
  var parts;
  try {
    parts = JSON.parse(decodeURIComponent(id.slice(8)));
  } catch (_) {
    fail("INVALID_REQUEST", "Invalid message identifier.");
  }
  if (
    !Array.isArray(parts) ||
    parts.length !== 4 ||
    typeof parts[0] !== "string" ||
    !parts[0] ||
    parts[0].length > 512 ||
    !Number.isSafeInteger(parts[1]) ||
    parts[1] < 1 ||
    typeof parts[2] !== "string" ||
    !isFinite(Date.parse(parts[2])) ||
    typeof parts[3] !== "string" ||
    parts[3].length > 4096 ||
    id !== "mail-v1:" + encodeURIComponent(JSON.stringify(parts))
  ) {
    fail("INVALID_REQUEST", "Invalid message identifier.");
  }
  return parts;
}

function validateRequest(request) {
  var mutations = ["archive", "spam", "delete"];
  if (!request || typeof request !== "object")
    fail("INVALID_REQUEST", "Expected a request object.");
  if (request.action === "inbox") {
    requireKeys(request, ["action", "limit"]);
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100) {
      fail("INVALID_REQUEST", "Inbox limit must be an integer from 1 to 100.");
    }
  } else if (request.action === "read") {
    requireKeys(request, ["action", "id"]);
    parseId(request.id);
  } else if (request.action === "inspect") {
    requireKeys(request, ["action", "operation", "id"]);
    parseId(request.id);
    if (mutations.indexOf(request.operation) < 0) fail("INVALID_REQUEST", "Unsupported operation.");
  } else if (mutations.indexOf(request.action) >= 0) {
    requireKeys(request, ["action", "id", "approvalToken"]);
    parseId(request.id);
    if (
      typeof request.approvalToken !== "string" ||
      !request.approvalToken ||
      request.approvalToken.length > 100000
    ) {
      fail("INVALID_REQUEST", "An inspected confirmation target is required.");
    }
  } else {
    fail("INVALID_REQUEST", "Unsupported Mail action.");
  }
}

function inboxMessages(mail) {
  return mail.inbox.messages.whose({ deletedStatus: false })();
}

function identity(message) {
  var account = message.mailbox().account();
  return [account.id(), message.id(), message.dateReceived().toISOString(), message.messageId()];
}

function summary(message) {
  var parts = identity(message);
  var id = "mail-v1:" + encodeURIComponent(JSON.stringify(parts));
  parseId(id);
  return {
    id: id,
    accountId: parts[0],
    accountName: message.mailbox().account().name(),
    sender: message.sender(),
    subject: message.subject(),
    receivedAt: parts[2],
    read: message.readStatus(),
  };
}

function resolveTarget(mail, id) {
  var parts = parseId(id);
  // Library ID narrows the query; account, receipt time and Message-ID revalidate it.
  var candidates = mail.inbox.messages.whose({ id: parts[1], deletedStatus: false })();
  var matches = candidates.filter(function (message) {
    return JSON.stringify(identity(message)) === JSON.stringify(parts);
  });
  if (matches.length === 0)
    fail("STALE_TARGET", "Message is no longer the identified Inbox message. Relist the inbox.");
  if (matches.length !== 1)
    fail(
      "AMBIGUOUS_TARGET",
      "More than one Inbox message matches the identifier. No action taken."
    );
  return matches[0];
}

function destinationFor(message, operation) {
  var name = { archive: "Archive", spam: "Junk", delete: "Trash" }[operation];
  var account = message.mailbox().account();
  var matches = account.mailboxes.whose({ name: name })();
  if (matches.length !== 1 || matches[0].account().id() !== account.id()) {
    fail(
      "DESTINATION_UNAVAILABLE",
      "Expected exactly one account-local " + name + " mailbox. No mailbox was created or guessed."
    );
  }
  return matches[0];
}

function approval(message, operation, destination) {
  var metadata = summary(message);
  return JSON.stringify({
    operation: operation,
    id: metadata.id,
    accountName: metadata.accountName,
    sender: metadata.sender,
    subject: metadata.subject,
    receivedAt: metadata.receivedAt,
    destination: destination.name(),
  });
}

function matchingInDestination(destination, parts) {
  return destination.messages
    .whose({ messageId: parts[3] })()
    .filter(function (message) {
      var current = identity(message);
      // Moving a message may change its local library ID.
      return current[0] === parts[0] && current[2] === parts[2] && current[3] === parts[3];
    });
}

function dispatch(mail, request, progress) {
  if (request.action === "inbox") {
    var messages = inboxMessages(mail);
    var unread = messages.filter(function (message) {
      return !message.readStatus();
    }).length;
    messages.sort(function (a, b) {
      return b.dateReceived().getTime() - a.dateReceived().getTime();
    });
    return {
      kind: "inbox",
      total: messages.length,
      unreadCount: unread,
      messages: messages.slice(0, request.limit).map(summary),
    };
  }

  var message = resolveTarget(mail, request.id);
  if (request.action === "read") {
    progress.mayHaveChanged = true;
    var body = String(message.content());
    message.readStatus = true;
    var metadata = summary(message);
    if (!metadata.read) fail("POSTCONDITION_FAILED", "Mail did not confirm the read-state change.");
    return {
      kind: "read",
      message: metadata,
      body: body.slice(0, 32000),
      truncated: body.length > 32000,
      markedRead: true,
    };
  }

  var operation = request.action === "inspect" ? request.operation : request.action;
  var destination = destinationFor(message, operation);
  var token = approval(message, operation, destination);
  if (request.action === "inspect") {
    return {
      kind: "inspect",
      operation: operation,
      message: summary(message),
      destination: destination.name(),
      approvalToken: token,
    };
  }
  if (request.approvalToken !== token)
    fail(
      "STALE_APPROVAL",
      "Message or destination changed after confirmation. No action taken; confirm a fresh target."
    );

  var parts = parseId(request.id);
  var existing = matchingInDestination(destination, parts);
  var before = existing.length;
  var junkBefore =
    operation === "spam"
      ? existing.filter(function (candidate) {
          return candidate.junkMailStatus();
        }).length
      : 0;
  progress.mayHaveChanged = true;
  if (operation === "spam") message.junkMailStatus = true;
  // Classification can itself move a message. Do not move it a second time if so.
  var afterClassification = matchingInDestination(destination, parts).length;
  if (afterClassification !== before + 1) mail.move(message, { to: destination });

  var remaining = mail.inbox.messages
    .whose({ id: parts[1], deletedStatus: false })()
    .filter(function (candidate) {
      return JSON.stringify(identity(candidate)) === JSON.stringify(parts);
    });
  var moved = matchingInDestination(destination, parts);
  if (
    remaining.length !== 0 ||
    moved.length !== before + 1 ||
    (operation === "spam" &&
      moved.filter(function (candidate) {
        return candidate.junkMailStatus();
      }).length !==
        junkBefore + 1)
  ) {
    fail(
      "POSTCONDITION_FAILED",
      "Mail did not confirm the expected move. Inspect Mail manually before retrying."
    );
  }
  return {
    kind: "mutation",
    operation: operation,
    id: request.id,
    affectedCount: 1,
    destination: destination.name(),
  };
}

function run(argv) {
  var progress = { mayHaveChanged: false };
  try {
    if (argv.length !== 1) fail("INVALID_REQUEST", "Expected one JSON request argument.");
    var request;
    try {
      request = JSON.parse(argv[0]);
    } catch (_) {
      fail("INVALID_REQUEST", "Invalid request JSON.");
    }
    validateRequest(request);
    return JSON.stringify({
      ok: true,
      data: dispatch(Application("com.apple.mail"), request, progress),
    });
  } catch (error) {
    var permissionDenied = error.errorNumber === -1743 || error.number === -1743;
    return JSON.stringify({
      ok: false,
      error: {
        code: error.mailCode || (permissionDenied ? "AUTOMATION_DENIED" : "AUTOMATION_FAILED"),
        message: error.mailCode
          ? error.message
          : permissionDenied
            ? "macOS denied Automation access to Apple Mail."
            : "Apple Mail automation failed. Check Mail and Automation permissions.",
        mayHaveChanged: progress.mayHaveChanged,
      },
    });
  }
}
