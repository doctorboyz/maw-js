import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import {
  cmdInboxLs,
  cmdSend,
  cmdAck,
  cmdResult,
  cmdShow as cmdInboxShow,
  cmdMarkRead,
  formatMessageList,
  formatMessageDetail,
  cmdQueueList,
  cmdShow as cmdQueueShowDetail,
  cmdApprove,
  cmdReject,
  resolvePendingId,
  formatQueueList,
  formatQueueDetail,
} from "./impl";

export const command = {
  name: "inbox",
  description: "Oracle inbox — MSG-ACK-RESULT protocol for cross-oracle messaging.",
};

/**
 * maw inbox — MSG-ACK-RESULT messaging plugin.
 *
 * Vault-based message protocol with acknowledgment and result reporting.
 * Follows Oracle Principle 1 (Nothing is Deleted) — all messages are
 * append-only markdown files with YAML frontmatter.
 *
 * Subcommands:
 *   ls              List own inbox messages (unread first)
 *   send            Write MSG-ACK-RESULT file to target oracle's ψ/inbox/
 *   ack <msg_id>    Mark a message as acknowledged
 *   result <msg_id> <text>  Mark a message as completed with result
 *   show <id>       Display a specific message
 *   read <id>       Mark a message as read
 *   show-pending    Show ACL-queued pending messages (from cross-node hey)
 *   approve <id>     Approve a queued cross-node message
 *   reject <id>      Reject a queued cross-node message
 */
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

  const help = () => [
    "\x1b[36m\x1b[1minbox\x1b[0m — MSG-ACK-RESULT protocol for cross-oracle messaging",
    "",
    "\x1b[1mVault Messaging (MSG-ACK-RESULT):\x1b[0m",
    "  ls [--unread] [--from <oracle>] [--last N]",
    "                                List own inbox messages",
    "  send <oracle> <message>       Write to target oracle's ψ/inbox/",
    "                                (creates MSG-ACK-RESULT frontmatter)",
    "  ack <msg_id>                  Acknowledge a pending message",
    "  result <msg_id> <text>        Mark message as completed with result",
    "  show <id>                     Display a specific message",
    "  read <id>                     Mark a message as read",
    "",
    "\x1b[1mACL Queue (cross-node approval):\x1b[0m",
    "  show-pending                  List pending cross-node messages",
    "  approve <id>                  Approve and send a queued message",
    "  reject <id>                  Reject a queued message",
    "",
    "\x1b[90mMSG-ACK-RESULT Protocol:\x1b[0m",
    "  pending → acknowledged → completed",
    "  Sender writes to {target}/ψ/inbox/{date}_{time}_{from}_{msg_id}.md",
    "  Receiver acks → writes to own ψ/outbox/ack_{msg_id}_{date}.md",
    "  Receiver completes → writes to own ψ/outbox/result_{msg_id}_{date}.md",
  ].join("\n");

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const sub = args[0]?.toLowerCase();

    if (!sub) {
      console.log(help());
      return { ok: true, output: out() || help() };
    }

    switch (sub) {
      // ─── Vault Messaging (MSG-ACK-RESULT) ───
      case "ls":
      case "list": {
        const unread = args.includes("--unread");
        const fromIdx = args.indexOf("--from");
        const from = fromIdx >= 0 ? args[fromIdx + 1] : undefined;
        const lastIdx = args.indexOf("--last");
        const last = lastIdx >= 0 ? parseInt(args[lastIdx + 1] ?? "20") || 20 : undefined;
        const messages = cmdInboxLs({ unread, from, last });
        console.log(formatMessageList(messages));
        return { ok: true, output: out() };
      }

      case "send": {
        // maw inbox send <oracle> <message> [--type task|query|escalation|info]
        const positional = args.filter(a => !a.startsWith("--"));
        const typeIdx = args.indexOf("--type");
        const type = typeIdx >= 0 ? args[typeIdx + 1] : undefined;

        const targetOracle = positional[1];
        const message = positional.slice(2).join(" ");

        if (!targetOracle || !message) {
          console.error("\x1b[31merror\x1b[0m: missing target oracle or message");
          console.error("usage: maw inbox send <oracle> <message> [--type task|query|escalation|info]");
          return { ok: false, error: "missing target oracle or message", output: out() };
        }

        try {
          const filename = cmdSend(targetOracle, message, { type });
          console.log(`\x1b[32m✓\x1b[0m sent to \x1b[36m${targetOracle}\x1b[0m → ${filename}`);
          console.log(`\x1b[90m  status: pending (MSG-ACK-RESULT protocol)\x1b[0m`);
          return { ok: true, output: out() };
        } catch (e: any) {
          console.error(`\x1b[31merror\x1b[0m: ${e?.message || String(e)}`);
          return { ok: false, error: e?.message || String(e), output: out() };
        }
      }

      case "ack": {
        const msgId = args[1];
        if (!msgId) {
          console.error("\x1b[31merror\x1b[0m: missing message id");
          console.error("usage: maw inbox ack <msg_id>");
          return { ok: false, error: "missing message id", output: out() };
        }
        try {
          const msg = cmdAck(msgId);
          console.log(`\x1b[32m✓\x1b[0m acknowledged \x1b[36m${msg.frontmatter.msg_id}\x1b[0m`);
          console.log(`\x1b[90m  from: ${msg.frontmatter.from}  status: ${msg.frontmatter.status}\x1b[0m`);
          console.log(`\x1b[90m  ack written to ψ/outbox/\x1b[0m`);
          return { ok: true, output: out() };
        } catch (e: any) {
          console.error(`\x1b[31merror\x1b[0m: ${e?.message || String(e)}`);
          return { ok: false, error: e?.message || String(e), output: out() };
        }
      }

      case "result": {
        const msgId = args[1];
        const resultText = args.slice(2).join(" ");
        if (!msgId || !resultText) {
          console.error("\x1b[31merror\x1b[0m: missing message id or result text");
          console.error("usage: maw inbox result <msg_id> <result text>");
          return { ok: false, error: "missing message id or result text", output: out() };
        }
        try {
          const msg = cmdResult(msgId, resultText);
          console.log(`\x1b[32m✓\x1b[0m completed \x1b[36m${msg.frontmatter.msg_id}\x1b[0m`);
          console.log(`\x1b[90m  status: completed  result: ${resultText.slice(0, 60)}\x1b[0m`);
          console.log(`\x1b[90m  result written to ψ/outbox/\x1b[0m`);
          return { ok: true, output: out() };
        } catch (e: any) {
          console.error(`\x1b[31merror\x1b[0m: ${e?.message || String(e)}`);
          return { ok: false, error: e?.message || String(e), output: out() };
        }
      }

      case "show": {
        const id = args[1];
        if (!id) {
          console.error("\x1b[31merror\x1b[0m: missing message id");
          console.error("usage: maw inbox show <id>");
          return { ok: false, error: "missing message id", output: out() };
        }
        const msg = cmdInboxShow(id);
        if (!msg) {
          // Try ACL queue
          const pending = resolvePendingId(id);
          if (pending) {
            console.log(formatQueueDetail(pending));
            return { ok: true, output: out() };
          }
          console.error(`\x1b[31merror\x1b[0m: message not found: ${id}`);
          return { ok: false, error: `message not found: ${id}`, output: out() };
        }
        console.log(formatMessageDetail(msg));
        return { ok: true, output: out() };
      }

      case "read": {
        const id = args[1];
        if (!id) {
          console.error("\x1b[31merror\x1b[0m: missing message id");
          console.error("usage: maw inbox read <id>");
          return { ok: false, error: "missing message id", output: out() };
        }
        const msg = cmdMarkRead(id);
        if (!msg) {
          console.error(`\x1b[31merror\x1b[0m: message not found: ${id}`);
          return { ok: false, error: `message not found: ${id}`, output: out() };
        }
        console.log(`\x1b[32m✓\x1b[0m marked as read: ${msg.frontmatter.msg_id}`);
        return { ok: true, output: out() };
      }

      // ─── ACL Queue (backward compat) ───
      case "show-pending": {
        const pending = cmdQueueList();
        console.log(formatQueueList(pending));
        return { ok: true, output: out() };
      }

      case "approve": {
        const id = args[1];
        if (!id) {
          console.error("\x1b[31merror\x1b[0m: missing message id");
          console.error("usage: maw inbox approve <id>");
          return { ok: false, error: "missing message id", output: out() };
        }
        try {
          const result = await cmdApprove(id);
          console.log(`\x1b[32m✓\x1b[0m approved and sent: ${result.id}`);
          return { ok: true, output: out() };
        } catch (e: any) {
          console.error(`\x1b[31merror\x1b[0m: ${e?.message || String(e)}`);
          return { ok: false, error: e?.message || String(e), output: out() };
        }
      }

      case "reject": {
        const id = args[1];
        if (!id) {
          console.error("\x1b[31merror\x1b[0m: missing message id");
          console.error("usage: maw inbox reject <id>");
          return { ok: false, error: "missing message id", output: out() };
        }
        try {
          const result = cmdReject(id);
          console.log(`\x1b[32m✓\x1b[0m rejected: ${result.id}`);
          return { ok: true, output: out() };
        } catch (e: any) {
          console.error(`\x1b[31merror\x1b[0m: ${e?.message || String(e)}`);
          return { ok: false, error: e?.message || String(e), output: out() };
        }
      }

      default: {
        console.log(help());
        return {
          ok: false,
          error: `maw inbox: unknown subcommand "${sub}" (expected ls|send|ack|result|show|read|show-pending|approve|reject)`,
          output: out() || help(),
        };
      }
    }
  } catch (e: any) {
    return { ok: false, error: out() || e.message, output: out() || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}