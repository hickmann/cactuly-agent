// Cactuly agent-runtime: worker self-hosted que conversa com a central
// exclusivamente via HTTPS outbound (nunca recebe conexão).
//
// Loops independentes:
//   - heartbeat: estado + métricas para a central; recebe licença,
//     config_version e comandos pendentes
//   - jobs: reserva com lease, executa local, reporta result idempotente
//
// O que este processo NUNCA tem: service role, chave privada do GitHub App,
// credencial BYOK persistida. Segredos chegam só no contexto efêmero de cada
// job e vivem apenas em memória durante a execução.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID, createHash, createHmac, randomBytes } from "node:crypto";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import { request } from "undici";
import {
  executeJob,
  type GitCredential,
  type JobPayload,
  type RepositoryInfo,
} from "./git.js";
import { runEngine, type AiCredential } from "./engine.js";
import { LocalQueue, type LocalJob } from "./queue.js";
import { startLocalApi } from "./localapi.js";

const RUNTIME_VERSION = "0.3.0";

// ---------------------------------------------------------------------------
// Bootstrap (spec 576-580): três variáveis + DATABASE_URL da infra local.
// Nomes antigos seguem aceitos com aviso de deprecated.
// ---------------------------------------------------------------------------
function envOr(current: string, legacy: string): string | undefined {
  if (process.env[current]) return process.env[current];
  if (process.env[legacy]) {
    console.warn(`[cactuly] AVISO: ${legacy} está deprecated; use ${current}`);
    return process.env[legacy];
  }
  return undefined;
}

const API_URL = envOr("CACTULY_API_URL", "CACTULY_ENDPOINT");
if (!API_URL) {
  console.error("[cactuly] Env CACTULY_API_URL é obrigatório");
  process.exit(1);
}
const ENROLLMENT_TOKEN = envOr("WORKER_ENROLLMENT_TOKEN", "CACTULY_ENROLLMENT_TOKEN");
const DATA_DIR = process.env.WORKER_DATA_DIRECTORY ?? "/data";
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[cactuly] Env DATABASE_URL é obrigatório");
  process.exit(1);
}
// Valores de partida; a central pode ajustar via poll_interval_seconds /
// heartbeat_interval_seconds nas respostas de /jobs/next e /heartbeat.
let POLL_MS = Number(process.env.CACTULY_POLL_MS ?? 5000);
let HEARTBEAT_MS = Number(process.env.CACTULY_HEARTBEAT_MS ?? 30000);

const STATE_FILE = `${DATA_DIR}/agent-state.json`;
const CONFIG_CACHE_FILE = `${DATA_DIR}/config-cache.json`;

// ---------------------------------------------------------------------------
// Estado persistido e em memória
// ---------------------------------------------------------------------------
type License = {
  active: boolean;
  plan?: string | null;
  status?: string;
  lease_seconds?: number;
  tolerance_seconds?: number;
};

type AgentState = {
  agent_id: string;
  organization_id: string;
  name: string;
  jwt: string;
  signing_secret?: string;
  license?: License | null;
  license_synced_at?: string | null;
};

type ConfigCache = {
  version: number;
  fetched_at: string;
  config: Record<string, unknown>;
  apply_modes: Record<string, string>;
};

let state: AgentState | null = null;
let cfg: ConfigCache | null = null;
let appliedVersion = 0;
let pendingDrainApply: ConfigCache | null = null;

let workerStatus: "active" | "paused" | "draining" = "active";
let authFailed = false;
let revoked = false;
let restartWhenIdle = false;
let stopping = false;

const metrics = { jobs_ok: 0, jobs_fail: 0 };
const runningJobs = new Map<string, { aborted: boolean }>();

// Fila local (modos local/custom). Reconstruída quando o modo muda ou quando
// a conexão quebra (no custom isso força refetch do DSN na central).
let localQueue: LocalQueue | null = null;
let localQueueBuiltFor: string | null = null;

