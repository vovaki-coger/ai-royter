# NVIDIA AI Router

A private dashboard for connecting AI model providers and routing OpenAI-compatible requests through user-managed keys.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: Replit-managed `DATABASE_URL`, `SESSION_SECRET`, and Clerk keys provisioned by Replit Auth.
- Provider API keys are added in the app and encrypted before storage; do not place them in source files.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/ai-router` — React/Vite interface.
- `artifacts/api-server` — Express API and provider routing.
- `lib/db/src/schema/ai-router.ts` — PostgreSQL tables.
- `lib/api-spec/openapi.yaml` — API contract and generated client/schema packages.

## Architecture decisions

- Provider credentials are encrypted at rest with `SESSION_SECRET`.
- Each user's providers, router keys, models, and request history are scoped to their Clerk user ID.
- Publishing uses the autoscale target; the web artifact is static and `/api` is served by the API artifact.

## Product

Users can connect NVIDIA NIM, OpenRouter, DeepSeek, OpenAI, or compatible endpoints; discover models; create revocable router keys; and inspect request history.

## User preferences

- Preserve the uploaded app's existing interface and functionality.

## Gotchas

- The frontend expects Clerk's `/sign-in/*?` and `/sign-up/*?` routes and uses the `/api` proxy for backend calls.
- Development database schema is applied with `pnpm --filter @workspace/db run push`; Replit Publish applies the production schema diff.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
