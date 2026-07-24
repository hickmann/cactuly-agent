// API local de jobs (modos local/custom): permite criar e consultar análises
// sem passar pela central. Só sobe quando CODESHIELD_LOCAL_API_TOKEN está
// definido; auth Bearer com comparação em tempo constante.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { LocalQueue } from "./queue.js";

export type LocalApiDeps = {
  queueMode: () => string;
  getQueue: () => LocalQueue | null;
  maxAttempts: () => number;
};

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_048_576) return null; // 1 MB é mais que suficiente
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function startLocalApi(deps: LocalApiDeps): void {
  const token = process.env.CODESHIELD_LOCAL_API_TOKEN ?? process.env.CACTULY_LOCAL_API_TOKEN;
  if (!token) {
    console.log("[codeshield-sast] API local de jobs desativada (CODESHIELD_LOCAL_API_TOKEN ausente)");
    return;
  }
  const port = Number(process.env.CODESHIELD_LOCAL_API_PORT ?? process.env.CACTULY_LOCAL_API_PORT ?? 8484);

  const server = http.createServer(async (req, res) => {
    try {
      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), token))
        return send(res, 401, { error: "não autorizado" });

      if (deps.queueMode() === "cactuly")
        return send(res, 409, {
          error: "fila local desativada: a organização está no modo cactuly (fila central)",
        });
      const queue = deps.getQueue();
      if (!queue) return send(res, 503, { error: "fila local ainda não inicializada" });

      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "POST" && url.pathname === "/jobs") {
        const body = await readBody(req);
        if (!body) return send(res, 400, { error: "body JSON inválido" });
        const remoteUrl = typeof body.remote_url === "string" ? body.remote_url.trim() : "";
        try {
          const parsed = new URL(remoteUrl);
          if (parsed.protocol !== "https:") throw new Error("protocolo");
        } catch {
          return send(res, 400, { error: "remote_url é obrigatório e deve ser uma URL https" });
        }
        const prUrl = typeof body.pr_url === "string" && body.pr_url ? body.pr_url : undefined;
        const branch = typeof body.branch === "string" && body.branch ? body.branch : undefined;
        const payload: Record<string, unknown> = {
          remote_url: remoteUrl,
          mode: prUrl ? "existing_pr" : branch ? "existing_branch" : "new_pr",
        };
        if (prUrl) payload.pr_url = prUrl;
        if (branch) payload.branch = branch;
        if (typeof body.notes === "string" && body.notes) payload.notes = body.notes;
        if (Array.isArray(body.findings)) payload.findings = body.findings;
        const job = await queue.enqueue(payload, deps.maxAttempts());
        return send(res, 201, { job });
      }

      if (req.method === "GET" && url.pathname === "/jobs") {
        return send(res, 200, { jobs: await queue.list(50) });
      }

      const m = url.pathname.match(/^\/jobs\/([0-9a-f-]{36})$/i);
      if (req.method === "GET" && m) {
        const job = await queue.get(m[1]!);
        if (!job) return send(res, 404, { error: "job não encontrado" });
        return send(res, 200, { job });
      }

      return send(res, 404, { error: "rota não encontrada" });
    } catch (err) {
      return send(res, 500, { error: `erro interno: ${(err as Error).message}` });
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[codeshield-sast] API local de jobs escutando em 0.0.0.0:${port}`);
  });
  server.unref();
}