async function loadJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function saveState(): Promise<void> {
  if (state) await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// HTTP com JWT + refresh (spec 189: credencial expira; renovar antes do exp)
// ---------------------------------------------------------------------------
type ApiResponse = { status: number; data: any; headers: Record<string, string> };

// Assinatura HMAC anti-replay (espelha apps/portal/src/signing.ts):
// HMAC(secret, method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + bodyHash).
// Sem signing_secret salvo (worker antigo, enrolled antes desta versão), a
// requisição sai sem os headers — a central em modo dual só loga e segue.
function signRequest(
  secret: string,
  method: string,
  path: string,
  bodyRaw: string,
): { timestamp: string; nonce: string; signature: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString("base64url");
  const bodyForHash = method === "GET" || method === "HEAD" ? "" : bodyRaw;
  const bodyHash = createHash("sha256").update(bodyForHash).digest("hex");
  const message = `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
  const signature = createHmac("sha256", secret).update(message).digest("hex");
  return { timestamp, nonce, signature };
}

async function rawRequest(method: string, path: string, token: string, body?: unknown): Promise<ApiResponse> {
  const bodyRaw = body !== undefined ? JSON.stringify(body) : "";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
  };
  if (state?.signing_secret) {
    const { timestamp, nonce, signature } = signRequest(state.signing_secret, method, path, bodyRaw);
    headers["X-Agent-Timestamp"] = timestamp;
    headers["X-Agent-Nonce"] = nonce;
    headers["X-Agent-Signature"] = signature;
  }
  const res = await request(`${API_URL}${path}`, {
    method: method as "GET" | "POST",
    headers,
    body: body !== undefined ? bodyRaw : undefined,
  });
  const resHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) resHeaders[k] = Array.isArray(v) ? v[0]! : String(v ?? "");
  if (res.statusCode === 429) {
    const retryAfter = Math.max(1, Number(resHeaders["retry-after"]) || 60);
    console.warn(`[cactuly] 429 (rate limit) de ${path}; aguardando ${retryAfter}s`);
    await sleep(retryAfter * 1000);
  }
  if (res.statusCode === 204) return { status: 204, data: null, headers: resHeaders };
  const text = await res.body.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.statusCode, data, headers: resHeaders };
}

function jwtExp(jwt: string): number {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : 0;
  } catch {
    return 0;
  }
}

// Renova o JWT quando faltar menos de 1h pro exp. Em falha 401 do refresh,
// a credencial foi rotacionada/revogada: modo auth_failed (para de reservar,
// segue tentando renovar em background).
async function refreshJwt(): Promise<boolean> {
  if (!state) return false;
  const r = await rawRequest("POST", "/api/agent/refresh", state.jwt);
  if (r.status === 200 && r.data?.token) {
    state.jwt = r.data.token;
    await saveState();
    authFailed = false;
    console.log("[cactuly] credencial renovada");
    return true;
  }
  if (r.status === 401) {
    if (!authFailed)
      console.error(
        "[cactuly] ERRO: credencial recusada pela central (revogada ou rotacionada). " +
          "Parando de reservar jobs. Reemita o token no painel se necessário.",
      );
    authFailed = true;
  }
  return false;
}

async function ensureFreshJwt(): Promise<void> {
  if (!state) return;
  const exp = jwtExp(state.jwt);
  // exp 0 = token legado sem expiração: rotaciona já pra um token com prazo
  if (exp === 0 || exp - Date.now() / 1000 < 3600) await refreshJwt();
}

// Chamada autenticada com uma tentativa de refresh no 401 (spec Fase 7)
async function api(method: string, path: string, body?: unknown): Promise<ApiResponse> {
  if (!state) return { status: 0, data: null, headers: {} };
  let r = await rawRequest(method, path, state.jwt, body);
  if (r.status === 401 && !authFailed) {
    const ok = await refreshJwt();
    if (ok) r = await rawRequest(method, path, state.jwt, body);
    else return { status: 401, data: null, headers: {} };
  }
  return r;
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------
async function enroll(): Promise<AgentState> {
  if (!ENROLLMENT_TOKEN) {
    throw new Error(
      "sem estado salvo e WORKER_ENROLLMENT_TOKEN não configurado: gere um token no painel (Workers)",
    );
  }
  const res = await request(`${API_URL}/api/agent/enroll`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ENROLLMENT_TOKEN}` },
  });
  const body: any = await res.body.json().catch(() => null);
  if (res.statusCode !== 200)
    throw new Error(`enroll falhou (${res.statusCode}): ${JSON.stringify(body)}`);
  const s: AgentState = {
    agent_id: body.agent_id,
    organization_id: body.organization_id,
    name: body.name,
    jwt: body.token,
    signing_secret: body.signing_secret,
  };
  state = s;
  await saveState();
  console.log(`[cactuly] enrolled como worker=${s.name} (${s.agent_id})`);
  return s;
}

