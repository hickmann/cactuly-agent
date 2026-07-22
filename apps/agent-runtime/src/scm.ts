// Interface de provedor SCM: isola a API do forge (PRs e comentários) do
// fluxo git do executeJob. A implementação GitHub é o código extraído de
// git.ts; provedores novos entram por aqui sem tocar na orquestração.
import type { GitCredential, RepositoryInfo } from "./git.js";
import { AzureDevOpsProvider } from "./scm-azure.js";
import { GitHubProvider } from "./scm-github.js";

// Referência a um PR criado/encontrado pelo provedor
export type PrRef = { id: number; webUrl: string };

// Handle opaco de PR: o provedor guarda o que precisar além de number;
// executeJob só lê number (pra mensagens) e devolve o handle intacto
export type PrHandle = { number: number };

// Resultado da leitura de um PR; status é o HTTP status da consulta
export type PrInfo = { status: number; headBranch: string; baseBranch: string };

export type CreatePrResult =
  | { outcome: "created"; ref: PrRef }
  | { outcome: "exists"; ref: PrRef }
  | { outcome: "failed"; httpStatus: number };

export interface ScmProvider {
  // O remote_url do repositório é reconhecível por este provedor?
  remoteUrlValid(): boolean;
  // Valor do http.extraheader usado no clone/push (nunca token em URL)
  cloneAuthHeader(): string;
  parsePrUrl(prUrl: string): PrHandle | null;
  getPr(handle: PrHandle): Promise<PrInfo>;
  // Comentários formatados "arquivo:linha — autor: corpo", já sem os do CodeShield
  listPrComments(handle: PrHandle): Promise<string[]>;
  // Cria PR; se já existir um aberto pra branch, devolve outcome "exists"
  createPr(sourceBranch: string, targetBranch: string, title: string, body: string): Promise<CreatePrResult>;
  // true se o comentário foi criado
  commentOnPr(handle: PrHandle, markdown: string): Promise<boolean>;
  prHandleFromRef(ref: PrRef): PrHandle;
}

export function createProvider(cred: GitCredential, repository: RepositoryInfo): ScmProvider {
  if (cred.kind === "azure_devops") return new AzureDevOpsProvider(cred, repository);
  // GitHub cobre kind "pat", "github_app" e qualquer outro por enquanto
  return new GitHubProvider(cred, repository);
}
