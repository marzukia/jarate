# Secrets — {{PROJECT}}

Canonical secrets inventory. One row per env var. Keep in sync with
`.env.example` in both directions: a var read by the code must appear in
all three places — the code, `.env.example`, and this table — in the
same PR.

| Var | Required | Dev default | Source of real value |
| --- | --- | --- | --- |
| <!-- VAR --> | yes/no | <!-- safe value or — --> | <!-- where the real one lives --> |

Rules:

- No secrets in code, ever. Env vars only.
- A committed secret is a BLOCKER: rotate it, then remove it.
- Dev defaults in `.env.example` must be safe to commit (placeholders,
  not real values).
