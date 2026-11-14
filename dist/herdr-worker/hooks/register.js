// core/src/argv.ts
var argv = {
  run(p) {
    const args = ["run", "--json", "--bg", "--parent", p.parent, "--name", p.name, "--cwd", p.cwd];
    for (const [key, value] of Object.entries(p.labels ?? {})) args.push("--label", `${key}=${value}`);
    return [...args, ...p.command ? ["--", ...p.command] : [p.template, p.task]];
  },
  ls: (includeFinished = false) => ["ls", "--json", ...includeFinished ? ["--all"] : []],
  get: (address) => ["get", "--json", "--", address],
  send: (address, text2) => ["send", "--json", "--", address, text2],
  wait: (scope, timeoutMs) => ["wait", "--json", "--timeout", String(Math.ceil(timeoutMs / 1e3)), ...scope.address ? ["--", scope.address] : ["--children", scope.children ?? "any"]],
  read: (address, lines) => ["read", "--json", "--lines", String(lines), "--", address],
  kill: (address) => ["kill", "--json", "--", address],
  rm: (address) => ["rm", "--json", "--", address],
  templates: () => ["templates", "--json"]
};

// core/src/errors.ts
var codes = ["INVALID_INPUT", "NOT_IN_HERDR", "WRONG_ROLE", "HC_UNAVAILABLE", "HC_ERROR", "INVALID_RESPONSE", "PROCESS_TIMEOUT", "PERMISSION_REQUIRED", "PERMISSION_DENIED", "TEMPLATE_NOT_FOUND", "NAME_IN_USE", "INVALID_WORKTREE", "FIRST_MESSAGE_NOT_SENT", "SPAWN_OUTCOME_UNKNOWN", "NOT_FOUND", "AMBIGUOUS_ADDRESS", "NOT_CHILD", "BLOCKED", "FINISHED", "DELIVERY_UNKNOWN", "STOP_FAILED", "REMOVE_FAILED", "NO_PARENT", "PARENT_UNAVAILABLE", "REQUEST_ID_CONFLICT", "DELIVERY_PENDING", "JOURNAL_FULL"];
function success(data) {
  return { ok: true, data };
}
function failure(code, message, effect = "none", data = {}, details, hint = "Read the current state before retrying.") {
  return { ok: false, error: { code, message, hint, effect, ...details === void 0 ? {} : { details } }, data };
}
var Fault = class extends Error {
  constructor(code, message, details, effect = "none", data = {}) {
    super(message);
    this.code = code;
    this.details = details;
    this.effect = effect;
    this.data = data;
  }
  code;
  details;
  effect;
  data;
};

// core/src/parse.ts
function parse(result, effect = "none") {
  if (result.exitCode !== 0) {
    let details = result.stderr;
    try {
      details = JSON.parse(result.stderr);
    } catch {
    }
    const kind = details?.error?.kind?.toUpperCase();
    const code = codes.includes(kind) ? kind : "HC_ERROR";
    throw new Fault(code, "hc command failed.", { stderr: details, isStderrTruncated: result.isStderrTruncated }, effect);
  }
  if (result.isStdoutTruncated) throw new Fault("INVALID_RESPONSE", "hc JSON output was truncated.", void 0, effect);
  try {
    const value = JSON.parse(result.stdout);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Fault("INVALID_RESPONSE", "hc returned invalid JSON.", { stderr: result.stderr }, effect);
  }
}
function terminal(value) {
  if (typeof value.address !== "string" || !value.address || typeof value.state !== "string") throw new Fault("INVALID_RESPONSE", "Terminal address or state missing.");
  return { address: value.address, name: value.name ?? null, template: value.template ?? null, parent: value.parent ?? null, state: value.state, status: typeof value.status === "string" ? value.status : value.status?.state ?? null, cwd: value.cwd ?? null, turn: value.turn ?? null, firstMessage: firstMessage(value) ?? null, exitCode: value.exit_code ?? null, finishedMs: value.finished_ms ?? null, reason: value.reason ?? null, signal: value.signal ?? null };
}
function firstMessage(value) {
  const message = value.first_message;
  if (message === void 0) return void 0;
  if (!message || typeof message.sent !== "boolean") throw new Fault("INVALID_RESPONSE", "Invalid first_message.");
  return message;
}

