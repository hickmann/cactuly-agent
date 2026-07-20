// Motor de fix embutido: o mesmo motor do autofix (Claude Code headless via
// Agent SDK) rodando dentro do container do agente, sobre o repo já clonado
// pelo git.ts. Nada roda na central; ela só entrega fila e credenciais.
//
// A credencial chega vendor-neutral do cofre (ai_provider_configs). O SDK lê
// nomes de env específicos do provedor; essa ponte fica confinada aqui e a
// credencial vai só pro env do subprocesso da sessão, nunca pro env global.
import { relative } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { FixChange, FixOutcome, JobPayload } from "./git.js";

export type AiCredential = {
  provider?: string | null;
  model?: string | null;
  base_url?: string | null;
  api_key?: string | null;
  allowed_models?: string[] | null;
  max_budget_usd?: number | null;
  max_turns?: number | null;
};

const DEFAULT_MAX_TURNS = 40;
const DEFAULT_MAX_BUDGET_USD = 5;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(Math.floor(n), max);
}

function buildPrompt(payload: JobPayload): string {
  const alvo =
    payload.mode === "existing_pr" && payload.pr_url
      ? `A branch atual é a de um pull request aberto (${payload.pr_url}). Corrija os problemas dessa branch.`
      : payload.mode === "existing_branch" && payload.branch
        ? `A branch atual (${payload.branch}) tem problemas a corrigir.`
        : "Revise o repositório e corrija problemas evidentes e de alta confiança.";
  const notes = payload.notes?.trim()
    ? `\nInstruções de quem pediu a análise:\n${payload.notes.trim()}\n`
    : "";
  return [
    "Você é o CodeShield, o motor de correção automática de código da Cactuly.",
    "Você está na raiz de um clone do repositório do cliente, na branch de trabalho correta.",
    "",
    alvo,
    notes,
    "Regras:",
    "- Mudanças mínimas e de alta confiança; não refatore nem reformate além do necessário.",
    "- Nunca execute git commit, git push nem crie PR; a entrega acontece fora desta sessão.",
    "- Não crie arquivos de relatório ou documentação; apenas corrija o código.",
    "- Não toque em segredos, chaves ou arquivos .env.",
    "- Se não houver nada seguro a corrigir, não altere nada e explique o porquê.",
    "",
    "Ao terminar, encerre a resposta com uma seção exatamente neste formato, uma linha por arquivo alterado:",
    "MUDANCAS:",
    "- caminho/do/arquivo: resumo curto do que mudou e por quê",
  ].join("\n");
}

// Extrai a lista de mudanças da seção MUDANCAS: do resumo final do agente;
// sem seção válida, cai nos arquivos tocados pelas ferramentas de edição.
function parseChanges(text: string, touched: Set<string>): FixChange[] {
  const out: FixChange[] = [];
  const idx = text.lastIndexOf("MUDANCAS:");
  if (idx >= 0) {
    for (const raw of text.slice(idx).split("\n").slice(1)) {
      const line = raw.trim();
      if (!line) continue;
      const m = /^[-*]\s+`?([^:`]+?)`?\s*:\s*(.+)$/.exec(line);
      if (m && m[1] && m[2]) out.push({ file: m[1].trim(), summary: m[2].trim() });
      else break;
    }
  }
  if (out.length > 0) return out;
  return [...touched].map((f) => ({ file: f, summary: "arquivo corrigido pelo CodeShield" }));
}

export async function runEngine(
  workdir: string,
  ai: AiCredential | null,
  payload: JobPayload,
  isAborted: () => boolean,
): Promise<FixOutcome> {
  if (!ai?.api_key)
    return {
      changes: [],
      engine_message:
        "sem credencial de IA configurada; adicione a chave do provedor LLM na Configuração do CodeShield",
    };

  const maxTurns = clampInt(ai.max_turns, 1, 200, DEFAULT_MAX_TURNS);
  const maxBudgetUsd = Number(ai.max_budget_usd) > 0 ? Number(ai.max_budget_usd) : DEFAULT_MAX_BUDGET_USD;

  const abort = new AbortController();
  const watchdog = setInterval(() => {
    if (isAborted()) abort.abort();
  }, 2000);

  const touched = new Set<string>();
  let resultText = "";
  let resultIsError = false;
  let costUsd: number | null = null;
  let stopSubtype = "";

  try {
    const stream = query({
      prompt: buildPrompt(payload),
      options: {
        cwd: workdir,
        allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
        permissionMode: "acceptEdits",
        maxTurns,
        maxBudgetUsd,
        model: ai.model || undefined,
        abortController: abort,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: ai.api_key,
          ...(ai.base_url ? { ANTHROPIC_BASE_URL: ai.base_url } : {}),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
          USE_BUILTIN_RIPGREP: "0",
        } as Record<string, string>,
      },
    });

    for await (const message of stream) {
      const m = message as Record<string, any>;
      if (m.type === "assistant") {
        for (const block of m.message?.content ?? []) {
          if (block?.type === "tool_use" && EDIT_TOOLS.has(String(block.name))) {
            const p = block.input?.file_path ?? block.input?.notebook_path;
            if (typeof p === "string" && p) {
              const rel = relative(workdir, p);
              if (rel && !rel.startsWith("..")) touched.add(rel);
            }
          }
        }
      } else if (m.type === "result") {
        resultIsError = Boolean(m.is_error);
        resultText = typeof m.result === "string" ? m.result : "";
        costUsd = typeof m.total_cost_usd === "number" ? m.total_cost_usd : null;
        stopSubtype = String(m.subtype ?? "");
      }
    }
  } catch (e) {
    if (isAborted()) return { changes: [], engine_message: "job cancelado pela central" };
    return { changes: [], engine_message: `motor de fix falhou: ${(e as Error).message}` };
  } finally {
    clearInterval(watchdog);
  }

  const custo = costUsd !== null ? ` (custo ~US$ ${costUsd.toFixed(2)})` : "";
  const parada = stopSubtype && stopSubtype !== "success" ? `; parada: ${stopSubtype}` : "";

  if (touched.size === 0) {
    const msg = resultText.trim().slice(0, 600) ||
      (resultIsError ? "o motor terminou com erro sem detalhar" : "o motor não propôs mudanças");
    return { changes: [], engine_message: `${msg}${custo}${parada}` };
  }

  const changes = parseChanges(resultText, touched);
  console.log(`[cactuly] motor de fix: ${touched.size} arquivo(s) alterado(s)${custo}${parada}`);
  return { changes, findings_fixed: changes.length };
}