// ---------------------------------------------------------------------------
// Licença e modo restrito (spec 205-210): sem sync válido além da tolerância,
// termina os jobs correntes e para de reservar; segue tentando sincronizar.
// ---------------------------------------------------------------------------
function isRestricted(): { restricted: boolean; reason: string } {
  const lic = state?.license;
  if (!lic) return { restricted: true, reason: "licença nunca sincronizada" };
  if (!lic.active) return { restricted: true, reason: `assinatura ${lic.status ?? "inativa"}` };
  const syncedAt = state?.license_synced_at ? new Date(state.license_synced_at).getTime() : 0;
  const tolerance = (lic.tolerance_seconds ?? 3600) * 1000;
  if (Date.now() - syncedAt > tolerance)
    return { restricted: true, reason: "central inalcançável além da tolerância" };
  return { restricted: false, reason: "" };
}

let wasRestricted = false;
function logRestrictedTransition(): void {
  const { restricted, reason } = isRestricted();
  if (restricted && !wasRestricted)
    console.warn(`[cactuly] modo restrito: ${reason}; jobs correntes terminam, novos não são reservados`);
  if (!restricted && wasRestricted) console.log("[cactuly] modo restrito encerrado; operação normal");
  wasRestricted = restricted;
}

// ---------------------------------------------------------------------------
// Configuração versionada (spec 712-729): cache offline + applied report.
// apply_mode: dynamic aplica na hora; drain espera a fila local esvaziar;
// restart só loga a instrução (limites de container exigem recriação).
// ---------------------------------------------------------------------------
const APPLY_RANK: Record<string, number> = { dynamic: 0, drain: 1, restart: 2 };

function cfgValue<T>(key: string, fallback: T): T {
  const v = cfg?.config?.[key];
  return v === undefined || v === null ? fallback : (v as T);
}

async function reportApplied(version: number, status: "applied" | "failed" | "requires_restart", error?: string) {
  await api("POST", "/api/agent/configuration/applied", { version, status, error }).catch(() => {});
}

function activateConfig(next: ConfigCache): void {
  cfg = next;
  appliedVersion = next.version;
  console.log(`[cactuly] configuração v${next.version} aplicada (log_level=${next.config.log_level ?? "info"})`);
}

