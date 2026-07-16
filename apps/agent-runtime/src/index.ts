// Cactuly agent-runtime — orquestra o loop entre o SaaS Cactuly e o
// pipeline local (worker+developer autofix + pg-boss).
//
// Fluxo por iteração:
//   1. Puxa próxima tarefa via GET  /api/agent/jobs/next
//   2. Sincroniza config (LLM/GH/webhook) → tabela local organization_*
//   3. Enfileira no pg-boss local; o worker autofix consome como já faz
//   4. Aguarda conclusão (poll no Postgres local)
//   5. POST /api/agent/jobs/:id/result com o sumário
//
// Se algum passo falhar, marca o job como failed e segue.
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import { request } from "undici";

const STATE_FILE = process.env.CACTULY_STATE_FILE ?? "/data/agent-state.json";
const CACTULY_ENDPOINT = required("CACTULY_ENDPOINT");
const ENROLLMENT_TOKEN = process.env.CACTULY_ENROLLMENT_TOKEN;
const DATABASE_URL = required("DATABASE_URL");
const POLL_MS = Number(process.env.CACTULY_POLL_MS ?? 5000);

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Env ${name} é obrigatório`);
  return v;
}

type AgentState = {
  agent_id: string;
  organization_id: string;
  name: string;
  jwt: string;
};

async function loadState(): Promise<AgentState | null> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as AgentState;
  } catch {
    return null;
  }
}

async function saveState(state: AgentState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

async function enroll(): Promise<AgentState> {
  if (!ENROLLMENT_TOKEN)
    throw new Error(
      "sem estado salvo e CACTULY_ENROLLMENT_TOKEN não configurado — gere um token novo em /admin > Agents",
    );
  const res = await request(`${CACTULY_ENDPOINT}/api/agent/enroll`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ENROLLMENT_TOKEN}` },
  });
  if (res.statusCode !== 200) {
    const body = await res.body.text();
    throw new Error(`enroll falhou (${res.statusCode}): ${body}`);
  }
  const body = (await res.body.json()) as {
    agent_id: string;
    organization_id: string;
    name: string;
    token: string;
  };
  const state: AgentState = {
    agent_id: body.agent_id,
    organization_id: body.organization_id,
    name: body.name,
    jwt: body.token,
  };
  await saveState(state);
  console.log(`[cactuly] enrolled as agent=${state.name} (${state.agent_id})`);
  return state;
}

async function apiGet<T>(state: AgentState, path: string): Promise<T | null> {
  const res = await request(`${CACTULY_ENDPOINT}${path}`, {
    headers: { Authorization: `Bearer ${state.jwt}` },
  });
  if (res.statusCode === 204) return null;
  if (res.statusCode !== 200) {
    const t = await res.body.text();
    throw new Error(`GET ${path} (${res.statusCode}): ${t}`);
  }
  return (await res.body.json()) as T;
}

async function apiPost<T>(state: AgentState, path: string, body: unknown): Promise<T> {
  const res = await request(`${CACTULY_ENDPOINT}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${state.jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (res.statusCode !== 200) {
    const t = await res.body.text();
    throw new Error(`POST ${path} (${res.statusCode}): ${t}`);
  }
  return (await res.body.json()) as T;
}

// -- Placeholder de execução local. Aqui, no passo 7, entra a integração real:
//    enfileirar em pg-boss local + aguardar o worker autofix concluir.
async function runLocally(job: Record<string, unknown>): Promise<{
  status: "success" | "partial" | "failed";
  pr_url?: string;
  message?: string;
  findings_total?: number;
  findings_fixed?: number;
}> {
  // Stub temporário — o passo 7 do build-out substitui isso pela integração real
  // com o pipeline autofix (pg-boss + worker + developer).
  console.log(`[cactuly] job ${job.id} recebido, execução real ainda não conectada`);
  await sleep(200);
  return {
    status: "failed",
    message: "agent-runtime em modo stub — pipeline autofix ainda não conectado (passo 7)",
  };
}

async function pingDb(): Promise<void> {
  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();
  await c.query("select 1");
  await c.end();
}

async function main() {
  console.log("[cactuly] agent-runtime starting");
  await pingDb().catch((e) => {
    console.error("[cactuly] Postgres local indisponível:", e.message);
    process.exit(1);
  });

  let state = (await loadState()) ?? (await enroll());

  console.log(`[cactuly] polling ${CACTULY_ENDPOINT} a cada ${POLL_MS}ms`);
  while (true) {
    try {
      const next = await apiGet<{ job: Record<string, unknown> }>(state, "/api/agent/jobs/next");
      if (!next) {
        await sleep(POLL_MS);
        continue;
      }
      const job = next.job;
      const jobId = String(job.id);
      const result = await runLocally(job).catch((e) => ({
        status: "failed" as const,
        message: `erro na execução: ${e.message}`,
      }));
      await apiPost(state, `/api/agent/jobs/${jobId}/result`, result);
      console.log(`[cactuly] job ${jobId} → ${result.status}`);
    } catch (err) {
      console.error("[cactuly] loop error:", (err as Error).message);
      await sleep(POLL_MS);
    }
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