// core/src/journal.ts
var ttlMs = 7 * 24 * 60 * 60 * 1e3;
var pendingProtectionMs = 10 * 60 * 1e3;
var journalBudgetBytes = 1024 * 1024;
function journalKey(sender, sessionId, recipient, requestId) {
  return JSON.stringify([sender, sessionId, recipient, requestId]);
}
function currentKey(key) {
  try {
    const parts = JSON.parse(key);
    return Array.isArray(parts) && parts.length === 4 && parts.every((part) => typeof part === "string");
  } catch {
    return false;
  }
}
function entryBytes(key, entry) {
  let bytes = 0;
  for (const character of JSON.stringify({ ["delivery:" + key]: entry })) {
    const point = character.codePointAt(0);
    bytes += point <= 127 ? 1 : point <= 2047 ? 2 : point <= 65535 ? 3 : 4;
  }
  return bytes;
}
async function removeUnchanged(journal, key, snapshot) {
  const current = await journal.get(key);
  if (!current) return true;
  if (current.timestamp !== snapshot.timestamp || current.status !== snapshot.status || current.payloadHash !== snapshot.payloadHash) return false;
  await journal.delete(key);
  return true;
}
async function prune(journal, now = Date.now(), incoming) {
  const reservedBytes = incoming ? entryBytes(...incoming) : 0;
  if (reservedBytes > journalBudgetBytes) throw new Fault("JOURNAL_FULL", "Delivery entry exceeds journal byte budget.");
  const entries = (await journal.entries()).filter(([key]) => key !== incoming?.[0]).sort((a, b) => a[1].timestamp - b[1].timestamp);
  const retained = [];
  let bytes = reservedBytes;
  const changed = /* @__PURE__ */ new Set();
  for (const [key, entry] of entries) {
    if (!currentKey(key) || now - entry.timestamp >= ttlMs) {
      if (await removeUnchanged(journal, key, entry)) continue;
      changed.add(key);
    }
    retained.push([key, entry]);
    bytes += entryBytes(key, entry);
  }
  let count = retained.length + (incoming ? 1 : 0);
  for (const [key, entry] of retained) {
    if (count <= 500 && bytes <= journalBudgetBytes) break;
    if (changed.has(key)) continue;
    if (entry.status === "pending" && now - entry.timestamp < pendingProtectionMs) continue;
    if (!await removeUnchanged(journal, key, entry)) continue;
    bytes -= entryBytes(key, entry);
    count--;
  }
  if (incoming && (count > 500 || bytes > journalBudgetBytes)) throw new Fault("JOURNAL_FULL", "Delivery journal is full of active pending entries.");
}
async function writeEntry(journal, key, entry) {
  await prune(journal, Date.now(), [key, entry]);
  await journal.set(key, entry);
}
function hash(text2) {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text2.length; i++) {
    a = Math.imul(a ^ text2.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ text2.charCodeAt(i);
  }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}

