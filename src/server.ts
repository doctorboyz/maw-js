import { Hono } from "hono";
import { cors } from "hono/cors";
import { MawEngine } from "./engine";
import type { WSData } from "./types";
import { loadConfig } from "./config";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { api } from "./api";
import { feedBuffer, feedListeners } from "./api/feed";
import { mountViews } from "./views/index";
import { setupTriggerListener } from "./trigger-listener";

const app = new Hono();
app.use("/api/*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Private-Network", "true");
});
app.use("/api/*", cors());

app.route("/api", api);

mountViews(app);

app.onError((err, c) => c.json({ error: err.message }, 500));

export { app };

// --- WebSocket + Server ---

import { handlePtyMessage, handlePtyClose } from "./pty";

export function startServer(port = +(process.env.MAW_PORT || loadConfig().port || 3456)) {
  const engine = new MawEngine({ feedBuffer, feedListeners });

  // Hook workflow triggers into feed events
  setupTriggerListener(feedListeners);

  const wsHandler = {
    open: (ws: any) => {
      if (ws.data.mode === "pty") return;
      engine.handleOpen(ws);
    },
    message: (ws: any, msg: any) => {
      if (ws.data.mode === "pty") { handlePtyMessage(ws, msg); return; }
      engine.handleMessage(ws, msg);
    },
    close: (ws: any) => {
      if (ws.data.mode === "pty") { handlePtyClose(ws); return; }
      engine.handleClose(ws);
    },
  };

  const fetchHandler = (req: Request, server: any) => {
    const url = new URL(req.url);
    if (url.pathname === "/ws/pty") {
      if (server.upgrade(req, { data: { target: null, previewTargets: new Set(), mode: "pty" } as WSData })) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    if (url.pathname === "/ws") {
      if (server.upgrade(req, { data: { target: null, previewTargets: new Set() } as WSData })) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return app.fetch(req);
  };

  // HTTP server (always)
  const server = Bun.serve({ port, fetch: fetchHandler, websocket: wsHandler });
  console.log(`maw serve → http://localhost:${port} (ws://localhost:${port}/ws)`);

  // HTTPS server (if mkcert certs exist)
  const certPath = join(import.meta.dir, "../white.local+3.pem");
  const keyPath = join(import.meta.dir, "../white.local+3-key.pem");
  if (existsSync(certPath) && existsSync(keyPath)) {
    const tlsPort = port + 1;
    const tls = { cert: readFileSync(certPath), key: readFileSync(keyPath) };
    Bun.serve({ port: tlsPort, tls, fetch: fetchHandler, websocket: wsHandler });
    console.log(`maw serve → https://localhost:${tlsPort} (wss://localhost:${tlsPort}/ws) [TLS]`);
  }

  return server;
}

// Auto-start unless imported by CLI (CLI sets MAW_CLI=1)
if (!process.env.MAW_CLI) {
  startServer();
}
