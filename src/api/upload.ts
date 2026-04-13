import { Elysia } from "elysia";
import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

const INBOX_DIR = join(homedir(), ".maw", "inbox");

/** Ensure inbox dir exists on first use */
function ensureInbox() {
  if (!existsSync(INBOX_DIR)) mkdirSync(INBOX_DIR, { recursive: true });
  return INBOX_DIR;
}

export const uploadApi = new Elysia();

/** POST /upload — accept a file via multipart form data */
uploadApi.post("/upload", async ({ body, set }) => {
  try {
    const file = (body as any)?.file;
    if (!file || !(file instanceof Blob)) {
      set.status = 400;
      return { error: "missing 'file' field — use: curl -F 'file=@image.png' /api/upload" };
    }
    const dir = ensureInbox();
    const name = (file as any).name || `upload-${Date.now()}`;
    const safeName = basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
    const dest = join(dir, safeName);

    // Write file to disk
    const buf = Buffer.from(await file.arrayBuffer());
    await Bun.write(dest, buf);

    const kb = (buf.length / 1024).toFixed(1);
    return { ok: true, path: dest, name: safeName, size: `${kb}KB` };
  } catch (e: any) {
    set.status = 500;
    return { error: e.message };
  }
});

/** GET /files — list inbox files */
uploadApi.get("/files", () => {
  const dir = ensureInbox();
  try {
    return readdirSync(dir).map((name) => {
      const st = statSync(join(dir, name));
      return { name, size: st.size, modified: st.mtime.toISOString() };
    });
  } catch {
    return [];
  }
});

/** GET /files/:name — download a file */
uploadApi.get("/files/:name", ({ params, set }) => {
  const filePath = join(ensureInbox(), basename(params.name));
  if (!existsSync(filePath)) { set.status = 404; return { error: "not found" }; }
  return Bun.file(filePath);
});

/** DELETE /files/:name — remove a file (moves to /tmp) */
uploadApi.delete("/files/:name", ({ params, set }) => {
  const filePath = join(ensureInbox(), basename(params.name));
  if (!existsSync(filePath)) { set.status = 404; return { error: "not found" }; }
  const archive = `/tmp/maw-inbox-${basename(params.name)}-${Date.now()}`;
  Bun.write(archive, Bun.file(filePath));
  unlinkSync(filePath);
  return { ok: true, archived: archive };
});