async function syncConfiguration(): Promise<void> {
  const r = await api("GET", "/api/agent/configuration");
  if (r.status !== 200 || typeof r.data?.version !== "number") return;
  const next: ConfigCache = {
    version: r.data.version,
    fetched_at: new Date().toISOString(),
    config: r.data.config ?? {},
    apply_modes: r.data.apply_modes ?? {},
  };

  // Modo de aplicação = o mais restritivo entre as chaves que mudaram.
  // Sem config prévia (primeiro boot, sem cache) tudo é config de nascimento:
  // aplica como dynamic; drain/restart só fazem sentido pra MUDANÇA em voo.
  let mode = "dynamic";
  if (cfg) {
    const prev = cfg.config;
    for (const key of new Set([...Object.keys(prev), ...Object.keys(next.config)])) {
      if (JSON.stringify(prev[key]) !== JSON.stringify(next.config[key])) {
        const m = next.apply_modes[key] ?? "dynamic";
        if ((APPLY_RANK[m] ?? 0) > (APPLY_RANK[mode] ?? 0)) mode = m;
      }
    }
  }

  await writeFile(CONFIG_CACHE_FILE, JSON.stringify(next, null, 2), "utf8").catch(() => {});

  if (mode === "restart") {
    activateConfig(next); // valores dynamic aproveitam; limites físicos não
    console.warn("[cactuly] configuração exige recriação do container (limites de cpu/mem); recrie com docker compose up -d --force-recreate");
    await reportApplied(next.version, "requires_restart");
  } else if (mode === "drain" && runningJobs.size > 0) {
    pendingDrainApply = next;
    console.log(`[cactuly] configuração v${next.version} aguarda fila local esvaziar (drain)`);
  } else {
    activateConfig(next);
    await reportApplied(next.version, "applied");
  }
}

async function maybeApplyPendingDrain(): Promise<void> {
  if (pendingDrainApply && runningJobs.size === 0) {
    const next = pendingDrainApply;
    pendingDrainApply = null;
    activateConfig(next);
    await reportApplied(next.version, "applied");
  }
}

// ---------------------------------------------------------------------------
// Comandos: lista fechada (spec 318). Switch exaustivo; default = failed.
// Nada aqui executa shell: todo efeito é mudança de estado interno ou log.
// ---------------------------------------------------------------------------
type Command = { id: string; type: string; payload: Record<string, unknown> | null };

async function executeCommand(cmd: Command): Promise<{ ok: boolean; error?: string }> {
  switch (cmd.type) {
    case "pause":
      workerStatus = "paused";
      console.log("[cactuly] comando: pause");
      return { ok: true };
    case "resume":
      workerStatus = "active";
      restartWhenIdle = false;
      console.log("[cactuly] comando: resume");
      return { ok: true };
    case "drain":
      workerStatus = "draining";
      console.log("[cactuly] comando: drain (termina correntes, não reserva novos)");
      return { ok: true };
    case "restart_after_jobs":
      restartWhenIdle = true;
      console.log("[cactuly] comando: restart_after_jobs (sai quando a fila local esvaziar)");
      return { ok: true };
    case "update_config":
      await syncConfiguration();
      return { ok: true };
    case "update_version":
      console.log(`[cactuly] comando: update_version ${JSON.stringify(cmd.payload ?? {})}; atualize AGENT_RUNTIME_TAG no .env e recrie o container`);
      return { ok: true };
    case "revoke":
      revoked = true;
      console.error("[cactuly] comando: revoke; este worker foi desativado pela central");
      return { ok: true };
    case "sync_license":
      // O heartbeat seguinte ressincroniza; nada extra a fazer aqui
      return { ok: true };
    case "cancel_job": {
      const jobId = String(cmd.payload?.job_id ?? "");
      const running = runningJobs.get(jobId);
      if (running) {
        running.aborted = true;
        console.log(`[cactuly] comando: cancel_job ${jobId} (abortando execução local)`);
      }
      return { ok: true };
    }
    case "reprocess_job":
      // Reprocesso é decidido na central (job volta pra fila); só confirma
      return { ok: true };
    case "collect_diagnostics":
      console.log(
        `[cactuly] diagnostics: version=${RUNTIME_VERSION} uptime_s=${Math.floor(process.uptime())} ` +
          `running_jobs=${runningJobs.size} status=${workerStatus} config_v=${appliedVersion} ` +
          `mem_rss_mb=${Math.round(process.memoryUsage().rss / 1048576)}`,
      );
      return { ok: true };
    default:
      console.error(`[cactuly] comando desconhecido recusado: ${cmd.type}`);
      return { ok: false, error: `tipo não suportado: ${cmd.type}` };
  }
}

