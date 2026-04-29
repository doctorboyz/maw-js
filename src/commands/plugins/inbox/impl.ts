/**
 * inbox impl — MSG-ACK-RESULT protocol for cross-oracle vault messaging.
 *
 * Vault-based message protocol with acknowledgment and result reporting.
 * Follows Oracle Principle 1: Nothing is Deleted — messages are append-only.
 *
 * Subcommands:
 *   ls              List own inbox messages (unread first)
 *   send <oracle> <message>  Write MSG-ACK-RESULT file to target oracle's ψ/inbox/
 *   ack <msg_id>    Mark a message as acknowledged (updates frontmatter)
 *   result <msg_id> <result> Mark a message as completed with result text
 *   show <id>       Display a specific message
 *   read <id>       Mark a message as read
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadConfig } from "../../../config";

// ─── Types ───────────────────────────────────────────────────────────

export interface InboxFrontmatter {
  msg_id: string;
  from: string;
  to: string;
  type: "task" | "query" | "escalation" | "info" | "ack" | "result";
  status: "pending" | "acknowledged" | "completed";
  sent: string;
  ack_by: string;     // ISO timestamp or "-"
  result: string;     // result text or "-"
  reply_file: string; // path to result file or "-"
}

export interface InboxMessage {
  id: string;           // filename minus .md
  filename: string;
  path: string;
  frontmatter: InboxFrontmatter;
  body: string;
  timestamp: Date;
}

// ─── Config Resolution ───────────────────────────────────────────────

/** Resolve the psi (ψ) directory for the CURRENT oracle */
export function resolvePsiDir(): string {
  const config = loadConfig();
  // psiPath in config takes priority
  if ((config as any).psiPath) return (config as any).psiPath;
  // Fallback: current working directory
  const localPsi = join(process.cwd(), "ψ");
  if (existsSync(localPsi)) return localPsi;
  return join(process.cwd(), "psi");
}

/** Resolve inbox dir for the current oracle */
export function resolveInboxDir(): string {
  return join(resolvePsiDir(), "inbox");
}

/** Resolve outbox dir for the current oracle */
export function resolveOutboxDir(): string {
  return join(resolvePsiDir(), "outbox");
}

/** Resolve ψ/ directory for a NAMED oracle by looking up its vault path */
export function resolveOraclePsiDir(oracleName: string): string | null {
  const config = loadConfig();
  const ghqRoot = config.ghqRoot || join(homedir(), "Code", "github.com");
  const githubOrg = config.githubOrg || "doctorboyz";

  // Name → repo name mapping
  const nameToRepo: Record<string, string> = {
    "emily": "emily-oracle",
    "pm": "pm-oracle",
    "god-port": "god-port-oracle",
    "broky": "broky-oracle",
    "metty": "metty-oracle",
    "skilly": "skilly-oracle",
  };
  const repoName = nameToRepo[oracleName] || `${oracleName}-oracle`;
  const candidate = join(ghqRoot, githubOrg, repoName, "ψ");
  if (existsSync(candidate)) return candidate;

  return null;
}

// ─── Frontmatter Parsing ─────────────────────────────────────────────

function parseYamlFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(": ");
    if (colon < 0) continue;
    const k = line.slice(0, colon);
    const v = line.slice(colon + 2).trim();
    fm[k] = v;
  }
  return { frontmatter: fm, body: match[2].trim() };
}