// core/src/client.ts
function text(value, label, max = 32768) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Fault("INVALID_INPUT", `Invalid ${label}.`);
}
function integer(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Fault("INVALID_INPUT", "Integer outside allowed range.");
}
var finished = (state) => ["finished", "exited", "dead"].includes(state);
var SPAWN_HINT = "Continue independent work. Worker reports, questions and emergency events arrive as separate hc input; call worker_list for a snapshot. done or idle do not prove success.";
var SEND_HINT = "Continue independent work. The report arrives as separate hc input; call worker_list to verify state. done or idle do not prove success.";
function createClient({ transport, context: context2, journal }) {
  let queue = Promise.resolve();
  let waiting = false;
  async function run(args, effect = "none", timeoutMs = 3e4, executable = context2.hcExecutable ?? "hc", cwd = context2.cwd) {
    try {
      return parse(await transport.run([executable, ...args], { cwd, timeoutMs }), effect);
    } catch (error) {
      if (error instanceof Fault) throw error;
      const message = String(error);
      throw new Fault(/timeout|timed out/i.test(message) ? "PROCESS_TIMEOUT" : /ENOENT|not found/i.test(message) ? "HC_UNAVAILABLE" : "HC_ERROR", message, void 0, effect);
    }
  }
  async function child(address) {
    text(address, "address", 256);
    const item = terminal(await run(argv.get(address)));
    if (address.includes("/") && !item.address.includes("/")) item.address = `${address.slice(0, address.lastIndexOf("/"))}/${item.address}`;
    if (item.parent !== context2.self) throw new Fault("NOT_CHILD", "Terminal belongs to another parent.");
    return item;
  }
  async function guarded(role, action) {
    try {
      if (!context2.self) throw new Fault("NOT_IN_HERDR", "No terminal address.");
      if (role === "owner" && context2.parent) throw new Fault("WRONG_ROLE", "Worker cannot manage terminals.");
      if (role === "worker" && !context2.parent) throw new Fault("NO_PARENT", "No parent address.");
      return await action();
    } catch (error) {
      return error instanceof Fault ? failure(error.code, error.message, error.effect, error.data, error.details, error.code === "JOURNAL_FULL" ? "Wait for active deliveries to finish, then retry with the same requestId." : void 0) : failure("HC_ERROR", String(error), "unknown");
    }
  }
  async function deliver(input, kind) {
    return guarded("worker", async () => {
      text(input.text, "text");
      if (input.requestId !== void 0) text(input.requestId, "requestId", 128);
      if (input.blocker !== void 0 && typeof input.blocker !== "boolean") throw new Fault("INVALID_INPUT", "Invalid blocker.");
      if (!journal) throw new Fault("HC_ERROR", "Delivery journal unavailable.");
      const implicit = input.requestId === void 0;
      const payloadHash = hash(`${kind}:
${input.text}`);
      const requestId = input.requestId ?? payloadHash;
      const key = journalKey(context2.self, context2.sessionId, context2.parent, requestId);
      const now = Date.now();
      const old = await journal.get(key);
      if (old && now - old.timestamp < (implicit ? 6e4 : 7 * 864e5)) {
        if (old.payloadHash !== payloadHash) return failure("REQUEST_ID_CONFLICT", "requestId already has another payload.");
        if (old.status === "sent" && old.result) return { ...old.result, data: { ...old.result.data, duplicate: true } };
        return failure(old.status === "pending" ? "DELIVERY_PENDING" : "DELIVERY_UNKNOWN", "Previous delivery outcome is unknown.", "unknown", { address: context2.parent, requestId, duplicate: true });
      }
      const entry = { sender: context2.self, sessionId: context2.sessionId, recipient: context2.parent, requestId, payloadHash, timestamp: now, implicit, status: "pending" };
      await writeEntry(journal, key, entry);
      const data = { address: context2.parent, delivery: "sent", requestId, duplicate: false };
      try {
        await run(argv.send(context2.parent, `${kind} [${requestId}]:
${input.text}`), "unknown");
        const result = success(data);
        await writeEntry(journal, key, { ...entry, status: "sent", result });
        return result;
      } catch (error) {
        try {
          await writeEntry(journal, key, { ...entry, status: "unknown" });
        } catch {
        }
        return failure("DELIVERY_UNKNOWN", "Parent delivery outcome is unknown.", "unknown", { ...data, delivery: "unknown" }, error instanceof Fault ? error.details ?? error.message : String(error));
      }
    });
  }
  function serialized(action) {
    const next = queue.then(action, action);
    queue = next.catch(() => void 0);
    return next;
  }
  return {
    spawn: (input = {}) => guarded("owner", async () => {
      const byTemplate = input.template !== void 0;
      if (byTemplate) {
        text(input.template, "template", 256);
        text(input.task, "task");
        if (input.template.startsWith("-") || input.command !== void 0) throw new Fault("INVALID_INPUT", "Invalid launch mode.");
      } else if (!Array.isArray(input.command) || !input.command.length || input.task !== void 0) throw new Fault("INVALID_INPUT", "Provide template and task or command argv.");
      if (!byTemplate) {
        for (const arg of input.command) text(arg, "command argument");
        if (input.command.length === 1 && /^[A-Za-z0-9._/-]+$/.exec(input.command[0])?.[0] !== input.command[0]) throw new Fault("INVALID_INPUT", "A single command element must match ^[A-Za-z0-9._/-]+$.");
      }
      if (input.cwd !== void 0 && input.worktree !== void 0) throw new Fault("INVALID_INPUT", "cwd and worktree are exclusive.");
      const cwd = input.worktree ?? input.cwd ?? context2.cwd;
      text(cwd, "cwd");
      if (!cwd.startsWith("/")) throw new Fault("INVALID_INPUT", "cwd must be absolute.");
      if (input.worktree !== void 0) {
        try {
          const response = await transport.run(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"], { cwd: context2.cwd, timeoutMs: 1e4 });
          if (response.exitCode !== 0 || response.isStdoutTruncated || response.stdout.trim() !== "true") throw new Error();
          const root = await transport.run(["git", "-C", cwd, "rev-parse", "--show-prefix"], { cwd: context2.cwd, timeoutMs: 1e4 });
          if (root.exitCode !== 0 || root.stdout.trim() !== "") throw new Error();
        } catch {
          throw new Fault("INVALID_WORKTREE", "Expected an existing checkout root.");
        }
      }
      const labels = input.labels ?? {};
      if (!labels || Array.isArray(labels) || typeof labels !== "object") throw new Fault("INVALID_INPUT", "Invalid labels.");
      for (const [key, value2] of Object.entries(labels)) {
        text(key, "label key");
        if (key.includes("=") || key.startsWith("herdr.")) throw new Fault("INVALID_INPUT", "Reserved or invalid label.");
        if (typeof value2 !== "string" || value2.includes("\0")) throw new Fault("INVALID_INPUT", "Invalid label value.");
      }
      let name = input.name;
      if (name === void 0) {
        const listing = await run(argv.ls());
        if (!Array.isArray(listing.terminals)) throw new Fault("INVALID_RESPONSE", "Missing terminals.");
        const base = byTemplate && /^[a-z0-9_-]{1,24}$/.test(input.template) ? input.template : "worker";
        let index = 1;
        while (listing.terminals.some((item) => item.name === `${base}-${index}`)) index++;
        name = `${base}-${index}`;
      }
      if (typeof name !== "string" || !/^[a-z0-9_-]{1,32}$/.test(name)) throw new Fault("INVALID_INPUT", "Invalid name.");
      let value;
      try {
        value = await run(argv.run({ parent: context2.self, name, cwd, labels, template: input.template, task: input.task, command: input.command }), "unknown", 21e4);
      } catch (error) {
        if (error instanceof Fault && ["NAME_IN_USE", "TEMPLATE_NOT_FOUND"].includes(error.code)) throw new Fault(error.code, error.message, error.details, "none");
        return failure("SPAWN_OUTCOME_UNKNOWN", "Spawn outcome is unknown.", "unknown", { name }, error instanceof Fault ? error.details ?? error.message : String(error));
      }
      if (typeof value.address !== "string") return failure("SPAWN_OUTCOME_UNKNOWN", "Missing spawned address.", "unknown", { name });
      let first;
      try {
        first = firstMessage(value);
      } catch {
        return failure("INVALID_RESPONSE", "Invalid first message result.", "applied", { address: value.address, name });
      }
      const data = { ...value, name, cwd, parent: context2.self, ...first ? { firstMessage: first } : {} };
      if (byTemplate && !first) return failure("INVALID_RESPONSE", "Missing first_message.", "applied", data);
      if (first?.sent === false) return failure("FIRST_MESSAGE_NOT_SENT", "Worker created; first task was not sent.", "applied", data, void 0, "Read the worker before sending its task.");
      return success({ ...data, hint: SPAWN_HINT });
    }),
    list: (input = {}) => guarded("owner", async () => {
      const includeFinished = input.includeFinished ?? false;
      if (typeof includeFinished !== "boolean") throw new Fault("INVALID_INPUT", "Invalid includeFinished.");
      if (input.address !== void 0) {
        const item = await child(input.address);
        if (!includeFinished && finished(item.state)) return failure("FINISHED", "Worker has finished.", "none", { address: item.address, state: item.state }, void 0, "Call worker_list with includeFinished: true for a final snapshot.");
        return success({ worker: item });
      }
      const value = await run(argv.ls(includeFinished));
      if (!Array.isArray(value.terminals)) throw new Fault("INVALID_RESPONSE", "Missing terminals.");
      return success({ workers: value.terminals.filter((item) => item.parent === context2.self && (includeFinished || !finished(item.state))).map(terminal) });
    }),
    send: (input) => guarded("owner", async () => {
      text(input.text, "text");
      const item = await child(input.address);
      if (item.status === "blocked") return failure("BLOCKED", "Worker is blocked.");
      if (finished(item.state)) return failure("FINISHED", "Worker has finished.");
      try {
        const value = await run(argv.send(item.address, input.text), "unknown");
        return success({ address: item.address, delivery: "sent", observation: value, hint: SEND_HINT });
      } catch (error) {
        return failure("DELIVERY_UNKNOWN", "Delivery outcome is unknown.", "unknown", { address: item.address }, error instanceof Fault ? error.details ?? error.message : String(error));
      }
    }),
    wait: (input = {}) => guarded("owner", async () => {
      if (input.address !== void 0 && input.children !== void 0) throw new Fault("INVALID_INPUT", "Choose address or children.");
      const timeoutMs = input.timeoutMs ?? 18e4;
      integer(timeoutMs, 1e3, 54e4);
      if (input.children !== void 0 && !["any", "all"].includes(input.children)) throw new Fault("INVALID_INPUT", "Invalid children scope.");
      const scope = input.address !== void 0 ? { address: (await child(input.address)).address } : { children: input.children ?? "any" };
      if (waiting) throw new Fault("INVALID_INPUT", "Another wait is active.");
      waiting = true;
      try {
        const value = await run(argv.wait(scope, timeoutMs), "none", timeoutMs + 3e4);
        if (typeof value.reason !== "string") throw new Fault("INVALID_RESPONSE", "Missing wait reason.");
        return success({ ...value, scope, observation: value.observation ?? { ...value, ...value.status !== void 0 ? { status: typeof value.status === "string" ? value.status : value.status?.state ?? null } : {} }, hint: value.reason === "message" ? "A message arrived as separate input. Continue your current work; call worker_list for a snapshot instead of waiting again." : "No news is a normal check-in. Continue independent work; call worker_list for a snapshot instead of waiting again." });
      } finally {
        waiting = false;
      }
    }),
    read: (input) => guarded("owner", async () => {
      const lines = input.lines ?? 100;
      integer(lines, 0, 1e3);
      const item = await child(input.address);
      const value = await run(argv.read(item.address, lines));
      if (typeof value.text !== "string") throw new Fault("INVALID_RESPONSE", "Missing read text.");
      return success({ ...value, address: item.address, text: value.text.slice(0, 65536), truncated: !!value.truncated || value.text.length > 65536 });
    }),
    stop: (input) => guarded("owner", async () => {
      if (input.remove !== void 0 && typeof input.remove !== "boolean") throw new Fault("INVALID_INPUT", "Invalid remove.");
      const item = await child(input.address);
      if (!finished(item.state)) {
        try {
          await run(argv.kill(item.address), "unknown");
        } catch (error) {
          return failure("STOP_FAILED", "Stop outcome is unknown.", "unknown", { address: item.address }, error instanceof Fault ? error.details ?? error.message : String(error));
        }
      }
      const data = { address: item.address, stopped: true, removed: false };
      if (input.remove) {
        try {
          await run(argv.rm(item.address), "unknown");
          data.removed = true;
        } catch (error) {
          return failure("REMOVE_FAILED", "Worker stopped; removal failed.", "applied", data, error instanceof Fault ? error.details ?? error.message : String(error));
        }
      }
      return success(data);
    }),
    templates: () => guarded("owner", async () => {
      const value = await run(argv.templates());
      if (!Array.isArray(value.templates)) throw new Fault("INVALID_RESPONSE", "Missing templates.");
      return success({ templates: value.templates });
    }),
    report: (input) => serialized(() => deliver(input, input.blocker ? "Blocker" : "Result")),
    askOwner: (input) => serialized(() => deliver(input, "Question"))
  };
}

// mods/shared/result.ts
function toolResult(envelope) {
  const result = JSON.stringify(envelope);
  return envelope.ok ? { result } : { result, isError: true };
}

// mods/worker/src/register.ts
var context = { cwd: "", sessionId: "" };
var deliveries = Promise.resolve();
function adapter($) {
  return { run: (argv2, options) => $.process.run(argv2, options) };
}
function journalAdapter($) {
  return {
    get: async (key) => await $.store.get("delivery:" + key),
    set: (key, entry) => $.store.set("delivery:" + key, entry),
    delete: (key) => $.store.delete("delivery:" + key),
    entries: async () => {
      const entries = [];
      for (const key of await $.store.keys()) if (key.startsWith("delivery:")) {
        const entry = await $.store.get(key);
        if (entry) entries.push([key.slice(9), entry]);
      }
      return entries;
    }
  };
}
const register = (on) => {
  on("session.start", async ($, e, next) => {
    const self = await $.env.get("HC_TERMINAL_ID");
    const parent = await $.env.get("HC_PARENT");
    context = { self, parent, cwd: await $.session.cwd(), sessionId: await $.session.id() };
    if (!self || !parent) return next(e);
    const journal = journalAdapter($);
    await prune(journal);
    for (const [key, entry] of await journal.entries()) if (entry.status === "pending" && entry.sender === self && entry.sessionId === context.sessionId) await writeEntry(journal, key, { ...entry, status: "unknown" });
    await $.tool.register({ "name": "report", "description": "Send result or blocker to parent. Reuse requestId on retry; new IDs can duplicate delivery. Without ID, deduplicate for 60 seconds including unknown outcomes, then allow another delivery. Explicit IDs keep unknown or pending outcomes until TTL (7 days), subject to journal eviction.", "inputSchema": { "type": "object", "additionalProperties": false, "properties": { "text": { "type": "string", "minLength": 1, "maxLength": 32768 }, "blocker": { "type": "boolean" }, "requestId": { "type": "string", "minLength": 1, "maxLength": 128 } }, "required": ["text"] }, "isDeferred": false });
    await $.tool.register({ "name": "ask_owner", "description": "Send question to parent without waiting for response. Reuse requestId on retry; new IDs can duplicate delivery. Without ID, unknown outcomes can be retried after 60 seconds. Explicit IDs keep unknown or pending outcomes until TTL (7 days), subject to journal eviction.", "inputSchema": { "type": "object", "additionalProperties": false, "properties": { "text": { "type": "string", "minLength": 1, "maxLength": 32768 }, "requestId": { "type": "string", "minLength": 1, "maxLength": 128 } }, "required": ["text"] }, "isDeferred": false });
    return next(e);
  });
  on("tool.call", { tool: "mcp__herdr-worker__report" }, async ($, e) => {
    if (!context.self) return toolResult(failure("NOT_IN_HERDR", "No terminal address."));
    if (e.agentId || !context.parent) return toolResult(failure("WRONG_ROLE", "Tool is unavailable in this role."));
    const input = Object.fromEntries(Object.entries(e).filter(([key]) => !["tool", "tool_use_id", "agentId", "requestMeta"].includes(key)));
    if (!input || typeof input !== "object" || Array.isArray(input)) return toolResult(failure("INVALID_INPUT", "Expected an input object."));
    if (Object.keys(input).some((key) => !["text", "blocker", "requestId"].includes(key))) return toolResult(failure("INVALID_INPUT", "Unknown input field."));
    const permission = await $.tool.check({ tool: e.tool, input });
    if (permission.decision !== "allow") return toolResult(failure(permission.decision === "ask" ? "PERMISSION_REQUIRED" : "PERMISSION_DENIED", permission.reason ?? "Permission required."));
    const client = createClient({ transport: adapter($), context: { ...context, sessionId: await $.session.id() }, journal: journalAdapter($) });
    const result = deliveries.then(() => client.report(input), () => client.report(input));
    deliveries = result.catch(() => void 0);
    return toolResult(await result);
  }).catch(() => toolResult(failure("HC_ERROR", "Tool handler failed.", "unknown")));
  on("tool.call", { tool: "mcp__herdr-worker__ask_owner" }, async ($, e) => {
    if (!context.self) return toolResult(failure("NOT_IN_HERDR", "No terminal address."));
    if (e.agentId || !context.parent) return toolResult(failure("WRONG_ROLE", "Tool is unavailable in this role."));
    const input = Object.fromEntries(Object.entries(e).filter(([key]) => !["tool", "tool_use_id", "agentId", "requestMeta"].includes(key)));
    if (!input || typeof input !== "object" || Array.isArray(input)) return toolResult(failure("INVALID_INPUT", "Expected an input object."));
    if (Object.keys(input).some((key) => !["text", "requestId"].includes(key))) return toolResult(failure("INVALID_INPUT", "Unknown input field."));
    const permission = await $.tool.check({ tool: e.tool, input });
    if (permission.decision !== "allow") return toolResult(failure(permission.decision === "ask" ? "PERMISSION_REQUIRED" : "PERMISSION_DENIED", permission.reason ?? "Permission required."));
    const client = createClient({ transport: adapter($), context: { ...context, sessionId: await $.session.id() }, journal: journalAdapter($) });
    const result = deliveries.then(() => client.askOwner(input), () => client.askOwner(input));
    deliveries = result.catch(() => void 0);
    return toolResult(await result);
  }).catch(() => toolResult(failure("HC_ERROR", "Tool handler failed.", "unknown")));
};
export {
  register
};