async function processCommands(): Promise<void> {
  const r = await api("GET", "/api/agent/commands");
  if (r.status !== 200) return;
  for (const cmd of (r.data?.commands ?? []) as Command[]) {
    const result = await executeCommand(cmd).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    await api("POST", `/api/agent/commands/${cmd.id}/confirm`, result).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Heartbeat: estado + métricas; resposta traz licença, config e comandos
// ---------------------------------------------------------------------------
function capabilities() {
  return {
    cpu: os.cpus().length,
    mem: Math.round(os.totalmem() / 1048576),
    os: process.platform,
    arch: process.arch,
  };
}

// Jobs das filas local/custom contam na central (jobs/mês por organização):
// cada evento terminal fica no outbox do Postgres local e é enviado depois do
// heartbeat. Central offline = evento espera; envio é idempotente por job.
async function flushUsageOutbox(): Promise<void> {
  if (!localQueue) return;
  try {
    const pending = await localQueue.usagePending(100);
    if (pending.length === 0) return;
    const r = await api("POST", "/api/agent/usage", { events: pending });
    const accepted = Array.isArray(r.data?.accepted) ? (r.data.accepted as string[]) : [];
    if (r.status === 200 && accepted.length > 0) {
      await localQueue.usageMarkSent(accepted);
      console.log(`[cactuly] uso reportado à central: ${accepted.length} job(s)`);
    }
  } catch (err) {
    console.warn(`[cactuly] envio de uso adiado: ${(err as Error).message}`);
  }
}

// A central pode reduzir/ampliar o ritmo de polling por worker (poll_interval_seconds /
// heartbeat_interval_seconds) sem precisar de um novo deploy do runtime; ignora valores
// fora de uma faixa sã pra não virar um vetor de negação de serviço via resposta forjada.
function clampIntervalSeconds(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value)) * 1000;
}

async function heartbeatLoop(): Promise<void> {
  while (!stopping) {
    try {
      await ensureFreshJwt();
      if (!authFailed) {
        // Agregados da fila local viajam em capabilities.labels (a central
        // persiste labels; chaves soltas em capabilities são descartadas)
        let caps: Record<string, unknown> = capabilities();
        if (queueMode() !== "cactuly" && localQueue) {
          const agg = await localQueue.aggregates().catch(() => null);
          if (agg) caps = { ...caps, labels: { queue: { mode: queueMode(), ...agg } } };
        }
        const r = await api("POST", "/api/agent/heartbeat", {
          version: RUNTIME_VERSION,
          status: workerStatus,
          running_jobs: runningJobs.size,
          capabilities: caps,
          metrics: { ...metrics },
        });
        if (r.status === 200) {
          state!.license = r.data?.license ?? null;
          state!.license_synced_at = new Date().toISOString();
          await saveState();
          if (typeof r.data?.config_version === "number" && r.data.config_version !== appliedVersion && !pendingDrainApply)
            await syncConfiguration();
          if ((r.data?.commands_pending ?? 0) > 0) await processCommands();
          await flushUsageOutbox();
          const nextPoll = clampIntervalSeconds(r.data?.poll_interval_seconds, 2, 300);
          if (nextPoll !== null) POLL_MS = nextPoll;
          const nextHeartbeat = clampIntervalSeconds(r.data?.heartbeat_interval_seconds, 10, 600);
          if (nextHeartbeat !== null) HEARTBEAT_MS = nextHeartbeat;
        }
      } else {
        // Tenta recuperar a credencial periodicamente
        await refreshJwt();
      }
    } catch (err) {
      console.warn(`[cactuly] heartbeat falhou (central offline?): ${(err as Error).message}`);
    }
    logRestrictedTransition();
    await sleep(HEARTBEAT_MS);
  }
}