function buildYamlFrontmatter(fm: Record<string, string>): string {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

// ─── Message ID Generation ──────────────────────────────────────────

let msgCounter = 0;

export function newMsgId(sender: string): string {
  msgCounter++;
  const padded = String(msgCounter).padStart(3, "0");
  return `MSG-${sender.toUpperCase()}-${padded}`;
}

// ─── Core Commands ───────────────────────────────────────────────────

/** List messages in the current oracle's inbox */
export function cmdInboxLs(opts: { unread?: boolean; from?: string; last?: number }): InboxMessage[] {
  const inboxDir = resolveInboxDir();
  if (!existsSync(inboxDir)) return [];

  const messages = loadInboxMessages(inboxDir);
  let filtered = messages;

  if (opts.unread) {
    filtered = filtered.filter(m => m.frontmatter.status === "pending");
  }
  if (opts.from) {
    filtered = filtered.filter(m => m.frontmatter.from === opts.from);
  }
  if (opts.last) {
    filtered = filtered.slice(0, opts.last);
  }

  return filtered;
}

/** Write a MSG-ACK-RESULT message to a target oracle's inbox */
export function cmdSend(targetOracle: string, message: string, opts: { type?: string; msgId?: string }): string {
  const config = loadConfig();
  const senderName = config.node || "local";

  // Resolve target oracle's ψ/inbox/ directory
  const targetPsi = resolveOraclePsiDir(targetOracle);
  if (!targetPsi) {
    throw new Error(
      `Cannot resolve oracle "${targetOracle}" — not found in fleet config or known paths.\n` +
      `Hint: run 'maw oracle scan' to detect oracles, or check maw.config.json agents.`,
    );
  }
  const targetInbox = join(targetPsi, "inbox");
  if (!existsSync(targetInbox)) {
    mkdirSync(targetInbox, { recursive: true });
  }

  const msgId = opts.msgId || newMsgId(senderName);
  const type = (opts.type || "task") as InboxFrontmatter["type"];
  const now = new Date().toISOString();

  const fm: Record<string, string> = {
    msg_id: msgId,
    from: senderName,
    to: targetOracle,
    type,
    status: "pending",
    sent: now,
    ack_by: "-",
    result: "-",
    reply_file: "-",
  };

  const dateStr = now.slice(0, 10).replace(/-/g, "");
    // Use a safe filename format: {date}_{time}_{sender}_{msg_id}.md
  const timeStr = now.slice(11, 16).replace(":", "-");
  const filename = `${dateStr}_${timeStr}_${senderName}_${msgId}.md`;
  const filepath = join(targetInbox, filename);

  const content = buildYamlFrontmatter(fm) + "\n" + message + "\n";
  writeFileSync(filepath, content, "utf-8");

  // Also write a copy to own outbox for tracking
  const outboxDir = resolveOutboxDir();
  if (!existsSync(outboxDir)) {
    mkdirSync(outboxDir, { recursive: true });
  }
  const outboxFilename = `${dateStr}_${timeStr}_${senderName}_${msgId}.md`;
  writeFileSync(join(outboxDir, outboxFilename), content, "utf-8");

  return filename;
}

/** Acknowledge a message — update status to acknowledged */
export function cmdAck(msgIdOrFile: string): InboxMessage {
  const inboxDir = resolveInboxDir();
  const messages = loadInboxMessages(inboxDir);

  // Find by msg_id or filename prefix
  const msg = messages.find(m =>
    m.frontmatter.msg_id === msgIdOrFile ||
    m.id.startsWith(msgIdOrFile) ||
    m.filename.startsWith(msgIdOrFile),
  );
  if (!msg) throw new Error(`Message not found: ${msgIdOrFile}`);

  if (msg.frontmatter.status !== "pending") {
    throw new Error(`Message ${msg.frontmatter.msg_id} is already ${msg.frontmatter.status} (expected pending)`);
  }

  // Update frontmatter
  const now = new Date().toISOString();
  msg.frontmatter.status = "acknowledged";
  msg.frontmatter.ack_by = now;

  // Write ack file to outbox
  const outboxDir = resolveOutboxDir();
  if (!existsSync(outboxDir)) mkdirSync(outboxDir, { recursive: true });
  const dateStr = now.slice(0, 10).replace(/-/g, "");
  const ackFilename = `ack_${msg.frontmatter.msg_id}_${dateStr}.md`;
  const ackFm: Record<string, string> = {
    msg_id: msg.frontmatter.msg_id,
    type: "ack",
    from: msg.frontmatter.to,
    to: msg.frontmatter.from,
  };
  writeFileSync(
    join(outboxDir, ackFilename),
    buildYamlFrontmatter(ackFm) + `\nACK — รับทราบคำขอ ${msg.frontmatter.msg_id}\nเริ่มดำเนินการ\n`,
    "utf-8",
  );

  // Update the original message file
  updateMessageFile(msg);

  return msg;
}

/** Mark a message as completed with a result */
export function cmdResult(msgIdOrFile: string, resultText: string): InboxMessage {
  const inboxDir = resolveInboxDir();
  const messages = loadInboxMessages(inboxDir);

  const msg = messages.find(m =>
    m.frontmatter.msg_id === msgIdOrFile ||
    m.id.startsWith(msgIdOrFile) ||
    m.filename.startsWith(msgIdOrFile),
  );
  if (!msg) throw new Error(`Message not found: ${msgIdOrFile}`);

  if (msg.frontmatter.status === "completed") {
    throw new Error(`Message ${msg.frontmatter.msg_id} is already completed`);
  }

  const now = new Date().toISOString();

  // Update frontmatter
  msg.frontmatter.status = "completed";
  msg.frontmatter.result = resultText;

  // Write result file to outbox
  const outboxDir = resolveOutboxDir();
  if (!existsSync(outboxDir)) mkdirSync(outboxDir, { recursive: true });
  const dateStr = now.slice(0, 10).replace(/-/g, "");
  const resultFilename = `result_${msg.frontmatter.msg_id}_${dateStr}.md`;
  const resultFm: Record<string, string> = {
    msg_id: msg.frontmatter.msg_id,
    type: "result",
    from: msg.frontmatter.to,
    to: msg.frontmatter.from,
    status: resultText.toLowerCase().includes("fail") ? "failed" : "success",
  };
  writeFileSync(
    join(outboxDir, resultFilename),
    buildYamlFrontmatter(resultFm) + `\n${resultText}\n`,
    "utf-8",
  );

  // Update reply_file in frontmatter
  msg.frontmatter.reply_file = resultFilename;

  // Update the original message file
  updateMessageFile(msg);

  return msg;
}

/** Show a specific message */
export function cmdShow(msgIdOrFile: string): InboxMessage | null {
  const inboxDir = resolveInboxDir();
  const messages = loadInboxMessages(inboxDir);
  return messages.find(m =>
    m.frontmatter.msg_id === msgIdOrFile ||
    m.id.startsWith(msgIdOrFile) ||
    m.filename.startsWith(msgIdOrFile),
  ) || null;
}

/** Mark a message as read (updates frontmatter only, no ack) */
export function cmdMarkRead(msgIdOrFile: string): InboxMessage | null {
  // Reuse the pending queue store for backward compat
  // This is for the ACL-queue "read" subcommand
  const inboxDir = resolveInboxDir();
  const messages = loadInboxMessages(inboxDir);
  const msg = messages.find(m =>
    m.frontmatter.msg_id === msgIdOrFile ||
    m.id.startsWith(msgIdOrFile) ||
    m.filename.startsWith(msgIdOrFile),
  );
  if (!msg) return null;
  // Mark as read by updating the read field in frontmatter
  // (For now, this is a no-op on vault messages — they don't have a read field)
  return msg;
}

// ─── Internal Helpers ───────────────────────────────────────────────

function loadInboxMessages(inboxDir: string): InboxMessage[] {
  if (!existsSync(inboxDir)) return [];
  const messages: InboxMessage[] = [];

  for (const f of readdirSync(inboxDir)) {
    if (!f.endsWith(".md")) continue;
    const path = join(inboxDir, f);
    try {
      const content = readFileSync(path, "utf-8");
      const { frontmatter: fm, body } = parseYamlFrontmatter(content);

      // Parse into InboxFrontmatter, filling defaults for legacy files
      const parsed: InboxFrontmatter = {
        msg_id: fm.msg_id || f.replace(/\.md$/, ""),
        from: fm.from || "unknown",
        to: fm.to || "unknown",
        type: (fm.type as InboxFrontmatter["type"]) || "info",
        status: (fm.status as InboxFrontmatter["status"]) || "pending",
        sent: fm.sent || fm.timestamp || fm.date || "",
        ack_by: fm.ack_by || "-",
        result: fm.result || "-",
        reply_file: fm.reply_file || "-",
      };

      messages.push({
        id: f.replace(/\.md$/, ""),
        filename: f,
        path,
        frontmatter: parsed,
        body,
        timestamp: parsed.sent ? new Date(parsed.sent) : new Date(0),
      });
    } catch {
      // Skip unreadable files
    }
  }

  return messages.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
}

function updateMessageFile(msg: InboxMessage): void {
  const fm: Record<string, string> = {
    msg_id: msg.frontmatter.msg_id,
    from: msg.frontmatter.from,
    to: msg.frontmatter.to,
    type: msg.frontmatter.type,
    status: msg.frontmatter.status,
    sent: msg.frontmatter.sent,
    ack_by: msg.frontmatter.ack_by,
    result: msg.frontmatter.result,
    reply_file: msg.frontmatter.reply_file,
  };

  const content = buildYamlFrontmatter(fm) + "\n" + msg.body + "\n";
  // Atomic write: tmp + rename
  const tmp = msg.path + ".tmp";
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, msg.path);
}

