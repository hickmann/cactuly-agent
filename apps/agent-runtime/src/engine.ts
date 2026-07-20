// Motor de fix embutido: o mesmo motor do autofix (Claude Code headless via
// Agent SDK) rodando dentro do container do agente, sobre o repo já clonado
// pelo git.ts. Nada roda na central; ela só entrega fila e credenciais.
//
// A credencial chega vendor-neutral do cofre (ai_provider_configs). O SDK lê
// nomes de env específicos do provedor; essa ponte fica confinada aqui e a
// credencial vai só pro env do subprocesso da sessão, nunca pro env global.
import { relative } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { EngineInput, FixChange, FixOutcome, JobPayload } from "./git.js";

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

// Normaliza um achado do scanner (SARIF já digerido pela esteira) em uma linha
// legível pro motor; aceita objeto {rule_id, severity, file, line, message} ou string.
function formatFinding(f: unknown): string {
  if (typeof f === "string") return f.trim();
  if (f && typeof f === "object") {
    const o = f as Record<string, unknown>;
    const file = typeof o.file === "string" ? o.file : typeof o.path === "string" ? o.path : "";
    const line = Number(o.line) > 0 ? `:${Number(o.line)}` : "";
    const rule = typeof o.rule_id === "string" ? o.rule_id : typeof o.rule === "string" ? o.rule : "";
    const sev = typeof o.severity === "string" ? ` [${o.severity}]` : "";
    const msg = typeof o.message === "string" ? o.message : JSON.stringify(o);
    const loc = file ? `${file}${line}: ` : "";
    return `${loc}${rule ? `(${rule}${sev}) ` : ""}${msg}`.trim();
  }
  return String(f ?? "").trim();
}

// O motor não caça problemas: ele só corrige o que a esteira entregou como
// insumo (achados do scanner, comentários do PR, notas do painel). Sem insumo,
// retorna null e o job falha rápido sem abrir sessão de LLM.
function buildPrompt(payload: JobPayload, input: EngineInput): string | null {
  const findings = (Array.isArray(payload.findings) ? payload.findings : [])
    .map(formatFinding)
    .filter(Boolean);
  const comments = input.pr_comments.map((c) => c.trim()).filter(Boolean);
  const notes = payload.notes?.trim() ?? "";
  if (findings.length === 0 && comments.length === 0 && !notes) return null;

  const contexto =
    payload.mode === "existing_pr" && payload.pr_url
      ? `Contexto: a branch atual é a de um pull request aberto (${payload.pr_url}).`
      : payload.mode === "existing_branch" && payload.branch
        ? `Contexto: você está na branch ${payload.branch}.`
        : "Contexto: você está em uma branch de correção criada a partir da branch padrão.";

  const secoes: string[] = [];
  if (findings.length > 0)
    secoes.push(["Achados do scanner a corrigir:", ...findings.map((f) => `- ${f}`)].join("\n"));
  if (comments.length > 0)
    secoes.push(["Itens apontados nos comentários do PR:", ...comments.map((c) => `- ${c}`)].join("\n"));
  if (notes) secoes.push(`Instruções de quem pediu a análise:\n${notes}`);

  return [
    "Você é o CodeShield, o motor de correção automática de código da Cactuly.",
    "Seu único trabalho é resolver os erros apontados nos insumos abaixo. Nada além disso.",
    "Você está na raiz de um clone do repositório do cliente, na branch de trabalho correta.",
    contexto,
    "",
    secoes.join("\n\n"),
    "",
    "Regras:",
    "- Resolva somente os erros listados nos insumos acima. Não procure outros problemas, não faça melhorias nem adicione funcionalidades fora da lista.",
    "- Mudanças mínimas e de alta confiança; não refatore nem reformate além do necessário.",
    "- Se um item dos insumos for falso positivo ou inseguro de corrigir, pule e explique o porquê no resumo final.",
    "- Nunca execute git commit, git push nem crie PR; a entrega acontece fora desta sessão.",
    "- Não crie arquivos de relatório ou documentação; apenas corrija o código.",
    "- Não toque em segredos, chaves ou arquivos .env.",
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
  input: EngineInput,
  isAborted: () => boolean,
): Promise<FixOutcome> {
  if (!ai?.api_key)
    return {
      changes: [],
      engine_message:
        "sem credencial de IA configurada; adicione a chave do provedor LLM na Configuração do CodeShield",
    };

  const prompt = buildPrompt(payload, input);
  if (prompt === null)
    return {
      changes: [],
      engine_message:
        "sem insumos de análise: envie os achados do scanner (SARIF), comente no PR o que deve ser resolvido, ou descreva o pedido nas notas da análise",
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
      prompt,
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