// ---------------------------------------------------------------------------
// Execução local. O contexto traz segredos efêmeros: nunca logar, nunca
// persistir. O motor de fix (engine.ts) é o mesmo do autofix: sessão headless
// via Agent SDK, com a chave BYOK da organização.
// ---------------------------------------------------------------------------
async function runLocally(
  job: Record<string, unknown>,
  context: Record<string, unknown> | null,
  jobState: { aborted: boolean },
): Promise<{
  status: "success" | "partial" | "failed";
  pr_url?: string;
  message?: string;
  findings_total?: number;
  findings_fixed?: number;
}> {
  const ctx = context ?? {};
  console.log(
    `[cactuly] job ${job.id}: contexto ai=${ctx.ai ? "presente" : "ausente"} ` +
      `git=${(ctx.git as Record<string, unknown> | null)?.kind ?? "ausente"} ` +
      `repo=${(ctx.repository as Record<string, unknown> | null)?.id ?? "n/a"}`,
  );
  if (jobState.aborted) return { status: "failed", message: "job cancelado pela central" };
  const payload = (job.payload ?? {}) as JobPayload;
  return executeJob(
    String(job.id),
    payload,
    (ctx.repository as RepositoryInfo | null) ?? null,
    (ctx.git as GitCredential | null) ?? null,
    DATA_DIR,
    (workdir, engineInput) =>
      runEngine(workdir, (ctx.ai as AiCredential | null) ?? null, payload, engineInput, () => jobState.aborted),
    () => jobState.aborted,
  );
}

// ---------------------------------------------------------------------------
// Jobs: reserva, lease em lease/2, result idempotente com retry exponencial
// ---------------------------------------------------------------------------
async function postResultWithRetry(jobId: string, body: Record<string, unknown>): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await api("POST", `/api/agent/jobs/${jobId}/result`, body).catch(() => ({ status: 0, data: null, headers: {} }));
    if (r.status === 200) return;
    // 403/404: lease perdido ou job finalizado por outro caminho; não insistir
    if (r.status === 403 || r.status === 404) {
      console.warn(`[cactuly] result do job ${jobId} recusado (${r.status}); descartando`);
      return;
    }
    await sleep(1000 * 2 ** attempt);
  }
  console.error(`[cactuly] result do job ${jobId} não entregue após retries; a central vai requeue via lease`);
}

async function runJob(data: { job: Record<string, unknown>; context: Record<string, unknown> | null; lease_seconds: number }): Promise<void> {
  const jobId = String(data.job.id);
  const jobState = { aborted: false };
  runningJobs.set(jobId, jobState);

  const leaseMs = Math.max(5, (data.lease_seconds ?? 300) / 2) * 1000;
  const leaseTimer = setInterval(async () => {
    const r = await api("POST", `/api/agent/jobs/${jobId}/lease`, {}).catch(() => ({ status: 0, data: null, headers: {} }));
    if (r.status === 409) {
      jobState.aborted = true;
      console.warn(`[cactuly] lease do job ${jobId} perdido; abortando execução local`);
      clearInterval(leaseTimer);
    }
  }, leaseMs);

  try {
    const result = await runLocally(data.job, data.context, jobState).catch((e) => ({
      status: "failed" as const,
      message: `erro na execução: ${(e as Error).message}`,
    }));
    clearInterval(leaseTimer);
    if (!jobState.aborted) {
      await postResultWithRetry(jobId, { ...result, idempotency_key: randomUUID() });
      if (result.status === "success") metrics.jobs_ok++;
      else metrics.jobs_fail++;
      console.log(`[cactuly] job ${jobId} → ${result.status}`);
    }
  } finally {
    clearInterval(leaseTimer);
    runningJobs.delete(jobId);
    await maybeApplyPendingDrain();
    if (restartWhenIdle && runningJobs.size === 0) {
      console.log("[cactuly] fila local vazia; saindo para restart (docker recria o container)");
      process.exit(0);
    }
  }
}

