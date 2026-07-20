# Cactuly agent

Docker-compose auto-contido que roda dentro da sua infra (VPS, on-prem, cluster interno) e consome a fila de tarefas do [Cactuly SaaS](https://cactuly.com). Zero portas abertas: comunicação é sempre outbound (polling HTTPS).

## Como funciona

```
Sua infra                         Cactuly SaaS
┌─────────────────────┐           ┌───────────────────────┐
│ docker-compose      │           │ Portal Cactuly (CF)   │
│  postgres           │           │  /api/agent/*         │
│  agent-runtime  ────┼─── HTTPS ─┼──►  /jobs/next        │
│    (polling)        │           │      /jobs/:id/result │
│  worker (autofix)   │           │      /heartbeat       │
│                     │           │      /configuration   │
│  developer sandbox  │           │  Supabase             │
└─────────────────────┘           └───────────────────────┘
```

- **postgres**: Postgres 16 local. Guarda `pg-boss` (fila interna) e o histórico de execução (`agent_runs`, `tool_calls`). **Nunca sai da sua infra.**
- **agent-runtime**: ponte com o Cactuly. Faz enroll na inicialização, salva o estado em `/data/agent-state.json`, renova o próprio JWT antes de expirar, envia heartbeat a cada 30s, sincroniza configuração versionada (com cache local para operar em caso de queda da central) e executa comandos remotos de uma lista fechada (pause, resume, drain, cancel_job, etc). O runtime **não executa shell**: todo comando é código próprio.
- **worker + developer** (próxima etapa): rodam o pipeline autofix real, remediam o código com um agente Claude, commitam e abrem PR.

Segredos (chave LLM BYOK, credencial Git) são configurados no Cactuly SaaS via UI, criptografados no cofre (Supabase) e entregues **por job**, no `context` de `GET /api/agent/jobs/next`, apenas pra este agent enrolled. Cada entrega fica registrada em log de acesso. Nada fica plain-text no Cactuly nem em disco no agent.

Sem licença ativa (ou com a central fora do ar além da tolerância), o agent entra em **modo restrito**: para de reservar jobs novos mas termina os que já estão rodando e continua tentando sincronizar.

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
$EDITOR .env       # coloque WORKER_ENROLLMENT_TOKEN e POSTGRES_PASSWORD
docker compose up -d
docker compose logs -f agent-runtime
```

Você verá `[cactuly] enrolled` no log. Depois disso, o token em `.env` pode ser removido: o JWT já está salvo em `/data` e o agent o renova sozinho.

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

Cada instalação = 1 agent = 1 organização. Um cliente que rodar múltiplos workers dentro da própria infra pode escalar réplicas do serviço `agent-runtime` no compose: todas vão puxar da mesma fila (concorrência natural via `FOR UPDATE SKIP LOCKED` no Cactuly).

## Roadmap

- [x] Enroll + polling + result reporting
- [x] Heartbeat, lease de jobs, retry com backoff e idempotência
- [x] Configuração centralizada versionada com cache local
- [x] Canal de comandos (lista fechada) e modo restrito por licença
- [ ] Integração com worker+developer autofix (SARIF → PR)
- [ ] Métricas Prometheus exportadas por default

## Licença

TBD.
