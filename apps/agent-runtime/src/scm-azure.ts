// Implementação Azure DevOps do ScmProvider: REST de PRs e threads em
// api-version 7.1. base_url vem da conexão (organization_url) e cobre também
// Azure DevOps Server on-prem; project/repo saem do remote_url do repositório.
import { request } from "undici";
import type { GitCredential, RepositoryInfo } from "./git.js";
import type { CreatePrResult, PrHandle, PrInfo, PrRef, ScmProvider } from "./scm.js";

type AzurePrHandle = PrHandle & { project: string; repo: string };

type AzureRemote = { baseUrl: string; project: string; repo: string };

// Aceita https://dev.azure.com/{org}/{project}/_git/{repo} (com ou sem
// userinfo tipo org@dev.azure.com, que o clone dialog adiciona) e também o
// formato on-prem https://{server}/{collection}/{project}/_git/{repo}.
// Segmentos podem vir percent-encoded (projetos com espaço); guardamos
// decodificado e re-encodamos na hora de montar chamadas de API.
export function parseAzureRemoteUrl(url: string): AzureRemote | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  // new URL já separa userinfo em username/password; pathname fica limpo
  const segs = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
  const gi = segs.indexOf("_git");
  if (gi < 1 || gi + 1 >= segs.length) return null;
  let project: string;
  let repo: string;
  try {
    project = decodeURIComponent(segs[gi - 1]!);
    repo = decodeURIComponent(segs[gi + 1]!).replace(/\.git$/, "");
  } catch {
    return null;
  }
  if (!project || !repo) return null;
  // Tudo antes do projeto compõe a base (org no SaaS, collection no on-prem)
  const orgPath = segs.slice(0, gi - 1).join("/");
  const baseUrl = `${u.origin}${orgPath ? `/${orgPath}` : ""}`;
  return { baseUrl, project, repo };
}