// ---------------------------------------------------------------------------
// Fila local (spec: super admin define queue_mode por organização).
//   cactuly → fila central (comportamento clássico)
//   local   → Postgres do próprio compose vira a fila
//   custom  → Postgres do cliente; DSN chega selado da central e vive só
//             em memória (nunca em disco)
// Nos modos local/custom o job nasce e morre na rede do cliente; da central
// vêm apenas credenciais efêmeras via /execution-context.
// ---------------------------------------------------------------------------
const LOCAL_LEASE_SECONDS = 300;

function queueMode(): string {
  return String(cfgValue("queue_mode", "cactuly"));
}

async function dropLocalQueue(): Promise<void> {
  if (localQueue) {
    const q = localQueue;
    localQueue = null;
    localQueueBuiltFor = null;
    await q.close().catch(() => {});
  }
}

async function ensureLocalQueue(): Promise<LocalQueue | null> {
  const mode = queueMode();
  if (mode === "cactuly") {
    if (localQueue) {
      console.log("[cactuly] modo cactuly ativo; fechando fila local");
      await dropLocalQueue();
    }
    return null;
  }
  if (localQueue && localQueueBuiltFor === mode) return localQueue;
  await dropLocalQueue();

  let dsn: string;
  if (mode === "local") {
    dsn = DATABASE_URL!;
  } else {
    const r = await api("GET", "/api/agent/queue-db").catch(() => ({ status: 0, data: null as any, headers: {} }));
    if (r.status !== 200 || typeof r.data?.dsn !== "string") {
      console.warn(`[cactuly] modo custom sem DSN disponível (HTTP ${r.status}); configure o banco da fila no painel`);
      return null;
    }
    dsn = r.data.dsn; // só em memória, nunca em disco
  }

  const q = new LocalQueue(dsn, state?.agent_id ?? "worker");
  try {
    await q.init();
  } catch (e) {
    console.warn(`[cactuly] fila ${mode} indisponível: ${(e as Error).message}`);
    await q.close().catch(() => {});
    return null;
  }
  localQueue = q;
  localQueueBuiltFor = mode;
  console.log(`[cactuly] fila local pronta (modo ${mode})`);
  return q;
}

async function runLocalJob(q: LocalQueue, job: LocalJob): Promise<void> {
  const jobId = job.id;
  const jobState = { aborted: false };
  const startedAt = new Date().toISOString();
  runningJobs.set(jobId, jobState);

  const leaseTimer = setInterval(async () => {
    const ok = await q.renewLease(jobId, LOCAL_LEASE_SECONDS).catch(() => false);
    if (!ok) {
      jobState.aborted = true;
      console.warn(`[cactuly] lease local do job ${jobId} perdido; abortando execução`);
      clearInterval(leaseTimer);
    }
  }, (LOCAL_LEASE_SECONDS / 2) * 1000);

  try {
    // Só credenciais entram na rede do cliente: chamada efêmera à central
    // monta o contexto (git + chave de IA). Dados do job não saem daqui.
    const payload = job.payload ?? {};
    const rc = await api("POST", "/api/agent/execution-context", {
      remote_url: String(payload.remote_url ?? ""),
    }).catch(() => ({ status: 0, data: null as any, headers: {} }));
    const context = (rc.data?.context ?? null) as Record<string, unknown> | null;

    let result: {
      status: "success" | "partial" | "failed";
      pr_url?: string;
      message?: string;
      findings_total?: number;
      findings_fixed?: number;
    };
    if (!context) {
      result = {
        status: "failed",
        message: `contexto de execução indisponível na central (HTTP ${rc.status}): ${JSON.stringify(rc.data?.error ?? null)}`,
      };
    } else {
      result = await runLocally({ id: jobId, payload }, context, jobState).catch((e) => ({
        status: "failed" as const,
        message: `erro na execução: ${(e as Error).message}`,
      }));
    }

    clearInterval(leaseTimer);
    if (!jobState.aborted) {
      await q
        .report(
          jobId,
          result.status === "failed" ? "failed" : "completed",
          result as unknown as Record<string, unknown>,
          result.status === "failed" ? (result.message ?? null) : null,
          startedAt,
        )
        .catch((e) => console.error(`[cactuly] report local do job ${jobId} falhou: ${(e as Error).message}`));
      if (result.status === "success") metrics.jobs_ok++;
      else metrics.jobs_fail++;
      console.log(`[cactuly] job local ${jobId} → ${result.status}`);
    }
  } finally {
    clearInterval(leaseTimer);
    runningJobs.delete(jobId);
    await maybeApplyPendingDrain();
    if (restartWhenIdle && runningJobs.size === 0) {
      console.log("[cactuly] fila local vazia; saindo para restart (docker recria o container)");
      process.exit(0);
    }
  }
}

