---
name: erpnext
description: >
  Operate the self-hosted ERPNext v16 trial on <host-a> (two AU entities,
  <entity-a> + <entity-b>, GST 10%, AUD, April fiscal year).
  Use when the user asks about the books, ERPNext, GST, invoices, GL, companies,
  or wants to run/report through the ERPNext REST/MCP API. Covers stack layout,
  credentials, bench commands, the PostgreSQL patches applied, and the
  vLLM do-not-touch boundary.
---

# erpnext (trial)

Self-hosted **ERPNext v16.34.2** (Frappe + PostgreSQL 15 + Redis) running under
**rootless podman** on <host-a>, bound to `127.0.0.1:8899`. Trial data
for two Australian entities:

- `<entity-a>`
- `<entity-b>`

Both: country Australia, currency AUD, April-start fiscal years (2025-26,
2026-27), GST 10% (tax templates + rules per company).

## Layout

- Deployment: `/home/<user>/projects/erpnext/`
  - `ref/` — cloned `frappe/frappe_docker` (compose files live here)
  - `.env`, `.adminpw` — DB + admin creds (600)
  - `CREDENTIALS.md` — full credential reference (600)
  - `scripts/patch-postgres-groupby.py` — PG GROUP BY patch (idempotent)
- Site name: `books.erpnext.local`, HTTP `http://127.0.0.1:8899`
- DB: postgres container `erp-db-1`, db/user `<db-name>`
- Worktree (this skill): `~/projects/jarate` (a git worktree of this repo)

## Containers (9, all on the `erpnet` podman network)

`erp-db-1` (postgres), 2x redis (cache + queue), `erp-backend-1` (bench web +
workers + gunicorn on :8000), `erp-frontend-1` (nginx :8080 -> published
127.0.0.1:8899), websocket, queues, scheduler, configurator.

```bash
cd /home/<user>/projects/erpnext/ref   # compose files are here
podman compose ps                      # status
podman compose up -d                   # start
podman logs erp-backend-1 --tail 50
```

Bench lives **inside** `erp-backend-1` at `/home/frappe/frappe-bench`.

```bash
podman exec -it erp-backend-1 bench --site books.erpnext.local console
podman exec erp-backend-1 bench --site books.erpnext.local execute <mod.fn>
```

## Credentials (see CREDENTIALS.md for the full set)

- Web: `http://127.0.0.1:8899`, `Administrator` / `<admin-pass>`
- REST/MCP user: `mcp@books.erpnext.local`
  - API key `<api-key>` / secret `<api-secret>`
  - Roles: Accounts User, Report Manager, Accounts Manager
- DB root: `postgres` / `<db-pass>`, db `<db-name>`

Quick REST check:

```bash
curl -u <api-key>:<api-secret> \
  http://127.0.0.1:8899/api/resource/Company
```

## MCP (proven working)

`@casys/mcp-erpnext` (stdio, 125 tools). Client test harness:
`/tmp/mcp-erpnext-test/mcp-test.mjs` (bun). Env:

```
ERPNEXT_URL=http://127.0.0.1:8899
ERPNEXT_API_KEY=<api-key>
ERPNEXT_API_SECRET=<api-secret>
```

Tools used to verify: `erpnext_company_list`, `erpnext_doc_get`,
`erpnext_sales_invoice_get`, `erpnext_customer_list`.

## The PostgreSQL patches (trial-local, re-apply after any bench code update)

ERPNext v16 assumes MySQL's permissive `ONLY_FULL_GROUP_BY`-off semantics. On
Postgres three spots broke. Patches are **source edits inside the container**
(they live in `erp-backend-1`'s bench, not a mounted volume) — they survive
`podman restart` but NOT an image re-pull / `bench update`. Re-apply:

```bash
# 1) GROUP BY in get_voucher_outstandings CTEs (accounts/utils.py)
podman cp /home/<user>/projects/erpnext/scripts/patch-postgres-groupby.py \
  erp-backend-1:/tmp/patch-postgres-groupby.py
podman exec erp-backend-1 python3 /tmp/patch-postgres-groupby.py

# 2) validate_against_pcv MAX() + 3) delinked bool->int (accounts/general_ledger.py
#    + accounts/utils.py) — applied inline; see scripts/patch-pcv.py and
#    scripts/patch-delimked.py in the deploy dir if preserved.
```

What each fixed:

1. **GROUP BY** — `query_voucher_amount` / `query_voucher_outstanding` selected
   `account, posting_date, due_date, currency, cost_center, remarks` but only
   grouped by `(voucher_type, voucher_no, party_type, party)`. PG rejects
   non-aggregated, non-grouped columns. Fix: add the selected columns to the
   GROUP BY. (Broke invoice `submit`.)
2. **Period Closing Voucher MAX** — `frappe.db.get_value(..., [{"MAX":
   "period_end_date"}])` compiled to a GROUP BY that included `creation`.
   Replaced with explicit `select max(period_end_date) ...` SQL.
3. **delinked bool** — `qb.update(ple).set(ple.delinked, True)` rendered
   `true` (boolean) into a `smallint` column. Changed to `.set(ple.delinked, 1)`.
   (Broke invoice `cancel`.)

## vLLM boundary

The inference GPU (RTX 5000 Pro) and the **vLLM** container on this host serve
`orcarouter/Qwen3.8-27B-Uncensored-FP8` for the model that runs monky. **Never
touch vLLM** (compose files, containers, restarts, context/flag changes)
without explicit operator instruction. "Set your context to X" = pi/switchboard,
NOT the model server. ERPNext runs on podman in its own network; leave vLLM's
docker/podman compose and its GPU alone.

## Trial data (kept)

- Item `Test Widget`, Customer `Test Customer` (customer kept on purpose)
- Invoice `ACC-SINV-2026-00001`: created via REST -> submitted (GL posted,
  balanced) -> cancelled via REST (GL reversed). Proof the full AU/GST bookkeeping
  path works end to end.
