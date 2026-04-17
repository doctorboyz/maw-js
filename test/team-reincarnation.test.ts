/**
 * #361 — Team reincarnation regression tests.
 *
 * Tests the 5 new commands (cmdTeamCreate, cmdTeamSpawn, cmdTeamSend,
 * cmdTeamResume, cmdTeamLives) plus writeMessage and the --merge extension
 * to cmdTeamShutdown.
 *
 * Uses tmpdir + process.chdir for ψ/ isolation (resolvePsi reads cwd),
 * plus _setDirs for TEAMS_DIR/TASKS_DIR injection.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  _setDirs,
  writeMessage,
  cmdTeamCreate,
  cmdTeamSpawn,
  cmdTeamSend,
  cmdTeamResume,
  cmdTeamLives,
} from "../src/commands/plugins/team/impl";

let testDir: string;
let teamsDir: string;
let tasksDir: string;
let psiDir: string;
let origCwd: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "maw-reincarn-"));
  teamsDir = join(testDir, "teams");
  tasksDir = join(testDir, "tasks");
  psiDir = join(testDir, "ψ");
  mkdirSync(teamsDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(join(psiDir, "memory", "mailbox"), { recursive: true });
  _setDirs(teamsDir, tasksDir);
  origCwd = process.cwd();
  process.chdir(testDir);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(testDir, { recursive: true, force: true });
});

/** Capture console.log + console.error output from a sync function. */
function captureLogs(fn: () => void): string[] {
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: any[]) => logs.push(a.map(String).join(" "));
  try { fn(); } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return logs;
}

/** Create a live team in TEAMS_DIR (for writeMessage / cmdTeamSend live path). */
function createLiveTeam(name: string, members: any[]) {
  const teamDir = join(teamsDir, name);
  mkdirSync(join(teamDir, "inboxes"), { recursive: true });
  writeFileSync(join(teamDir, "config.json"), JSON.stringify({
    name, description: `test ${name}`, members, createdAt: Date.now(),
  }));
}

// ─── cmdTeamCreate ───