function canReserve(): boolean {
  if (authFailed || revoked || stopping) return false;
  if (workerStatus !== "active") return false;
  if (restartWhenIdle) return false;
  if (isRestricted().restricted) return false;
  if (cfgValue<boolean>("queue_paused", false)) return false;
  const maxConcurrent = Number(cfgValue("max_concurrent_jobs", 1)) || 1;
  return runningJobs.size < maxConcurrent;
}

async function jobLoop(): Promise<void> {
  while (!stopping) {
    if (!canReserve()) {
      await sleep(POLL_MS);
      continue;
    }
    try {
      if (queueMode() === "cactuly") {
        await dropLocalQueue();
        const r = await api("GET", "/api/agent/jobs/next");
        // Job encontrado: intervalo recomendado vem no corpo; sem job (204): vem no
        // header X-Poll-Interval-Seconds (204 não pode ter corpo).
        const nextPoll = clampIntervalSeconds(
          r.status === 200 ? r.data?.poll_interval_seconds : Number(r.headers["x-poll-interval-seconds"]),
          2,
          300,
        );
        if (nextPoll !== null) POLL_MS = nextPoll;
        if (r.status === 200 && r.data?.job) {
          // Não aguarda: permite concorrência até max_concurrent_jobs
          void runJob(r.data);
          continue;
        }
        if (r.status === 403)
          console.warn("[cactuly] reserva recusada pela central (licença); aguardando heartbeat");
      } else {
        const q = await ensureLocalQueue();
        if (q) {
          const job = await q.claimNext(LOCAL_LEASE_SECONDS).catch(async (e) => {
            console.warn(`[cactuly] claim na fila local falhou: ${(e as Error).message}`);
            await dropLocalQueue(); // reconecta (e refaz o fetch do DSN no custom)
            return null;
          });
          if (job) {
            void runLocalJob(q, job);
            continue;
          }
        }
      }
    } catch (err) {
      console.warn(`[cactuly] poll de jobs falhou: ${(err as Error).message}`);
    }
    await sleep(POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function pingDb(): Promise<void> {
  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();
  await c.query("select 1");
  await c.end();
}

async function main() {
  console.log(`[cactuly] agent-runtime v${RUNTIME_VERSION} iniciando (data dir: ${DATA_DIR})`);
  await mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  await pingDb().catch((e) => {
    console.error("[cactuly] Postgres local indisponível:", e.message);
    process.exit(1);
  });

  state = await loadJson<AgentState>(STATE_FILE);
  if (!state) state = await enroll();

  // Cache offline de configuração: opera com a última versão conhecida
  const cached = await loadJson<ConfigCache>(CONFIG_CACHE_FILE);
  if (cached) {
    cfg = cached;
    appliedVersion = cached.version;
    console.log(`[cactuly] configuração v${cached.version} carregada do cache local`);
  }
  logRestrictedTransition();

  startLocalApi({
    queueMode,
    getQueue: () => localQueue,
    maxAttempts: () => Number(cfgValue("retry_max_attempts", 3)) || 3,
  });

  console.log(`[cactuly] central: ${API_URL} (poll ${POLL_MS}ms, heartbeat ${HEARTBEAT_MS}ms)`);
  await Promise.all([heartbeatLoop(), jobLoop()]);
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`[cactuly] ${sig} recebido; encerrando após jobs correntes`);
    stopping = true;
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
