// Implementação GitHub do ScmProvider: REST de PRs e comentários extraída de
// git.ts sem mudança de comportamento; api_base_url cobre GHE.
import { request } from "undici";
import type { GitCredential, RepositoryInfo } from "./git.js";
import type { CreatePrResult, PrHandle, PrInfo, PrRef, ScmProvider } from "./scm.js";

type GitHubPrHandle = PrHandle & { owner: string; repo: string };

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

export class GitHubProvider implements ScmProvider {
  private readonly cred: GitCredential;
  private readonly or: { owner: string; repo: string } | null;

  constructor(cred: GitCredential, repository: RepositoryInfo) {
    this.cred = cred;
    this.or = ownerRepo(repository.remote_url);
  }

  remoteUrlValid(): boolean {
    return this.or !== null;
  }

  cloneAuthHeader(): string {
    const basic = Buffer.from(`x-access-token:${this.cred.token}`).toString("base64");
    return `AUTHORIZATION: basic ${basic}`;
  }

  parsePrUrl(prUrl: string): PrHandle | null {
    const m = /^https:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(prUrl);
    if (!m || !m[1] || !m[2] || !m[3]) return null;
    const handle: GitHubPrHandle = { owner: m[1], repo: m[2], number: Number(m[3]) };
    return handle;
  }

  private async gh(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: any }> {
    const cred = this.cred;
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

  async getPr(handle: PrHandle): Promise<PrInfo> {
    const pr = handle as GitHubPrHandle;
    const info = await this.gh("GET", `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`);
    return {
      status: info.status,
      headBranch: String(info.data?.head?.ref ?? ""),
      baseBranch: String(info.data?.base?.ref ?? ""),
    };
  }

  async listPrComments(handle: PrHandle): Promise<string[]> {
    const pr = handle as GitHubPrHandle;
    // Comentários gerais e de linha, ignorando os do próprio CodeShield pra
    // não realimentar o que ele mesmo escreveu
    const [ic, rc] = await Promise.all([
      this.gh("GET", `/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments?per_page=50`),
      this.gh("GET", `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments?per_page=50`),
    ]);
    const fmt = (cm: any): string => {
      const loc = cm?.path ? `${cm.path}${cm.line ? `:${cm.line}` : ""} — ` : "";
      return `${loc}${cm?.user?.login ?? "?"}: ${String(cm?.body ?? "").trim()}`;
    };
    return [
      ...(Array.isArray(ic.data) ? ic.data : []),
      ...(Array.isArray(rc.data) ? rc.data : []),
    ]
      .filter((cm: any) => String(cm?.body ?? "").trim() && !String(cm?.body ?? "").startsWith("## CodeShield"))
      .map(fmt);
  }

  async createPr(sourceBranch: string, targetBranch: string, title: string, body: string): Promise<CreatePrResult> {
    if (!this.or) return { outcome: "failed", httpStatus: 0 };
    const created = await this.gh("POST", `/repos/${this.or.owner}/${this.or.repo}/pulls`, {
      title,
      head: sourceBranch,
      base: targetBranch,
      body,
    });
    if (created.status === 201) {
      return {
        outcome: "created",
        ref: { id: Number(created.data?.number ?? 0), webUrl: String(created.data?.html_url ?? "") },
      };
    }
    // 422: PR provavelmente já existe pra essa branch; encontra e devolve
    const open = await this.gh("GET", `/repos/${this.or.owner}/${this.or.repo}/pulls?head=${this.or.owner}:${sourceBranch}&state=open`);
    const existing = Array.isArray(open.data) ? open.data[0] : null;
    if (existing?.number) {
      return {
        outcome: "exists",
        ref: { id: Number(existing.number), webUrl: String(existing.html_url ?? "") },
      };
    }
    return { outcome: "failed", httpStatus: created.status };
  }

  async commentOnPr(handle: PrHandle, markdown: string): Promise<boolean> {
    const pr = handle as GitHubPrHandle;
    const cm = await this.gh("POST", `/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`, { body: markdown });
    return cm.status === 201;
  }

  prHandleFromRef(ref: PrRef): PrHandle {
    const handle: GitHubPrHandle = {
      owner: this.or?.owner ?? "",
      repo: this.or?.repo ?? "",
      number: ref.id,
    };
    return handle;
  }
}