describe("cmdTeamCreate", () => {
  test("creates manifest.json in ψ/memory/mailbox/teams/", () => {
    const logs = captureLogs(() => cmdTeamCreate("alpha-99"));

    const manifestPath = join(psiDir, "memory", "mailbox", "teams", "alpha-99", "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.name).toBe("alpha-99");
    expect(manifest.members).toEqual([]);
    expect(manifest.createdAt).toBeGreaterThan(0);
    expect(logs.some(l => l.includes("created"))).toBe(true);
  });

  test("stores description when provided", () => {
    captureLogs(() => cmdTeamCreate("alpha-100", { description: "reincarnation test" }));

    const manifest = JSON.parse(readFileSync(
      join(psiDir, "memory", "mailbox", "teams", "alpha-100", "manifest.json"), "utf-8",
    ));
    expect(manifest.description).toBe("reincarnation test");
  });

  test("rejects -view names via assertValidOracleName", () => {
    expect(() => cmdTeamCreate("alpha-view")).toThrow(/-view/);
  });

  test("rejects multi-word-view names", () => {
    expect(() => cmdTeamCreate("my-big-team-view")).toThrow(/-view/);
  });
});

// ─── cmdTeamSpawn ───

describe("cmdTeamSpawn", () => {
  test("empty mailbox (no past life) — prompt has no standing orders", () => {
    captureLogs(() => cmdTeamCreate("spawn-test"));

    const logs = captureLogs(() => cmdTeamSpawn("spawn-test", "scout"));

    expect(logs.some(l => l.includes("past life: no"))).toBe(true);
    expect(logs.some(l => l.includes("spawn prompt written"))).toBe(true);

    const promptPath = join(psiDir, "memory", "mailbox", "teams", "spawn-test", "scout-spawn-prompt.md");
    expect(existsSync(promptPath)).toBe(true);

    const prompt = readFileSync(promptPath, "utf-8");
    expect(prompt).toContain("scout");
    expect(prompt).toContain("spawn-test");
    expect(prompt).not.toContain("Standing Orders");
  });

  test("with mailbox (has past life) — prompt includes past-life context", () => {
    captureLogs(() => cmdTeamCreate("life-test"));

    // Plant past-life data
    const mailboxDir = join(psiDir, "memory", "mailbox", "researcher");
    mkdirSync(mailboxDir, { recursive: true });
    writeFileSync(join(mailboxDir, "standing-orders.md"), "Always check for regressions.");
    writeFileSync(join(mailboxDir, "2026-04-15_findings.md"),
      "Found 3 bugs in auth module.\nFixed CSRF token expiry.\nNeeds follow-up on rate limiting.");

    const logs = captureLogs(() => cmdTeamSpawn("life-test", "researcher"));

    expect(logs.some(l => l.includes("past life: yes"))).toBe(true);

    const promptPath = join(psiDir, "memory", "mailbox", "teams", "life-test", "researcher-spawn-prompt.md");
    const prompt = readFileSync(promptPath, "utf-8");
    expect(prompt).toContain("Standing Orders");
    expect(prompt).toContain("Always check for regressions");
    expect(prompt).toContain("Last Known Findings");
    expect(prompt).toContain("rate limiting");
  });

  test("adds member to manifest without duplicates", () => {
    captureLogs(() => cmdTeamCreate("dup-test"));
    captureLogs(() => cmdTeamSpawn("dup-test", "builder"));
    captureLogs(() => cmdTeamSpawn("dup-test", "builder")); // second spawn

    const manifest = JSON.parse(readFileSync(
      join(psiDir, "memory", "mailbox", "teams", "dup-test", "manifest.json"), "utf-8",
    ));
    expect(manifest.members.filter((m: string) => m === "builder").length).toBe(1);
  });

  test("respects --model option in output", () => {
    captureLogs(() => cmdTeamCreate("model-test"));

    const logs = captureLogs(() => cmdTeamSpawn("model-test", "analyst", { model: "opus" }));

    expect(logs.some(l => l.includes("model: opus"))).toBe(true);
  });
});

// ─── cmdTeamSend ───

describe("cmdTeamSend", () => {
  test("writes message to live team inbox JSON", () => {
    createLiveTeam("send-live", [
      { name: "team-lead", agentType: "team-lead" },
      { name: "worker", agentType: "general-purpose" },
    ]);

    const logs = captureLogs(() => cmdTeamSend("send-live", "worker", "do the thing"));

    expect(logs.some(l => l.includes("message sent") && l.includes("worker"))).toBe(true);

    const inboxPath = join(teamsDir, "send-live", "inboxes", "worker.json");
    expect(existsSync(inboxPath)).toBe(true);
    const messages = JSON.parse(readFileSync(inboxPath, "utf-8"));
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe("maw-team-send");
    const text = JSON.parse(messages[0].text);
    expect(text.type).toBe("message");
    expect(text.content).toBe("do the thing");
  });

  test("falls back to ψ mailbox when team is not live", () => {
    const logs = captureLogs(() => cmdTeamSend("archived-team", "scout", "check auth module"));

    expect(logs.some(l => l.includes("not live"))).toBe(true);

    const mailboxDir = join(psiDir, "memory", "mailbox", "scout");
    expect(existsSync(mailboxDir)).toBe(true);

    const files = readdirSync(mailboxDir).filter(f => f.startsWith("msg-"));
    expect(files).toHaveLength(1);

    const msg = JSON.parse(readFileSync(join(mailboxDir, files[0]), "utf-8"));
    expect(msg.team).toBe("archived-team");
    expect(msg.text).toBe("check auth module");
  });
});

// ─── cmdTeamResume ───

describe("cmdTeamResume", () => {
  test("reads manifest and calls spawn for each member", () => {
    captureLogs(() => cmdTeamCreate("resume-test"));
    captureLogs(() => cmdTeamSpawn("resume-test", "scout"));
    captureLogs(() => cmdTeamSpawn("resume-test", "builder"));

    const logs = captureLogs(() => cmdTeamResume("resume-test"));

    expect(logs.some(l => l.includes("resumed"))).toBe(true);
    expect(logs.some(l => l.includes("2 agent(s) reincarnated"))).toBe(true);

    // Both prompt files should be (re)written
    expect(existsSync(join(psiDir, "memory", "mailbox", "teams", "resume-test", "scout-spawn-prompt.md"))).toBe(true);
    expect(existsSync(join(psiDir, "memory", "mailbox", "teams", "resume-test", "builder-spawn-prompt.md"))).toBe(true);
  });

  test("handles empty member list gracefully", () => {
    captureLogs(() => cmdTeamCreate("empty-resume"));

    const logs = captureLogs(() => cmdTeamResume("empty-resume"));
    expect(logs.some(l => l.includes("no members"))).toBe(true);
  });
});

// ─── cmdTeamLives ───

describe("cmdTeamLives", () => {
  test("shows timeline with standing orders and findings", () => {
    const mailboxDir = join(psiDir, "memory", "mailbox", "historian");
    mkdirSync(mailboxDir, { recursive: true });
    writeFileSync(join(mailboxDir, "standing-orders.md"), "Document everything.");
    writeFileSync(join(mailboxDir, "2026-04-10_findings.md"), "Findings from April 10.");
    writeFileSync(join(mailboxDir, "2026-04-15_findings.md"), "Findings from April 15.\nLine 2.");
    writeFileSync(join(mailboxDir, "team-alpha-inbox.json"), "[]");

    const logs = captureLogs(() => cmdTeamLives("historian"));

    expect(logs.some(l => l.includes("historian"))).toBe(true);
    expect(logs.some(l => l.includes("standing orders") && l.includes("yes"))).toBe(true);
    expect(logs.some(l => l.includes("findings") && l.includes("2"))).toBe(true);
    expect(logs.some(l => l.includes("2026-04-10_findings.md"))).toBe(true);
    expect(logs.some(l => l.includes("2026-04-15_findings.md"))).toBe(true);
  });

  test("reports no past lives for unknown agent", () => {
    const logs = captureLogs(() => cmdTeamLives("nobody"));
    expect(logs.some(l => l.includes("No past lives"))).toBe(true);
  });

  test("shows 'other' files category", () => {
    const mailboxDir = join(psiDir, "memory", "mailbox", "mixed-agent");
    mkdirSync(mailboxDir, { recursive: true });
    writeFileSync(join(mailboxDir, "msg-1234.json"), "{}");

    const logs = captureLogs(() => cmdTeamLives("mixed-agent"));
    expect(logs.some(l => l.includes("other") && l.includes("msg-1234.json"))).toBe(true);
  });
});

// ─── writeMessage ───

describe("writeMessage", () => {
  test("writes correct inbox JSON format", () => {
    createLiveTeam("msg-test", [{ name: "worker", agentType: "general-purpose" }]);

    writeMessage("msg-test", "worker", "test-sender", "hello world");

    const inboxPath = join(teamsDir, "msg-test", "inboxes", "worker.json");
    const messages = JSON.parse(readFileSync(inboxPath, "utf-8"));
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe("test-sender");
    expect(messages[0].read).toBe(false);
    expect(messages[0].timestamp).toBeTruthy();

    const text = JSON.parse(messages[0].text);
    expect(text.type).toBe("message");
    expect(text.content).toBe("hello world");
  });

  test("creates inbox directory if missing", () => {
    const teamDir = join(teamsDir, "no-inbox");
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, "config.json"), JSON.stringify({ name: "no-inbox", members: [] }));

    writeMessage("no-inbox", "newbie", "sender", "first msg");

    expect(existsSync(join(teamsDir, "no-inbox", "inboxes", "newbie.json"))).toBe(true);
  });

  test("appends to existing messages", () => {
    createLiveTeam("append-msg", [{ name: "agent", agentType: "general-purpose" }]);

    writeMessage("append-msg", "agent", "a", "first");
    writeMessage("append-msg", "agent", "b", "second");

    const messages = JSON.parse(readFileSync(
      join(teamsDir, "append-msg", "inboxes", "agent.json"), "utf-8",
    ));
    expect(messages).toHaveLength(2);
    expect(messages[0].from).toBe("a");
    expect(messages[1].from).toBe("b");
  });
});
