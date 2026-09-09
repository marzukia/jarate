# newrepo — fleet repo boilerplate

Instantiator: `scripts/init-repo.sh <dir> <owner/repo> [flags]`.

Placeholders rendered at init time:

| Token | Meaning |
| --- | --- |
| `{{PROJECT}}` | Human project name (default: repo name, titlecased) |
| `{{REPO}}` | Repo name (lowercase) |
| `{{OWNER}}` | GitHub owner (user or org) |
| `{{LEAD}}` | Project lead (name + how to reach) |
| `{{COMMIT_IDENTITY}}` | `name <email>` agents commit as |
| `{{STACK}}` | One-line stack description |

Flags: `--push` (gh repo create + push), `--private`, `--force`
(overwrite), `--dry-run`, `--biome` (keep the biome.json starter;
dropped by default), `--lead / --commit-identity / --stack /
--project / --remote`.

Wired at init: `git init -b main` + initial commit, commit identity,
`core.hooksPath=.git/hooks`, `pre-commit install` (when available).
Idempotent: refuses to clobber existing files unless `--force`;
`--dry-run` prints the plan and touches nothing.

After init, wire `LINT_CMD` / `TEST_CMD` in the Makefile before the
first merge.
