// Orquestração git de um job de fix: clone, checkout, engine, commit, push,
// PR e comentário. O token chega efêmero no contexto do job e nunca vai pra
// disco: a autenticação é via http.extraheader por comando, o remote fica limpo.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";
import { request } from "undici";

const exec = promisify(execFile);

export type GitCredential = {
  kind: string;
  token: string;
  api_base_url?: string | null;
  commit_author_name?: string | null;
  commit_author_email?: string | null;
};

export type RepositoryInfo = { id: string; remote_url: string; default_branch: string };

export type JobPayload = {
  mode?: string;
  pr_url?: string | null;
  pr_number?: number | null;
  branch?: string | null;
  notes?: string | null;
  findings?: unknown[] | null;
};

// Insumos coletados pela orquestração e entregues ao motor de fix; o motor
// só corrige o que veio de insumo, nunca caça problemas por conta própria.
export type EngineInput = { pr_comments: string[] };

export type FixChange = { file: string; summary: string };

export type FixOutcome = {
  changes: FixChange[];
  findings_total?: number;
  findings_fixed?: number;
  engine_message?: string;
};

export type JobResult = {
  status: "success" | "partial" | "failed";
  pr_url?: string;
  message?: string;
  findings_total?: number;
  findings_fixed?: number;
};

