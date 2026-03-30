import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { MAW_ROOT } from "../paths";

export const bitView = new Hono();

bitView.get("/", serveStatic({ root: `${MAW_ROOT}/ui/8bit`, path: "/index.html" }));
bitView.get("/*", serveStatic({
  root: MAW_ROOT,
  rewriteRequestPath: (p) => p.replace(/^\/office-8bit/, "/ui/8bit"),
}));
