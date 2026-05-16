# Convenience targets for the multiserver stack.
#
# Daily use: make up / down / test
# Submission: make zip TEAM=NN  (requires a local submission.txt — see
# submission.txt.example for the format)

.PHONY: help up down restart logs test ci-test zip sha clean

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

up: ## Build and start the full stack (detached)
	docker compose up --build -d

down: ## Stop the stack and remove containers
	docker compose down

restart: down up ## Down + up

logs: ## Tail logs from all services
	docker compose logs -f

test: ## End-to-end smoke test (stack must be up)
	@./scripts/test.sh

ci-test: ## Up + smoke + down (full local CI cycle)
	docker compose up --build -d
	./scripts/test.sh
	docker compose down

zip: ## Build submission archive teamNN.zip (requires TEAM=NN, submission.txt)
ifndef TEAM
	$(error "TEAM is required. Usage: make zip TEAM=07")
endif
ifeq (,$(wildcard submission.txt))
	$(error "submission.txt is missing. Copy submission.txt.example and fill in your values.")
endif
	@echo "Building team$(TEAM).zip..."
	@if [ ! -f report/report.pdf ]; then echo "WARNING: report/report.pdf not found — submission zip will not include the report PDF."; fi
	@rm -rf team$(TEAM) team$(TEAM).zip
	@mkdir team$(TEAM)
	@cp -R \
		app \
		nginx \
		scripts \
		.github \
		docker-compose.yml \
		Makefile \
		README.md \
		ARCHITECTURE.md \
		.gitignore \
		.dockerignore \
		.editorconfig \
		team$(TEAM)/
	@if [ -f report/report.pdf ] || [ -d report/screenshots ]; then mkdir -p team$(TEAM)/report; fi
	@if [ -f report/report.pdf ]; then cp report/report.pdf team$(TEAM)/report/; fi
	@if [ -d report/screenshots ]; then cp -R report/screenshots team$(TEAM)/report/; fi
	@printf '\n\n## Submission\n\n' >> team$(TEAM)/README.md
	@cat submission.txt >> team$(TEAM)/README.md
	@zip -r team$(TEAM).zip team$(TEAM) >/dev/null
	@rm -rf team$(TEAM)
	@echo "Wrote team$(TEAM).zip ($$(du -h team$(TEAM).zip | cut -f1))"

sha: ## Print SHA-256 of teamNN.zip (requires TEAM=NN)
ifndef TEAM
	$(error "TEAM is required. Usage: make sha TEAM=07")
endif
	@if command -v sha256sum >/dev/null 2>&1; then sha256sum team$(TEAM).zip; else shasum -a 256 team$(TEAM).zip; fi

clean: ## Remove generated artifacts and stop the stack
	-docker compose down -v 2>/dev/null
	rm -rf team*.zip