// ---------------------------------------------------------------------------
// git via execFile (sem shell) com auth por header; nada de token em URL
// ---------------------------------------------------------------------------
async function git(cred: GitCredential | null, cwd: string | undefined, ...args: string[]): Promise<string> {
  const base: string[] = [];
  if (cred) {
    const basic = Buffer.from(`x-access-token:${cred.token}`).toString("base64");
    base.push("-c", `http.extraheader=AUTHORIZATION: basic ${basic}`);
  }
  const { stdout } = await exec("git", [...base, ...args], {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

function ownerRepo(url: string): { owner: string; repo: string } | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

function parsePrUrl(prUrl: string): { owner: string; repo: string; number: number } | null {
  const m = /^https:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(prUrl);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

// ---------------------------------------------------------------------------
// GitHub REST (PRs e comentários); api_base_url cobre GHE
// ---------------------------------------------------------------------------
async function gh(
  cred: GitCredential,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const base = (cred.api_base_url || "https://api.github.com").replace(/\/+$/, "");
  const res = await request(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cred.token}`,
      accept: "application/vnd.github+json",
      "user-agent": "cactuly-agent",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.body.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.statusCode, data };
}

function changesMarkdown(changes: FixChange[]): string {
  return changes.map((ch) => `- **${ch.file}**: ${ch.summary}`).join("\n");
}

// ---------------------------------------------------------------------------
// Fluxo principal
//   existing_pr: checkout na branch do PR, corrige, push, comenta no PR
//   existing_branch: checkout na branch, corrige, push, abre PR
//   new_pr: cria branch fix/... a partir da default, corrige, push, abre PR
// ---------------------------------------------------------------------------
export async function executeJob(
  jobId: string,
  payload: JobPayload,
  repository: RepositoryInfo | null,
  cred: GitCredential | null,
  dataDir: string,
  runEngine: (workdir: string, input: EngineInput) => Promise<FixOutcome>,
  isAborted: () => boolean,
): Promise<JobResult> {
  if (!repository)
    return { status: "failed", message: "job sem repositório vinculado; crie a análise pelo painel escolhendo um repositório" };
  if (!cred?.token)
    return { status: "failed", message: "sem credencial git; configure o GitHub App ou um token na Configuração" };

  const or = ownerRepo(repository.remote_url);
  if (!or) return { status: "failed", message: `remote_url inválido: ${repository.remote_url}` };

  const prUrl = payload.pr_url ?? null;
  const pr = prUrl ? parsePrUrl(prUrl) : null;
  if (prUrl && !pr) return { status: "failed", message: `pr_url inválido: ${prUrl}` };

  const mode = pr ? "existing_pr" : payload.branch ? "existing_branch" : "new_pr";

  // Branch de trabalho e branch base do clone
  let workBranch = payload.branch ?? null;
  let baseBranch = repository.default_branch || "main";
  const engineInput: EngineInput = { pr_comments: [] };
  if (mode === "existing_pr" && pr) {
    const info = await gh(cred, "GET", `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`);
    if (info.status !== 200)
      return { status: "failed", message: `não consegui ler o PR #${pr.number} (HTTP ${info.status}); confira o link e a permissão do token` };
    if (!workBranch) workBranch = String(info.data?.head?.ref ?? "");
    baseBranch = String(info.data?.base?.ref ?? baseBranch);
    if (!workBranch) return { status: "failed", message: "PR sem branch de origem identificável" };

    // Comentários do PR são insumo do motor: gerais e de linha, ignorando os
    // do próprio CodeShield pra não realimentar o que ele mesmo escreveu
    const [ic, rc] = await Promise.all([
      gh(cred, "GET", `/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments?per_page=50`),
      gh(cred, "GET", `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments?per_page=50`),
    ]);
    const fmt = (cm: any): string => {
      const loc = cm?.path ? `${cm.path}${cm.line ? `:${cm.line}` : ""} — ` : "";
      return `${loc}${cm?.user?.login ?? "?"}: ${String(cm?.body ?? "").trim()}`;
    };
    engineInput.pr_comments = [
      ...(Array.isArray(ic.data) ? ic.data : []),
      ...(Array.isArray(rc.data) ? rc.data : []),
    ]
      .filter((cm: any) => String(cm?.body ?? "").trim() && !String(cm?.body ?? "").startsWith("## CodeShield"))
      .map(fmt);
  }
  const cloneBranch = mode === "new_pr" ? baseBranch : workBranch!;
  if (mode === "new_pr") workBranch = `fix/codeshield-${jobId.slice(0, 8)}`;

  const workdir = `${dataDir}/jobs/${jobId}`;
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
  await mkdir(workdir, { recursive: true });

  try {
    try {
      await git(cred, undefined, "clone", "--depth", "50", "--branch", cloneBranch, "--single-branch", "--", repository.remote_url, workdir);
    } catch {
      return { status: "failed", message: `clone falhou (branch ${cloneBranch}): verifique se a branch existe e se a credencial acessa o repositório` };
    }

    const author = cred.commit_author_name || "Cactuly CodeShield";
    const email = cred.commit_author_email || "codeshield@cactuly.com";
    await git(null, workdir, "config", "user.name", author);
    await git(null, workdir, "config", "user.email", email);

    if (mode === "new_pr") await git(null, workdir, "checkout", "-b", workBranch!);
    if (isAborted()) return { status: "failed", message: "job cancelado pela central" };

    const outcome = await runEngine(workdir, engineInput);
    if (isAborted()) return { status: "failed", message: "job cancelado pela central" };

    const dirty = await git(null, workdir, "status", "--porcelain");
    if (!dirty) {
      return {
        status: "failed",
        message: outcome.engine_message ?? "nenhuma mudança produzida pelo pipeline",
        findings_total: outcome.findings_total,
        findings_fixed: outcome.findings_fixed,
      };
    }

    // Lista de mudanças: o engine descreve; sem descrição, cai no diff
    let changes = outcome.changes;
    if (changes.length === 0) {
      const files = dirty
        .split("\n")
        .map((l) => l.slice(3).trim())
        .filter(Boolean);
      changes = files.map((f) => ({ file: f, summary: "file fixed by CodeShield" }));
    }

    await git(null, workdir, "add", "-A");
    const commitBody = changes.map((ch) => `- ${ch.file}: ${ch.summary}`).join("\n");
    await git(null, workdir, "commit", "-m", `CodeShield: automated security fixes\n\n${commitBody}`);
    const sha = await git(null, workdir, "rev-parse", "--short", "HEAD");

    try {
      await git(cred, workdir, "push", "origin", `HEAD:${workBranch}`);
    } catch {
      return { status: "failed", message: `push para a branch ${workBranch} recusado; a branch pode ter avançado ou o token não tem permissão de escrita` };
    }

    const lista = changesMarkdown(changes);
    const rodape = payload.notes ? `\n\n> Request context: ${payload.notes}` : "";

    if (mode === "existing_pr" && pr) {
      const body = `## CodeShield applied fixes\n\nCommit \`${sha}\` on branch \`${workBranch}\`. What changed:\n\n${lista}${rodape}`;
      const cm = await gh(cred, "POST", `/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`, { body });
      const aviso = cm.status === 201 ? "" : "; não consegui comentar no PR (confira a permissão do token)";
      return {
        status: "success",
        pr_url: prUrl!,
        message: `correções enviadas para ${workBranch} (commit ${sha})${aviso}`,
        findings_total: outcome.findings_total,
        findings_fixed: outcome.findings_fixed,
      };
    }

    // existing_branch / new_pr: abre PR (ou comenta se já existir um aberto)
    const title = `CodeShield: automated security fixes on ${workBranch}`;
    const prBody = `Security fixes applied automatically by CodeShield. What changed:\n\n${lista}${rodape}`;
    const created = await gh(cred, "POST", `/repos/${or.owner}/${or.repo}/pulls`, {
      title,
      head: workBranch,
      base: baseBranch,
      body: prBody,
    });
    if (created.status === 201) {
      return {
        status: "success",
        pr_url: String(created.data?.html_url ?? ""),
        message: `PR aberto de ${workBranch} para ${baseBranch} (commit ${sha})`,
        findings_total: outcome.findings_total,
        findings_fixed: outcome.findings_fixed,
      };
    }
    // 422: PR provavelmente já existe pra essa branch; encontra e comenta
    const open = await gh(cred, "GET", `/repos/${or.owner}/${or.repo}/pulls?head=${or.owner}:${workBranch}&state=open`);
    const existing = Array.isArray(open.data) ? open.data[0] : null;
    if (existing?.number) {
      const body = `## CodeShield applied fixes\n\nCommit \`${sha}\`. What changed:\n\n${lista}${rodape}`;
      await gh(cred, "POST", `/repos/${or.owner}/${or.repo}/issues/${existing.number}/comments`, { body });
      return {
        status: "success",
        pr_url: String(existing.html_url ?? ""),
        message: `correções enviadas para ${workBranch}; PR já existia, comentei as mudanças (commit ${sha})`,
        findings_total: outcome.findings_total,
        findings_fixed: outcome.findings_fixed,
      };
    }
    return {
      status: "partial",
      message: `correções enviadas para ${workBranch} (commit ${sha}), mas a abertura do PR falhou (HTTP ${created.status})`,
      findings_total: outcome.findings_total,
      findings_fixed: outcome.findings_fixed,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
