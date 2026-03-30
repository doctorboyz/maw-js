import { Hono } from "hono";
import { readFileSync } from "fs";
import { join, dirname } from "path";

const MAW_ROOT = join(dirname(new URL(import.meta.url).pathname), "../..");

export const federationView = new Hono();

federationView.get("/", (c) => {
  const html = readFileSync(join(MAW_ROOT, "office/federation.html"), "utf-8");
  return c.html(html);
});
