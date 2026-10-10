/**
 * csv-store.ts — CSV-based vault message store.
 *
 * Append-only protocol, Principle 1 (Nothing is Deleted).
 * Status updates rewrite the CSV (small files, git preserves history).
 *
 * CSV columns: msg_id,from,to,type,status,sent,accepted_at,completed_at,reply_to,body_file
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from "fs";
import { join } from "path";
import { loadConfig } from "../../../config";
import { loadFleet } from "../../shared/fleet-load";

// ─── Types ───────────────────────────────────────────────────────

export type VaultStatus = "pending" | "accepted" | "completed" | "failed";
export type VaultType = "task" | "query" | "escalation" | "info" | "result";

export interface VaultMessage {
  msg_id: string;
  from: string;
  to: string;
  type: VaultType;
  status: VaultStatus;
  sent: string;
  accepted_at: string;
  completed_at: string;
  reply_to: string;
  body_file: string;
}

// ─── CSV Header ──────────────────────────────────────────────────

const CSV_HEADER = "msg_id,from,to,type,status,sent,accepted_at,completed_at,reply_to,body_file";

// Counter for message IDs (reset on module reload)
let msgSeq = 0;

// ─── Path Resolution ─────────────────────────────────────────────

export function resolvePsiDir(): string {
  const config = loadConfig();
  if ((config as any).psiPath) return (config as any).psiPath;
  const localPsi = join(process.cwd(), "ψ");
  if (existsSync(localPsi)) return localPsi;
  return join(process.cwd(), "psi");
}

export function resolveInboxDir(): string {
  return join(resolvePsiDir(), "inbox");
}

export function resolveOutboxDir(): string {
  return join(resolvePsiDir(), "outbox");
}

export function resolveOraclePsiDir(oracleName: string): string | null {
  const fleet = loadFleet();
  for (const entry of fleet) {
    if (entry.name !== oracleName) continue;
    const root = entry.windows?.[0]?.root;
    if (root && existsSync(root)) {
      const psiDir = join(root, "ψ");
      if (existsSync(psiDir)) return psiDir;
    }
  }
  return null;
}

function csvPath(inboxDir: string): string {
  return join(inboxDir, "messages.csv");
}

// ─── Message ID Generation ───────────────────────────────────────

export function newMsgId(sender: string, inboxDir?: string): string {
  msgSeq++;
  // Use row count from CSV if available for per-inbox monotonic counter
  if (inboxDir) {
    const existing = loadMessages(inboxDir);
    msgSeq = Math.max(msgSeq, existing.length + 1);
  }
  const padded = String(msgSeq).padStart(3, "0");
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `MSG-${sender.toUpperCase()}-${ts}-${padded}`;
}

// ─── CSV Read/Write ──────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === ",") {
      result.push(current);
      current = "";
    } else if (ch === '"') {
      inQuotes = true;
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function escapeCSVField(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function rowToCSV(msg: VaultMessage): string {
  return [
    escapeCSVField(msg.msg_id),
    escapeCSVField(msg.from),
    escapeCSVField(msg.to),
    escapeCSVField(msg.type),
    escapeCSVField(msg.status),
    escapeCSVField(msg.sent),
    escapeCSVField(msg.accepted_at),
    escapeCSVField(msg.completed_at),
    escapeCSVField(msg.reply_to),
    escapeCSVField(msg.body_file),
  ].join(",");
}

/** Read all messages from CSV, latest status per msg_id wins */
export function loadMessages(inboxDir: string): VaultMessage[] {
  const cp = csvPath(inboxDir);
  if (!existsSync(cp)) return [];

  const raw = readFileSync(cp, "utf-8").trim();
  if (!raw) return [];

  const lines = raw.split("\n");
  // Skip header if present
  const start = lines[0].startsWith("msg_id,") ? 1 : 0;

  const seen = new Map<string, VaultMessage>();
  for (let i = start; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < 10) continue;
    const msg: VaultMessage = {
      msg_id: fields[0],
      from: fields[1],
      to: fields[2],
      type: fields[3] as VaultType,
      status: fields[4] as VaultStatus,
      sent: fields[5],
      accepted_at: fields[6],
      completed_at: fields[7],
      reply_to: fields[8],
      body_file: fields[9],
    };
    // Last row for a given msg_id wins (reflects latest status)
    seen.set(msg.msg_id, msg);
  }

  return [...seen.values()].sort(
    (a, b) => new Date(b.sent).getTime() - new Date(a.sent).getTime(),
  );
}

/** Append a message row to CSV */
export function appendMessage(inboxDir: string, msg: VaultMessage): void {
  if (!existsSync(inboxDir)) mkdirSync(inboxDir, { recursive: true });
  const cp = csvPath(inboxDir);
  if (!existsSync(cp)) {
    writeFileSync(cp, CSV_HEADER + "\n", "utf-8");
  }
  appendFileSync(cp, rowToCSV(msg) + "\n", "utf-8");
}

/** Update a message's status by appending a new row (append-only for audit). */
export function updateStatus(inboxDir: string, msgId: string, updates: Partial<VaultMessage>): VaultMessage | null {
  const msgs = loadMessages(inboxDir);
  const idx = msgs.findIndex(m => m.msg_id === msgId);
  if (idx < 0) return null;

  const updated = { ...msgs[idx], ...updates };
  appendMessage(inboxDir, updated);
  return updated;
}

/** Find a message by ID (prefix match supported) */
export function findMessage(inboxDir: string, idOrPrefix: string): VaultMessage | null {
  const msgs = loadMessages(inboxDir);
  // Exact match
  const exact = msgs.find(m => m.msg_id === idOrPrefix);
  if (exact) return exact;
  // Prefix match
  return msgs.find(m => m.msg_id.startsWith(idOrPrefix)) || null;
}

/** Write markdown body to companion file */
export function writeBodyFile(inboxDir: string, msgId: string, body: string): string {
  const filename = `${msgId}.body.md`;
  const filepath = join(inboxDir, filename);
  writeFileSync(filepath, body, "utf-8");
  return filename;
}

/** Read markdown body from companion file */
export function readBodyFile(inboxDir: string, bodyFile: string): string {
  const filepath = join(inboxDir, bodyFile);
  if (!existsSync(filepath)) return "";
  return readFileSync(filepath, "utf-8");
}
