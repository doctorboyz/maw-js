import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { MAW_ROOT } from "../paths";

export const officeView = new Hono();

officeView.get("/dashboard", (c) => c.redirect("/#orbital"));
officeView.get("/office", (c) => c.redirect("/#office"));
officeView.get("/assets/*", serveStatic({ root: `${MAW_ROOT}/ui/office` }));
officeView.get("/office/*", serveStatic({
  root: MAW_ROOT,
  rewriteRequestPath: (p) => p.replace(/^\/office/, "/ui/office"),
}));
officeView.get("/", serveStatic({ root: `${MAW_ROOT}/ui/office`, path: "/index.html" }));