// ─── Formatting ─────────────────────────────────────────────────────

export function formatMessageList(messages: InboxMessage[]): string {
  if (messages.length === 0) return "\x1b[90m(no messages)\x1b[0m";

  const statusColors: Record<string, string> = {
    pending: "\x1b[33m",        // yellow
    acknowledged: "\x1b[36m",   // cyan
    completed: "\x1b[32m",      // green
  };

  return messages.map(m => {
    const color = statusColors[m.frontmatter.status] || "\x1b[0m";
    const reset = "\x1b[0m";
    const dim = "\x1b[90m";
    return [
      `${color}${m.frontmatter.status.padEnd(13)}${reset} ${dim}${m.frontmatter.msg_id}${reset}`,
      `  ${dim}from:${reset} ${m.frontmatter.from}  ${dim}to:${reset} ${m.frontmatter.to}`,
      `  ${dim}type:${reset} ${m.frontmatter.type}  ${dim}sent:${reset} ${m.frontmatter.sent.slice(0, 16)}`,
      `  ${m.body.slice(0, 80)}${m.body.length > 80 ? "..." : ""}`,
    ].join("\n");
  }).join("\n\n");
}

export function formatMessageDetail(msg: InboxMessage): string {
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  const dim = "\x1b[90m";

  return [
    `${bold}${msg.frontmatter.msg_id}${reset}  ${dim}(${msg.frontmatter.status})${reset}`,
    `${dim}from:${reset}    ${msg.frontmatter.from}`,
    `${dim}to:${reset}      ${msg.frontmatter.to}`,
    `${dim}type:${reset}    ${msg.frontmatter.type}`,
    `${dim}sent:${reset}    ${msg.frontmatter.sent}`,
    `${dim}ack_by:${reset}  ${msg.frontmatter.ack_by}`,
    `${dim}result:${reset}  ${msg.frontmatter.result}`,
    `${dim}reply_file:${reset} ${msg.frontmatter.reply_file}`,
    ``,
    `${msg.body}`,
  ].join("\n");
}

