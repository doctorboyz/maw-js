import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import {
  cmdTeamShutdown, cmdTeamList, cmdTeamCreate, cmdTeamSpawn,
  cmdTeamSend, cmdTeamResume, cmdTeamLives,
} from "./impl";

export const command = {
  name: "team",
  description: "Agent reincarnation engine — create, spawn, send, shutdown, resume, lives.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: any[]) => logs.push(a.map(String).join(" "));
  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const sub = args[0]?.toLowerCase();

    if (sub === "create" || sub === "new") {
      if (!args[1]) {
        logs.push("usage: maw team create <name> [--description <text>]");
        return { ok: false, error: "name required", output: logs.join("\n") };
      }
      const descIdx = args.indexOf("--description");
      const description = descIdx !== -1 ? args.slice(descIdx + 1).join(" ") : undefined;
      cmdTeamCreate(args[1], { description });
    } else if (sub === "spawn") {
      if (!args[1] || !args[2]) {
        logs.push("usage: maw team spawn <team> <role> [--model <model>] [--prompt <text>]");
        return { ok: false, error: "team and role required", output: logs.join("\n") };
      }
      const modelIdx = args.indexOf("--model");
      const model = modelIdx !== -1 ? args[modelIdx + 1] : undefined;
      const promptIdx = args.indexOf("--prompt");
      const prompt = promptIdx !== -1 ? args.slice(promptIdx + 1).join(" ") : undefined;
      cmdTeamSpawn(args[1], args[2], { model, prompt });
    } else if (sub === "send" || sub === "msg") {
      if (!args[1] || !args[2] || !args[3]) {
        logs.push("usage: maw team send <team> <agent> <message>");
        return { ok: false, error: "team, agent, and message required", output: logs.join("\n") };
      }
      cmdTeamSend(args[1], args[2], args.slice(3).join(" "));
    } else if (sub === "resume") {
      if (!args[1]) {
        logs.push("usage: maw team resume <name> [--model <model>]");
        return { ok: false, error: "name required", output: logs.join("\n") };
      }
      const modelIdx = args.indexOf("--model");
      const model = modelIdx !== -1 ? args[modelIdx + 1] : undefined;
      cmdTeamResume(args[1], { model });
    } else if (sub === "lives" || sub === "history") {
      if (!args[1]) {
        logs.push("usage: maw team lives <agent>");
        return { ok: false, error: "agent name required", output: logs.join("\n") };
      }
      cmdTeamLives(args[1]);
    } else if (sub === "shutdown" || sub === "down") {
      if (!args[1]) {
        logs.push("usage: maw team shutdown <name> [--force] [--merge]");
        return { ok: false, error: "name required", output: logs.join("\n") };
      }
      await cmdTeamShutdown(args[1], {
        force: args.includes("--force"),
        merge: args.includes("--merge"),
      });
    } else if (sub === "list" || sub === "ls" || !sub) {
      await cmdTeamList();
    } else if (sub === "add" || sub === "task") {
      // maw team add "subject" [--assign agent] [--description text]
      const { cmdTeamTaskAdd } = await import("./task-ops");
      const subject = args.slice(1).filter(a => !a.startsWith("--")).join(" ");
      if (!subject) { logs.push("usage: maw team add <subject>"); return { ok: false, error: "subject required" }; }
      const assignIdx = args.indexOf("--assign");
      const assign = assignIdx !== -1 ? args[assignIdx + 1] : undefined;
      const descIdx = args.indexOf("--description");
      const desc = descIdx !== -1 ? args.slice(descIdx + 1).join(" ") : undefined;
      // detect current team from tmux session name or arg
      const team = "default"; // TODO: detect from context
      cmdTeamTaskAdd(team, subject, { assign, description: desc });

    } else if (sub === "tasks") {
      // maw team tasks [team-name]
      const { cmdTeamTaskList } = await import("./task-ops");
      const team = args[1] || "default";
      cmdTeamTaskList(team);

    } else if (sub === "done") {
      // maw team done <id>
      const { cmdTeamTaskDone } = await import("./task-ops");
      const id = parseInt(args[1]);
      if (!id) { return { ok: false, error: "usage: maw team done <task-id>" }; }
      const team = "default"; // TODO: detect
      cmdTeamTaskDone(team, id);

    } else if (sub === "assign") {
      // maw team assign <id> <agent>
      const { cmdTeamTaskAssign } = await import("./task-ops");
      const id = parseInt(args[1]);
      const agent = args[2];
      if (!id || !agent) { return { ok: false, error: "usage: maw team assign <task-id> <agent>" }; }
      const team = "default";
      cmdTeamTaskAssign(team, id, agent);

    } else if (sub === "status") {
      // maw team status [team-name]
      const { cmdTeamStatus } = await import("./team-status");
      await cmdTeamStatus(args[1]);

    } else if (sub === "delete" || sub === "rm") {
      // maw team delete <team-name>
      const { cmdTeamDelete } = await import("./team-cleanup");
      if (!args[1]) { return { ok: false, error: "usage: maw team delete <team-name>" }; }
      await cmdTeamDelete(args[1]);

    } else {
      logs.push(`unknown team subcommand: ${sub}`);
      logs.push("usage: maw team <create|spawn|send|shutdown|resume|lives|list|status|add|tasks|done|assign|delete>");
      return { ok: false, error: `unknown subcommand: ${sub}`, output: logs.join("\n") };
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
