import { listSessions, capture, sendKeys } from "./ssh";

export function startServer(port = 3456) {
  const html = Bun.file(import.meta.dir + "/ui.html");

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const cors = { "Access-Control-Allow-Origin": "*" };

      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: { ...cors, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type" },
        });
      }

      try {
        if (url.pathname === "/api/sessions") {
          return Response.json(await listSessions(), { headers: cors });
        }

        if (url.pathname === "/api/capture") {
          const target = url.searchParams.get("target");
          if (!target) return Response.json({ error: "target required" }, { status: 400, headers: cors });
          return Response.json({ content: await capture(target) }, { headers: cors });
        }

        if (url.pathname === "/api/send" && req.method === "POST") {
          const { target, text } = await req.json();
          if (!target || !text) return Response.json({ error: "target and text required" }, { status: 400, headers: cors });
          await sendKeys(target, text);
          return Response.json({ ok: true, target, text }, { headers: cors });
        }

        if (url.pathname === "/" || url.pathname === "/index.html") {
          return new Response(html, { headers: { "Content-Type": "text/html", ...cors } });
        }
      } catch (e: any) {
        return Response.json({ error: e.message }, { status: 500, headers: cors });
      }

      return new Response("Not found", { status: 404, headers: cors });
    },
  });

  console.log(`maw serve → http://localhost:${server.port}`);
  return server;
}
