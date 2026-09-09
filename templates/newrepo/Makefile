# {{REPO}} — Makefile
#
# One entry point for "is my branch green?". Wire the real commands
# below before the first merge; until then the targets echo a TODO and
# pass, so preflight still checks whitespace.
#
# Override per run: make lint LINT_CMD="cd server && uv run ruff check ."

# --- wire these -----------------------------------------------------------
LINT_CMD ?= @echo "TODO: wire LINT_CMD (e.g. 'cd server && uv run ruff check .')"
TEST_CMD ?= @echo "TODO: wire TEST_CMD (e.g. 'cd server && uv run python -m pytest')"

# --- targets ---------------------------------------------------------------
.PHONY: help lint test preflight

help:
	@echo "{{REPO}} targets:"
	@echo ""
	@echo "  lint      Run the linter (LINT_CMD)"
	@echo "  test      Run the test suite (TEST_CMD)"
	@echo "  preflight git diff --check + lint + test. Run before every push."

lint:
	$(LINT_CMD)

test:
	$(TEST_CMD)

# Cheap checks first (whitespace), tool-heavy last (lint, test). Any
# failure stops make; fix and re-run.
preflight:
	@echo ">>> git diff --check"
	@git diff --check
	@echo ""
	@echo ">>> lint"
	@$(LINT_CMD)
	@echo ""
	@echo ">>> test"
	@$(TEST_CMD)
	@echo ""
	@echo ">>> preflight clean"
