import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { loadConfig } from "../../../config";
import {
  resolveInboxDir,
  resolveOutboxDir,
  resolveOraclePsiDir,
  loadMessages,
  appendMessage,
  updateStatus,
  findMessage,
  writeBodyFile,
  readBodyFile,
  newMsgId,
  type VaultMessage,
  type VaultStatus,
} from "./csv-store";

export const command = {
  name: "vault",
  description: "CSV-based cross-oracle vault messaging — append-only, ticket-style protocol.",
};

// ─── Helpers ─────────────────────────────────────────────────────

function nowISO(): string {
  return new Date().toISOString();
}

function emptyMsg(overrides: Partial<VaultMessage>): VaultMessage {
  return {
    msg_id: "",
    from: "",
    to: "",
    type: "task",
    status: "pending",
    sent: nowISO(),
    accepted_at: "-",
    completed_at: "-",
    reply_to: "-",
    body_file: "-",
    ...overrides,
  };
}

function sendReply(
  toOracle: string,
  fromOracle: string,
  replyTo: string,
  bodyText: string,
  type: "task" | "query" | "escalation" | "info" | "result" = "result",
  status: VaultStatus = "completed",
): { ok: boolean; msgId: string; error?: string } {
  const targetPsi = resolveOraclePsiDir(toOracle);
  if (!targetPsi) {
    return { ok: false, msgId: "", error: `Cannot resolve oracle "${toOracle}" — not found in fleet config.` };
  }

  const targetInbox = `${targetPsi}/inbox`;

  const msgId = newMsgId(fromOracle, targetInbox);
  const bodyFile = writeBodyFile(targetInbox, msgId, bodyText);

  const msg = emptyMsg({
    msg_id: msgId,
    from: fromOracle,
    to: toOracle,
    type,
    status: status === "completed" ? "completed" : "pending",
    reply_to: replyTo,
    body_file: bodyFile,
  });

  appendMessage(targetInbox, msg);

  // Archive copy to own outbox
  const outboxDir = resolveOutboxDir();
  if (outboxDir) {
    appendMessage(outboxDir, msg);
  }

  return { ok: true, msgId };
}

