SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

TSC := npx --no-install tsc

.PHONY: help setup check test clean

help: ## List the targets
	@grep -hE '^[a-z]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-8s %s\n", $$1, $$2}'

setup: ## Install dependencies (npm ci)
	npm ci

check: ## Type-check the plugin sources
	$(TSC) --noEmit

test: check ## Alias for check; the plugin has no runtime suite yet

clean: ## Remove installed dependencies
	rm -rf node_modules
