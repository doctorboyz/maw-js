import type { Hono } from "hono";
import { federationView } from "./federation";
import { timemachineView } from "./timemachine";

// UI moved to Soul-Brews-Studio/maw-ui (dev server on :5173).
// Only keep standalone HTML views that are self-contained.
export function mountViews(app: Hono) {
  app.route("/timemachine", timemachineView);
  app.route("/federation", federationView);
}