function stripRefsHeads(ref: unknown): string {
  return String(ref ?? "").replace(/^refs\/heads\//, "");
}

export class AzureDevOpsProvider implements ScmProvider {
  private readonly cred: GitCredential;
  private readonly remote: AzureRemote | null;
  private readonly baseUrl: string;
  private readonly project: string;
  private readonly repo: string;

  constructor(cred: GitCredential, repository: RepositoryInfo) {
    this.cred = cred;
    this.remote = parseAzureRemoteUrl(repository.remote_url);
    // A URL da organização da conexão manda; o remote_url é o fallback
    this.baseUrl = (cred.base_url ?? "").replace(/\/+$/, "") || this.remote?.baseUrl || "";
    this.project = this.remote?.project || cred.project || "";
    this.repo = this.remote?.repo || "";
  }

  remoteUrlValid(): boolean {
    return this.remote !== null && Boolean(this.baseUrl && this.project && this.repo);
  }

  cloneAuthHeader(): string {
    // PAT como Basic com usuário vazio (diferente do x-access-token do GitHub)
    const basic = Buffer.from(`:${this.cred.token}`).toString("base64");
    return `AUTHORIZATION: basic ${basic}`;
  }

  parsePrUrl(prUrl: string): PrHandle | null {
    // Convenção web: {base}/{project}/_git/{repo}/pullrequest/{id}
    const m = /^https:\/\/[^\s]*\/([^/\s]+)\/_git\/([^/\s]+)\/pullrequest\/(\d+)/.exec(prUrl);
    if (!m || !m[1] || !m[2] || !m[3]) return null;
    let project: string;
    let repo: string;
    try {
      project = decodeURIComponent(m[1]);
      repo = decodeURIComponent(m[2]);
    } catch {
      return null;
    }
    const handle: AzurePrHandle = { project, repo, number: Number(m[3]) };
    return handle;
  }

  // Caminho da API de git do repositório, com segmentos re-encodados
  private repoApi(project: string, repo: string): string {
    return `/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}`;
  }

  private async ado(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: any }> {
    // api-version é obrigatório em TODA chamada; sem ele o Azure devolve 400
    const url = `${this.baseUrl}${path}${path.includes("?") ? "&" : "?"}api-version=7.1`;
    const doRequest = () =>
      request(url, {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`:${this.cred.token}`).toString("base64")}`,
          accept: "application/json",
          "user-agent": "codeshield-sast",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    let res = await doRequest();
    if (res.statusCode === 429) {
      // Rate limit: honra Retry-After uma única vez (teto de 60s) e refaz
      await res.body.text().catch(() => "");
      const ra = Number(res.headers["retry-after"]);
      const waitSec = Math.min(Number.isFinite(ra) && ra > 0 ? ra : 1, 60);
      await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
      res = await doRequest();
    }
    const text = await res.body.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.statusCode, data };
  }

  async getPr(handle: PrHandle): Promise<PrInfo> {
    const pr = handle as AzurePrHandle;
    const info = await this.ado("GET", `${this.repoApi(pr.project, pr.repo)}/pullrequests/${pr.number}`);
    return {
      status: info.status,
      headBranch: stripRefsHeads(info.data?.sourceRefName),
      baseBranch: stripRefsHeads(info.data?.targetRefName),
    };
  }

  async listPrComments(handle: PrHandle): Promise<string[]> {
    const pr = handle as AzurePrHandle;
    // Threads trazem comentários gerais e ancorados em arquivo; ignoramos os
    // de sistema, os apagados e os do próprio CodeShield
    const res = await this.ado("GET", `${this.repoApi(pr.project, pr.repo)}/pullRequests/${pr.number}/threads`);
    const threads = Array.isArray(res.data?.value) ? res.data.value : [];
    const out: string[] = [];
    for (const th of threads) {
      const filePath = String(th?.threadContext?.filePath ?? "").replace(/^\//, "");
      const line = th?.threadContext?.rightFileStart?.line;
      const loc = filePath ? `${filePath}${line ? `:${line}` : ""} — ` : "";
      const comments = Array.isArray(th?.comments) ? th.comments : [];
      for (const cm of comments) {
        if (cm?.commentType === "system" || cm?.isDeleted) continue;
        const content = String(cm?.content ?? "").trim();
        if (!content || content.startsWith("## CodeShield")) continue;
        out.push(`${loc}${cm?.author?.displayName ?? "?"}: ${content}`);
      }
    }
    return out;
  }

  async createPr(sourceBranch: string, targetBranch: string, title: string, body: string): Promise<CreatePrResult> {
    if (!this.remoteUrlValid()) return { outcome: "failed", httpStatus: 0 };
    const repoApi = this.repoApi(this.project, this.repo);
    const created = await this.ado("POST", `${repoApi}/pullrequests`, {
      sourceRefName: `refs/heads/${sourceBranch}`,
      targetRefName: `refs/heads/${targetBranch}`,
      title,
      description: body,
    });
    if (created.status === 201 || created.status === 200) {
      const id = Number(created.data?.pullRequestId ?? 0);
      return { outcome: "created", ref: { id, webUrl: this.prWebUrl(id) } };
    }
    // 409 TF401179: já existe PR ativo pra essa branch; encontra e devolve
    const open = await this.ado(
      "GET",
      `${repoApi}/pullrequests?searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${sourceBranch}`)}&searchCriteria.status=active`,
    );
    const existing = Array.isArray(open.data?.value) ? open.data.value[0] : null;
    if (existing?.pullRequestId) {
      const id = Number(existing.pullRequestId);
      return { outcome: "exists", ref: { id, webUrl: this.prWebUrl(id) } };
    }
    return { outcome: "failed", httpStatus: created.status };
  }

  async commentOnPr(handle: PrHandle, markdown: string): Promise<boolean> {
    const pr = handle as AzurePrHandle;
    // Enums numéricos na escrita: commentType 1 = texto, status 1 = ativo
    const res = await this.ado("POST", `${this.repoApi(pr.project, pr.repo)}/pullRequests/${pr.number}/threads`, {
      comments: [{ parentCommentId: 0, content: markdown, commentType: 1 }],
      status: 1,
    });
    return res.status >= 200 && res.status < 300;
  }

  prHandleFromRef(ref: PrRef): PrHandle {
    const handle: AzurePrHandle = { project: this.project, repo: this.repo, number: ref.id };
    return handle;
  }

  // URL web do PR (convenção de UI; a API não devolve pronta)
  private prWebUrl(id: number): string {
    return `${this.baseUrl}/${encodeURIComponent(this.project)}/_git/${encodeURIComponent(this.repo)}/pullrequest/${id}`;
  }
}
