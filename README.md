# Cactuly agent

Docker-compose auto-contido que roda dentro da sua infra (VPS, on-prem, cluster interno) e consome a fila de tarefas do [Cactuly SaaS](https://cactuly-portal.atlasberg.workers.dev). Zero portas abertas — comunicação é sempre outbound (polling HTTPS).

## Como funciona

```
Sua infra                         Cactuly SaaS
┌─────────────────────┐           ┌───────────────────────┐
│ docker-compose      │           │ Portal Cactuly (CF)   │
│  postgres           │           │  /api/agent/*         │
│  agent-runtime  ────┼─── HTTPS ─┼──►  /jobs/next        │
│    (polling)        │           │      /jobs/:id/result │
│  worker (autofix)   │           │      /config          │
│  developer sandbox  │           │  Supabase             │
└─────────────────────┘           └───────────────────────┘
```

- **postgres**: Postgres 16 local. Guarda `pg-boss` (fila interna) e o histórico de execução (`agent_runs`, `tool_calls`). **Nunca sai da sua infra.**
- **agent-runtime**: ponte com o Cactuly. Faz enroll na inicialização, salva JWT permanente em `/data/agent-state.json`, e faz polling em `/api/agent/jobs/next`.
- **worker + developer** (planejado no passo 7 do build-out): rodam o pipeline autofix real, remedeiam o código com um agente Claude, commitam e abrem PR.

Segredos (chave LLM, GitHub token, webhook secret) são configurados no Cactuly SaaS via UI, criptografados no Supabase e entregues descriptografados via `/api/agent/config` **apenas** pra este agent enrolled. Nunca ficam plain-text no Cactuly.

## Instalação (script one-liner)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/hickmann/cactuly-agent/main/scripts/install.sh)
```

O script baixa o `docker-compose.yml`, gera `.env` com `POSTGRES_PASSWORD` random e te instrui a colar o enrollment token.

## Instalação manual

```bash
mkdir cactuly-agent && cd cactuly-agent
curl -fsSL https://raw.githubusercontent.com/hickmann/cactuly-agent/main/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/hickmann/cactuly-agent/main/.env.example -o .env
$EDITOR .env       # coloque CACTULY_ENROLLMENT_TOKEN e POSTGRES_PASSWORD
docker compose up -d
docker compose logs -f agent-runtime
```

Você verá `[cactuly] enrolled as agent=<seu-nome>` no log — depois disso, o token em `.env` pode ser removido (o JWT permanente já está salvo).

## Verificando

No portal Cactuly:
- **/admin > Agents**: o agent aparece "ativo", coluna "Último ping" atualiza a cada ~5s.

## Reset / re-enroll

Se precisar re-registrar (por exemplo em outra máquina):

```bash
docker compose down -v      # cuidado: apaga o Postgres local
```

Gere um novo enrollment token no Cactuly e recomece.

## Multi-tenant

Cada instalação = 1 agent = 1 organização. Um cliente que rodar múltiplos workers dentro da própria infra pode escalar réplicas do serviço `agent-runtime` no compose — todas vão puxar da mesma fila (concorrência natural via `FOR UPDATE SKIP LOCKED` no Cactuly).

## Roadmap

- [x] Enroll + polling + result reporting
- [ ] **Passo 7:** integração com worker+developer autofix (SARIF → PR)
- [ ] Retry policy + backoff exponencial
- [ ] Métricas Prometheus exportadas por default

## Licença

TBD.
