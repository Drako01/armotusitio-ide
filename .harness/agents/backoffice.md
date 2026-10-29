# backoffice

> Generated from `../manifests/agents.json`. Edit the manifest, then run `pnpm harness:agents-doc`.

**Execution mode:** write within scope (Codex `workspace-write`; Claude `acceptEdits`)
**Token budget:** 8000

## Responsibilities

- Implement the Next.js 16 backoffice under apps/backoffice, the provider portal under apps/provider-portal and the sales portal under apps/sales-portal
- Consume only typed contracts that exist in docs/api/openapi.yaml; never invent endpoints
- Deliver responsive, accessible enterprise UX without native alert/confirm/prompt

## Allowed paths

- apps/backoffice/**
- apps/provider-portal/**
- apps/sales-portal/**

## Forbidden paths

- none

## Skills

- typescript-frontend
- frontend-portals

## Context sources

- apps/backoffice/package.json
- docs/api/openapi.yaml

## Verification

- pnpm --dir apps/backoffice typecheck
- pnpm --dir apps/backoffice lint
- pnpm --dir apps/backoffice test:critical
- pnpm --dir apps/backoffice build
