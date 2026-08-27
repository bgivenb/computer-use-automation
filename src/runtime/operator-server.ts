import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { HumanAction, InterventionCoordinator, InterventionRequest } from "./intervention.js";

const humanActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), x: z.number().nonnegative(), y: z.number().nonnegative() }),
  z.object({ kind: z.literal("type"), text: z.string().max(2_000) }),
  z.object({ kind: z.literal("key"), key: z.string().min(1).max(40) }),
  z.object({ kind: z.literal("reload") }),
]);

const abortSchema = z.object({ reason: z.string().min(1).max(500) });

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
};

const sendHtml = (response: ServerResponse, status: number, html: string): void => {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  });
  response.end(html);
};

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const operatorPage = (intervention: InterventionRequest): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Operator handoff</title>
    <style>
      :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      * { box-sizing: border-box; }
      body { margin: 0; background: #0b1020; color: #e8ecf7; }
      header, aside { padding: 16px; }
      header { border-bottom: 1px solid #27314d; }
      main { display: grid; grid-template-columns: minmax(0, 1fr) 320px; min-height: calc(100vh - 86px); }
      figure { margin: 0; padding: 16px; overflow: auto; }
      img { width: 100%; height: auto; border: 1px solid #405071; cursor: crosshair; }
      aside { border-left: 1px solid #27314d; background: #11182b; }
      button, input { width: 100%; margin: 5px 0; padding: 10px; font: inherit; }
      button { cursor: pointer; background: #2463eb; color: white; border: 0; border-radius: 4px; }
      button.secondary { background: #33415f; }
      button.danger { background: #a52936; }
      code { color: #9cc2ff; }
      #status { min-height: 42px; color: #b8c7e6; }
    </style>
  </head>
  <body>
    <header>
      <strong>Human intervention</strong>
      <span> · ${escapeHtml(intervention.reason)} · session <code>${escapeHtml(intervention.sessionId)}</code></span>
      <div>${escapeHtml(intervention.summary)}</div>
    </header>
    <main>
      <figure><img id="screen" alt="Live target session"></figure>
      <aside>
        <button id="claim">Claim session</button>
        <input id="text" aria-label="Text to type" placeholder="Text to type">
        <button id="type" class="secondary">Type text</button>
        <button id="enter" class="secondary">Press Enter</button>
        <button id="reload" class="secondary">Reload</button>
        <button id="resume">Verify and resume</button>
        <button id="abort" class="danger">Abort run</button>
        <p id="status">Waiting for operator.</p>
      </aside>
    </main>
    <script>
      const id = ${JSON.stringify(intervention.id)};
      const screen = document.querySelector("#screen");
      const status = document.querySelector("#status");
      let claimed = false;

      const post = async (path, body) => {
        const response = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Request failed");
        return result;
      };

      const refresh = () => {
        screen.src = "/api/interventions/" + id + "/screenshot?t=" + Date.now();
      };

      document.querySelector("#claim").onclick = async () => {
        try { await post("/api/interventions/" + id + "/claim"); claimed = true; status.textContent = "You control the live target session."; refresh(); }
        catch (error) { status.textContent = error.message; }
      };
      screen.onclick = async (event) => {
        if (!claimed) return;
        const rect = screen.getBoundingClientRect();
        const x = (event.clientX - rect.left) * (screen.naturalWidth / rect.width);
        const y = (event.clientY - rect.top) * (screen.naturalHeight / rect.height);
        try { await post("/api/interventions/" + id + "/action", { kind: "click", x, y }); status.textContent = "Click recorded."; setTimeout(refresh, 150); }
        catch (error) { status.textContent = error.message; }
      };
      document.querySelector("#type").onclick = async () => {
        try { await post("/api/interventions/" + id + "/action", { kind: "type", text: document.querySelector("#text").value }); status.textContent = "Text recorded."; setTimeout(refresh, 150); }
        catch (error) { status.textContent = error.message; }
      };
      document.querySelector("#enter").onclick = async () => {
        try { await post("/api/interventions/" + id + "/action", { kind: "key", key: "Enter" }); status.textContent = "Enter recorded."; setTimeout(refresh, 150); }
        catch (error) { status.textContent = error.message; }
      };
      document.querySelector("#reload").onclick = async () => {
        try { await post("/api/interventions/" + id + "/action", { kind: "reload" }); status.textContent = "Reload recorded."; setTimeout(refresh, 300); }
        catch (error) { status.textContent = error.message; }
      };
      document.querySelector("#resume").onclick = async () => {
        try { await post("/api/interventions/" + id + "/resume"); status.textContent = "Checkpoint passed. Automation resumed."; claimed = false; }
        catch (error) { status.textContent = error.message; }
      };
      document.querySelector("#abort").onclick = async () => {
        try { await post("/api/interventions/" + id + "/abort", { reason: "Aborted by operator" }); status.textContent = "Run aborted."; claimed = false; }
        catch (error) { status.textContent = error.message; }
      };
      refresh();
      setInterval(() => { if (claimed) refresh(); }, 1000);
    </script>
  </body>
</html>`;

const indexPage = (interventions: InterventionRequest[]): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Interventions</title></head>
<body><h1>Pending interventions</h1><ul>${interventions
  .map(
    (item) =>
      `<li><a href="/operator/${encodeURIComponent(item.id)}">${escapeHtml(item.summary)}</a> (${escapeHtml(item.status)})</li>`,
  )
  .join("")}</ul></body></html>`;

export type OperatorServer = {
  origin: string;
  close: () => Promise<void>;
};

export const startOperatorServer = async (options: {
  coordinator: InterventionCoordinator;
  port?: number;
}): Promise<OperatorServer> => {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean);

      if (request.method === "GET" && url.pathname === "/") {
        sendHtml(response, 200, indexPage(options.coordinator.list()));
        return;
      }

      if (request.method === "GET" && parts[0] === "operator" && parts[1]) {
        const intervention = options.coordinator.get(parts[1]);
        if (!intervention) {
          sendHtml(response, 404, "<h1>Intervention not found</h1>");
          return;
        }
        sendHtml(response, 200, operatorPage(intervention));
        return;
      }

      if (parts[0] !== "api" || parts[1] !== "interventions" || !parts[2]) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      const id = parts[2];
      const action = parts[3];
      if (request.method === "GET" && action === undefined) {
        const intervention = options.coordinator.get(id);
        sendJson(response, intervention ? 200 : 404, intervention ?? { error: "Not found" });
        return;
      }
      if (request.method === "GET" && action === "screenshot") {
        const image = await options.coordinator.screenshot(id);
        response.writeHead(200, {
          "content-type": "image/png",
          "cache-control": "no-store",
        });
        response.end(image);
        return;
      }
      if (request.method === "POST" && action === "claim") {
        sendJson(response, 200, options.coordinator.claim(id));
        return;
      }
      if (request.method === "POST" && action === "action") {
        const parsed = humanActionSchema.parse(await readJson(request)) as HumanAction;
        await options.coordinator.act(id, parsed);
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "POST" && action === "resume") {
        sendJson(response, 200, await options.coordinator.resume(id));
        return;
      }
      if (request.method === "POST" && action === "abort") {
        const { reason } = abortSchema.parse(await readJson(request));
        sendJson(response, 200, await options.coordinator.abort(id, reason));
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Unknown request error",
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};