// ─── Main Handler ────────────────────────────────────────────────

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  console.error = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };

  const out = () => logs.join("\n");
  const inboxDir = resolveInboxDir();

  const statusIcon = (s: VaultStatus) => {
    switch (s) {
      case "pending": return "\x1b[33m●\x1b[0m";
      case "accepted": return "\x1b[36m◐\x1b[0m";
      case "completed": return "\x1b[32m✓\x1b[0m";
      case "failed": return "\x1b[31m✗\x1b[0m";
    }
  };

  const help = () => [
    "\x1b[36m\x1b[1mvault\x1b[0m — CSV-based cross-oracle ticket messaging",
    "",
    "\x1b[1mCommands:\x1b[0m",
    "  send <oracle> <message> [--type task|query|info] [--reply-to <msg_id>]",
    "                                Send message to target oracle's CSV inbox",
    "  ls [--pending] [--accepted] [--from <oracle>]",
    "                                List own inbox messages",
    "  status <msg_id>               Show status of a message",
    "  accept <msg_id>               Accept a pending task (→ accepted)",
    "  result <msg_id> <text>        Complete task with result (→ completed)",
    "  show <msg_id>                 Display full message body",
    "",
    "\x1b[90mLivecycle:\x1b[0m",
    "  pending → accepted → completed",
    "  Result is delivered to sender's inbox (not own outbox)",
    "  CSV is append-only — old rows remain for audit",
  ].join("\n");

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const sub = args[0]?.toLowerCase();

    if (!sub) {
      console.log(help());
      return { ok: true, output: out() || help() };
    }

    switch (sub) {
      // ─── send ───
      case "send": {
        const targetOracle = args[1];
        // Build message from positional args, filtering out flag values
        const flags = new Set(["--type", "--reply-to", "--from"]);
        const msgParts: string[] = [];
        let skipNext = false;
        for (let i = 2; i < args.length; i++) {
          if (skipNext) { skipNext = false; continue; }
          if (flags.has(args[i])) { skipNext = true; continue; }
          msgParts.push(args[i]);
        }
        const message = msgParts.join(" ");

        const typeIdx = args.indexOf("--type");
        const type = (typeIdx >= 0 ? args[typeIdx + 1] : "task") as "task" | "query" | "info";
        const replyIdx = args.indexOf("--reply-to");
        const replyTo = replyIdx >= 0 ? args[replyIdx + 1] : "-";
        const fromIdx = args.indexOf("--from");
        const config = loadConfig();
        const senderName = fromIdx >= 0 ? args[fromIdx + 1] : ((config as any).node || "local");

        if (!targetOracle || !message) {
          console.error("\x1b[31merror\x1b[0m: missing target oracle or message");
          console.error("usage: maw vault send <oracle> <message> [--type task|query|info] [--reply-to <msg_id>] [--from <oracle>]");
          return { ok: false, error: "missing target oracle or message", output: out() };
        }

        const targetPsi = resolveOraclePsiDir(targetOracle);
        if (!targetPsi) {
          console.error(`\x1b[31merror\x1b[0m: cannot resolve oracle "${targetOracle}"`);
          console.error("  hint: run 'maw oracle scan' or check fleet configs");
          return { ok: false, error: `cannot resolve oracle: ${targetOracle}`, output: out() };
        }

        const targetInbox = `${targetPsi}/inbox`;
        const msgId = newMsgId(senderName, targetInbox);
        const bodyFile = writeBodyFile(targetInbox, msgId, message);

        const msg = emptyMsg({
          msg_id: msgId,
          from: senderName,
          to: targetOracle,
          type,
          reply_to: replyTo,
          body_file: bodyFile,
        });

        appendMessage(targetInbox, msg);

        // Archive copy
        const outboxDir = resolveOutboxDir();
        if (outboxDir) appendMessage(outboxDir, msg);

        console.log(`\x1b[32m✓\x1b[0m sent \x1b[36m${msgId}\x1b[0m → \x1b[1m${targetOracle}\x1b[0m`);
        if (replyTo !== "-") console.log(`\x1b[90m  reply_to: ${replyTo}\x1b[0m`);
        console.log(`\x1b[90m  status: pending\x1b[0m`);
        return { ok: true, output: out() };
      }

      // ─── ls ───
      case "ls":
      case "list": {
        let msgs = loadMessages(inboxDir);
        const showAll = args.includes("--all");

        if (args.includes("--pending")) {
          msgs = msgs.filter(m => m.status === "pending");
        } else if (args.includes("--accepted")) {
          msgs = msgs.filter(m => m.status === "accepted");
        } else if (!showAll) {
          // Default: show pending + accepted (actionable items)
          // Also include completed replies — results delivered from other oracles
          msgs = msgs.filter(m => m.status === "pending" || m.status === "accepted" || m.reply_to !== "-");
        }

        const fromIdx = args.indexOf("--from");
        if (fromIdx >= 0) {
          const from = args[fromIdx + 1];
          msgs = msgs.filter(m => m.from === from);
        }

        if (msgs.length === 0) {
          console.log("\x1b[90m(no messages)\x1b[0m");
          return { ok: true, output: out() };
        }

        // Load ALL messages for reply context (including completed)
        const allMsgs = showAll ? msgs : loadMessages(inboxDir);

        // Group by reply_to for display
        const topLevel = msgs.filter(m => m.reply_to === "-");
        const replies = msgs.filter(m => m.reply_to !== "-");

        if (topLevel.length > 0) {
          console.log(`\x1b[1mPending / Accepted\x1b[0m`);
          console.log("");
          for (const m of topLevel) {
            console.log(`${statusIcon(m.status)} \x1b[36m${m.msg_id}\x1b[0m  \x1b[90m← ${m.from}\x1b[0m  \x1b[90m${m.type}\x1b[0m`);
            const body = readBodyFile(inboxDir, m.body_file);
            const preview = body.slice(0, 80).replace(/\n/g, " ");
            console.log(`  ${preview}${body.length > 80 ? "..." : ""}`);

            // Show ALL replies under this message (including completed)
            const msgReplies = allMsgs.filter(r => r.reply_to === m.msg_id);
            for (const r of msgReplies) {
              const rbody = readBodyFile(inboxDir, r.body_file);
              const rpreview = rbody.slice(0, 60).replace(/\n/g, " ");
              console.log(`  ${statusIcon(r.status)} ↳ \x1b[90m${r.msg_id} ← ${r.from}\x1b[0m  ${rpreview}`);
            }
            console.log("");
          }
        }

        // Show orphan replies (reply_to not in current set — e.g. results from other oracles)
        const knownIds = new Set(msgs.map(m => m.msg_id));
        const orphans = replies.filter(r => !knownIds.has(r.reply_to));
        if (orphans.length > 0) {
          console.log(`\x1b[1mResults / Replies\x1b[0m`);
          for (const r of orphans) {
            const rbody = readBodyFile(inboxDir, r.body_file);
            const rpreview = rbody.slice(0, 100).replace(/\n/g, " ");
            console.log(`${statusIcon(r.status)} \x1b[36m${r.msg_id}\x1b[0m ← \x1b[1m${r.from}\x1b[0m  \x1b[90m↳ ${r.reply_to}\x1b[0m`);
            console.log(`  ${rpreview}${rbody.length > 100 ? "..." : ""}`);
          }
          console.log("");
        }

        console.log(`\x1b[90m${msgs.length} message(s)\x1b[0m`);
        return { ok: true, output: out() };
      }

      // ─── status ───
      case "status": {
        const msgId = args[1];
        if (!msgId) {
          console.error("\x1b[31merror\x1b[0m: missing message id");
          return { ok: false, error: "missing message id", output: out() };
        }
        const msg = findMessage(inboxDir, msgId);
        if (!msg) {
          console.error(`\x1b[31merror\x1b[0m: message not found: ${msgId}`);
          return { ok: false, error: `message not found: ${msgId}`, output: out() };
        }
        console.log(`${statusIcon(msg.status)} \x1b[1m${msg.msg_id}\x1b[0m  \x1b[90m${msg.status}\x1b[0m`);
        console.log(`  from:    ${msg.from}`);
        console.log(`  to:      ${msg.to}`);
        console.log(`  type:    ${msg.type}`);
        console.log(`  sent:    ${msg.sent}`);
        if (msg.reply_to !== "-") console.log(`  reply_to: ${msg.reply_to}`);
        if (msg.accepted_at !== "-") console.log(`  accepted: ${msg.accepted_at}`);
        if (msg.completed_at !== "-") console.log(`  completed: ${msg.completed_at}`);
        return { ok: true, output: out() };
      }

      // ─── accept ───
      case "accept": {
        const msgId = args[1];
        if (!msgId) {
          console.error("\x1b[31merror\x1b[0m: missing message id");
          return { ok: false, error: "missing message id", output: out() };
        }

        const msg = findMessage(inboxDir, msgId);
        if (!msg) {
          console.error(`\x1b[31merror\x1b[0m: message not found: ${msgId}`);
          return { ok: false, error: `message not found: ${msgId}`, output: out() };
        }
        if (msg.status !== "pending") {
          console.error(`\x1b[31merror\x1b[0m: message ${msg.msg_id} is already ${msg.status}`);
          return { ok: false, error: `message already ${msg.status}`, output: out() };
        }

        const now = nowISO();
        const updated = updateStatus(inboxDir, msg.msg_id, {
          status: "accepted",
          accepted_at: now,
        });

        if (!updated) {
          console.error(`\x1b[31merror\x1b[0m: failed to update ${msgId}`);
          return { ok: false, error: "failed to update", output: out() };
        }

        console.log(`\x1b[32m✓\x1b[0m accepted \x1b[36m${msg.msg_id}\x1b[0m`);

        // Notify sender
        const ackBody = `# Accepted: ${msg.msg_id}\n\n**What**: Task accepted by ${msg.to}\n**When**: ${now}\n**Status**: Working on it\n`;
        const reply = sendReply(msg.from, msg.to, msg.msg_id, ackBody, "info", "completed");
        if (reply.ok) {
          console.log(`\x1b[90m  notified sender (${reply.msgId})\x1b[0m`);
        } else {
          console.log(`\x1b[90m  could not notify sender: ${reply.error}\x1b[0m`);
        }

        return { ok: true, output: out() };
      }

      // ─── result ───
      case "result": {
        const msgId = args[1];
        const resultText = args.slice(2).join(" ");

        if (!msgId || !resultText) {
          console.error("\x1b[31merror\x1b[0m: missing message id or result text");
          console.error("usage: maw vault result <msg_id> <result text>");
          return { ok: false, error: "missing message id or result text", output: out() };
        }

        const msg = findMessage(inboxDir, msgId);
        if (!msg) {
          console.error(`\x1b[31merror\x1b[0m: message not found: ${msgId}`);
          return { ok: false, error: `message not found: ${msgId}`, output: out() };
        }
        if (msg.status === "completed") {
          console.error(`\x1b[31merror\x1b[0m: message ${msg.msg_id} is already completed`);
          return { ok: false, error: "message already completed", output: out() };
        }

        const now = nowISO();
        const updated = updateStatus(inboxDir, msg.msg_id, {
          status: "completed",
          completed_at: now,
        });

        if (!updated) {
          console.error(`\x1b[31merror\x1b[0m: failed to update ${msgId}`);
          return { ok: false, error: "failed to update", output: out() };
        }

        console.log(`\x1b[32m✓\x1b[0m completed \x1b[36m${msg.msg_id}\x1b[0m`);

        // Deliver result to sender's inbox
        const resultBody = `# Result: ${msg.msg_id}\n\n**What was done**: ${resultText}\n**Completed**: ${now}\n`;
        const reply = sendReply(msg.from, msg.to, msg.msg_id, resultBody, "result", "completed");

        if (reply.ok) {
          console.log(`\x1b[32m✓\x1b[0m result delivered to \x1b[1m${msg.from}\x1b[0m (${reply.msgId})`);
        } else {
          console.log(`\x1b[31m⚠\x1b[0m could not deliver result: ${reply.error}`);
        }

        return { ok: true, output: out() };
      }

      // ─── show ───
      case "show": {
        const msgId = args[1];
        if (!msgId) {
          console.error("\x1b[31merror\x1b[0m: missing message id");
          return { ok: false, error: "missing message id", output: out() };
        }
        const msg = findMessage(inboxDir, msgId);
        if (!msg) {
          console.error(`\x1b[31merror\x1b[0m: message not found: ${msgId}`);
          return { ok: false, error: `message not found: ${msgId}`, output: out() };
        }
        const body = readBodyFile(inboxDir, msg.body_file);
        console.log(`\x1b[1m${msg.msg_id}\x1b[0m  ${statusIcon(msg.status)} \x1b[90m${msg.status}\x1b[0m`);
        console.log(`from:    ${msg.from}`);
        console.log(`to:      ${msg.to}`);
        console.log(`type:    ${msg.type}`);
        console.log(`sent:    ${msg.sent}`);
        if (msg.reply_to !== "-") console.log(`reply_to: ${msg.reply_to}`);
        if (msg.accepted_at !== "-") console.log(`accepted: ${msg.accepted_at}`);
        if (msg.completed_at !== "-") console.log(`completed: ${msg.completed_at}`);
        console.log("");
        console.log(body);
        return { ok: true, output: out() };
      }

      default: {
        console.log(help());
        return {
          ok: false,
          error: `maw vault: unknown subcommand "${sub}" (expected send|ls|status|accept|result|show)`,
          output: out() || help(),
        };
      }
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), output: out() || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
