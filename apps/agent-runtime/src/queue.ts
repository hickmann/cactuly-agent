// Fila local do CodeShield (modos local/custom): o job nasce e morre na rede
// do cliente. Semântica espelha a fila central: claim atômico com SKIP LOCKED,
// lease renovável, retry por expiração de lease e dead letter ao esgotar
// tentativas. Result é terminal e idempotente.
import { Pool } from "pg";

export type LocalJob = {
  id: string;
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  last_error: string | null;
  attempt_count: number;
  max_attempts: number;
  created_at: string;
  finished_at: string | null;
};

export type QueueAggregates = {
  depth: number;
  running: number;
  completed_24h: number;
  failed_24h: number;
  dead_letter: number;
};

const SCHEMA = `
create table if not exists codeshield_jobs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'available'
    check (status in ('available','reserved','running','completed','failed','dead_letter','cancelled')),
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  last_error text,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  reserved_by text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists codeshield_jobs_claim_idx on codeshield_jobs (status, created_at);
`;

const JOB_COLUMNS =
  "id, status, payload, result, last_error, attempt_count, max_attempts, " +
  "created_at::text as created_at, finished_at::text as finished_at";

// Variante qualificada pro RETURNING do claim (o CTE candidato também expõe
// id/attempt_count/max_attempts; sem prefixo o Postgres acusa ambiguidade)
const JOB_COLUMNS_J = JOB_COLUMNS.replace(/(^|, )(\w)/g, "$1j.$2");

export class LocalQueue {
  private pool: Pool;
  private workerId: string;

  constructor(connectionString: string, workerId: string) {
    this.pool = new Pool({ connectionString, max: 4 });
    // Erros de conexões ociosas não podem derrubar o processo
    this.pool.on("error", () => {});
    this.workerId = workerId;
  }

  async init(): Promise<void> {
    await this.pool.query(SCHEMA);
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }

  async enqueue(payload: Record<string, unknown>, maxAttempts: number): Promise<LocalJob> {
    const r = await this.pool.query(
      `insert into codeshield_jobs (payload, max_attempts) values ($1::jsonb, $2)
       returning ${JOB_COLUMNS}`,
      [JSON.stringify(payload), Math.max(1, maxAttempts)],
    );
    return r.rows[0] as LocalJob;
  }

  // Claim atômico: pega o job disponível mais antigo OU um cujo lease expirou.
  // Lease expirado com tentativas esgotadas vira dead_letter (e o loop segue
  // para o próximo candidato). SKIP LOCKED garante que dois workers/conexões
  // nunca reservam o mesmo job.
  async claimNext(leaseSeconds: number): Promise<LocalJob | null> {
    for (let guard = 0; guard < 10; guard++) {
      const r = await this.pool.query(
        `with candidato as (
           select id, attempt_count, max_attempts from codeshield_jobs
           where status = 'available'
              or (status in ('reserved','running') and lease_expires_at < now())
           order by created_at
           limit 1
           for update skip locked
         )
         update codeshield_jobs j set
           status = case when c.attempt_count >= c.max_attempts then 'dead_letter' else 'reserved' end,
           attempt_count = case when c.attempt_count >= c.max_attempts then c.attempt_count else c.attempt_count + 1 end,
           reserved_by = case when c.attempt_count >= c.max_attempts then j.reserved_by else $1 end,
           lease_expires_at = case when c.attempt_count >= c.max_attempts then null
             else now() + make_interval(secs => $2) end,
           last_error = case when c.attempt_count >= c.max_attempts
             then coalesce(j.last_error, 'tentativas esgotadas apos lease expirado') else j.last_error end,
           finished_at = case when c.attempt_count >= c.max_attempts then now() else null end,
           updated_at = now()
         from candidato c
         where j.id = c.id
         returning ${JOB_COLUMNS_J}`,
        [this.workerId, leaseSeconds],
      );
      const job = r.rows[0] as LocalJob | undefined;
      if (!job) return null;
      if (job.status === "dead_letter") continue;
      return job;
    }
    return null;
  }

  // Renova o lease só se o job ainda é deste worker e o lease atual não
  // expirou. false = lease perdido: abortar a execução local.
  async renewLease(jobId: string, leaseSeconds: number): Promise<boolean> {
    const r = await this.pool.query(
      `update codeshield_jobs set
         status = 'running',
         lease_expires_at = now() + make_interval(secs => $3),
         updated_at = now()
       where id = $1 and reserved_by = $2
         and status in ('reserved','running')
         and lease_expires_at > now()`,
      [jobId, this.workerId, leaseSeconds],
    );
    return r.rowCount === 1;
  }

  // Terminal e idempotente: só transiciona a partir de reserved/running do
  // próprio worker; qualquer outro estado é no-op (result tardio descartado).
  async report(
    jobId: string,
    status: "completed" | "failed",
    result: Record<string, unknown> | null,
    lastError: string | null,
  ): Promise<void> {
    await this.pool.query(
      `update codeshield_jobs set
         status = $3, result = $4::jsonb, last_error = $5,
         lease_expires_at = null, finished_at = now(), updated_at = now()
       where id = $1 and reserved_by = $2 and status in ('reserved','running')`,
      [jobId, this.workerId, status, result ? JSON.stringify(result) : null, lastError],
    );
  }

  async get(id: string): Promise<LocalJob | null> {
    try {
      const r = await this.pool.query(
        `select ${JOB_COLUMNS} from codeshield_jobs where id = $1`,
        [id],
      );
      return (r.rows[0] as LocalJob | undefined) ?? null;
    } catch {
      return null; // id não é uuid válido
    }
  }

  async list(limit = 50): Promise<LocalJob[]> {
    const r = await this.pool.query(
      `select ${JOB_COLUMNS} from codeshield_jobs order by created_at desc limit $1`,
      [Math.min(Math.max(1, limit), 200)],
    );
    return r.rows as LocalJob[];
  }

  async aggregates(): Promise<QueueAggregates> {
    const r = await this.pool.query(
      `select
         count(*) filter (where status = 'available') as depth,
         count(*) filter (where status in ('reserved','running')) as running,
         count(*) filter (where status = 'completed' and finished_at > now() - interval '24 hours') as completed_24h,
         count(*) filter (where status in ('failed','dead_letter') and finished_at > now() - interval '24 hours') as failed_24h,
         count(*) filter (where status = 'dead_letter') as dead_letter
       from codeshield_jobs`,
    );
    const row = r.rows[0] ?? {};
    return {
      depth: Number(row.depth ?? 0),
      running: Number(row.running ?? 0),
      completed_24h: Number(row.completed_24h ?? 0),
      failed_24h: Number(row.failed_24h ?? 0),
      dead_letter: Number(row.dead_letter ?? 0),
    };
  }
}