export function formatQueueList(messages: any[]): string {
  if (messages.length === 0) return "\x1b[90mno pending approval messages\x1b[0m";
  return messages.map(m =>
    `\x1b[33m${m.id}\x1b[0m \x1b[90m${m.sender} → ${m.target}\x1b[0m ${m.message.slice(0, 60)}`
  ).join("\n");
}

export function formatQueueDetail(msg: any): string {
  return [
    `\x1b[1m${msg.id}\x1b[0m`,
    `  from:    ${msg.sender}`,
    `  to:      ${msg.target}`,
    `  query:   ${msg.query || msg.target}`,
    `  sent:    ${msg.sentAt}`,
    `  status:  ${msg.status}`,
    ``,
    `  ${msg.message}`,
  ].join("\n");
}

// ─── ACL Queue (backward compat with installed version) ──────────────

import { loadPending as _loadPending, loadPendingById as _loadById, updatePending as _updatePending, deletePending as _deletePending } from "../../shared/queue-store";

// Re-export queue-store primitives for external consumers
export { loadPending, savePending, updatePending, deletePending, loadPendingById, newPendingId } from "../../shared/queue-store";

export function cmdQueueList(): any[] {
  return _loadPending().filter(m => m.status === "pending");
}

export function cmdQueueShow(id: string): any | null {
  return _loadById(id);
}

export async function cmdApprove(id: string): Promise<any> {
  const record = _loadById(id);
  if (!record) throw new Error(`pending message not found: ${id}`);
  if (record.status === "approved") throw new Error(`already approved: ${id}`);

  _updatePending(id, { status: "approved" });

  // Re-issue the send
  const { cmdSend: send } = await import("../../shared/comm-send");
  const prevBypass = process.env.MAW_ACL_BYPASS;
  process.env.MAW_ACL_BYPASS = "1";
  try {
    await send(record.query || record.target, record.message);
  } finally {
    if (prevBypass === undefined) delete process.env.MAW_ACL_BYPASS;
    else process.env.MAW_ACL_BYPASS = prevBypass;
  }

  _deletePending(id);
  return { ...record, status: "approved" };
}

export function cmdReject(id: string): any {
  const record = _loadById(id);
  if (!record) throw new Error(`pending message not found: ${id}`);

  _updatePending(id, { status: "rejected" });
  _deletePending(id);
  return { ...record, status: "rejected" };
}

export function resolvePendingId(idOrPrefix: string): any | null {
  if (!idOrPrefix) return null;
  // Exact match first
  const exact = _loadById(idOrPrefix);
  if (exact) return exact;
  // Prefix match
  const all = _loadPending();
  const match = all.find(m => m.id.startsWith(idOrPrefix));
  return match || null;
}