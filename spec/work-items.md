# Control Plane Implementation Backlog — Work Items

**Version:** 1.0

Each work item is intentionally small enough for one implementation/review cycle. Every implementation agent must read `spec/architecture.md` and `spec/architecture-lock.md`, inspect the actual repository, work only on the assigned item, preserve module boundaries, and produce objective verification evidence.

## WORK-001 — Platform and Modular-Monolith Foundation
Objective: Establish TypeScript modular-monolith runtime, explicit module interfaces, worker execution, execution IDs, logging, metrics/error interfaces.
Dependencies: none
Verification: unit, async worker integration, static architecture tests.
Modules: `/platform`, `/api`.
Definition of done: reusable runtime and boundary checks are executable.

## WORK-002 — PostgreSQL, Redis, Object Storage
Objective: Establish authoritative PostgreSQL plus provider-neutral Redis and object-storage boundaries.
Dependencies: WORK-001
Verification: database recovery/integration, Redis worker, storage tests.
Modules: `/platform`.
Definition of done: persistence and supporting infrastructure are available without vendor coupling to domain modules.

## WORK-003 — Identity, Organizations, Tenant Isolation
Objective: Implement users, organizations, roles, permissions, authentication, server-side tenant isolation.
Dependencies: WORK-001, WORK-002
Verification: authorization, integration, security tests.
Modules: `/auth`, `/organizations`.
Definition of done: cross-tenant access is impossible through supported APIs.

## WORK-004 — Projects and Public API Foundation
Objective: Implement projects and `/v1` conventions: request IDs, idempotency, structured errors, pagination, async operation IDs.
Dependencies: WORK-002, WORK-003
Verification: API contract and integration tests.
Modules: `/projects`, `/api`.
Definition of done: customer-facing API foundation is stable.

## WORK-005 — Capability Contracts
Objective: Define provider-neutral capability identifiers, schemas, side-effect classes, versioning, idempotency and execution metadata.
Dependencies: WORK-004
Verification: schema, unit, integration, contract tests.
Modules: `/capabilities`.
Definition of done: capabilities exist independently of providers.

## WORK-006 — Provider Adapter Framework
Objective: Implement provider-neutral adapter interface, capability declarations, authentication/invocation contracts and provider isolation.
Dependencies: WORK-004, WORK-005
Verification: adapter contract and static boundary tests.
Modules: `/providers`, `/credentials`.
Definition of done: new providers can be added without changing capability semantics.

## WORK-007 — Marketplace Catalog
Objective: Implement normalized providers, provider-capability mappings, pricing, geography, health, declared/observed/verified/certified states.
Dependencies: WORK-005, WORK-006
Verification: persistence, API, catalog consistency tests.
Modules: `/catalog`, `/providers`.
Definition of done: provider-owned and platform-integrated offerings share one catalog model.

## WORK-008 — Policy Engine
Objective: Implement hard constraints, soft preferences and versioned policy evaluation.
Dependencies: WORK-003, WORK-005, WORK-007
Verification: deterministic policy tests and integration tests.
Modules: `/policies`.
Definition of done: hard filters and soft preferences are represented separately.

## WORK-009 — Eligibility Engine
Objective: Deterministically filter candidates by capability, policy, credentials, geography, quota, provider state and capability support, with explainable rejection reasons.
Dependencies: WORK-007, WORK-008
Verification: exhaustive unit and integration tests.
Modules: `/eligibility`.
Definition of done: only eligible candidates reach routing.

## WORK-010 — Connections and Credential Boundary
Objective: Implement tenant/provider connections and secure credential access/revocation.
Dependencies: WORK-003, WORK-006, WORK-009
Verification: security and credential lifecycle tests.
Modules: `/connections`, `/credentials`.
Definition of done: adapter access is scoped and secrets are never ordinary API data.

## WORK-011 — Goals and Outcome Contracts
Objective: Implement measurable objectives, maximize/minimize targets, hard goals, preferences and outcome metrics.
Dependencies: WORK-004, WORK-005
Verification: domain and API tests.
Modules: `/goals`, `/outcomes`.
Definition of done: execution can be evaluated against an explicit objective.

## WORK-012 — Plans and Immutable Strategies
Objective: Implement execution plans, immutable strategy versions, provenance and active strategy references.
Dependencies: WORK-009, WORK-011
Verification: persistence, immutability, integration tests.
Modules: `/plans`, `/strategies`.
Definition of done: every live execution can identify an exact strategy version.

## WORK-013 — Routing Engine
Objective: Rank only eligible candidates using observed performance and customer preferences, preserving underlying measurements and rationale.
Dependencies: WORK-009, WORK-012
Verification: deterministic routing, regression and integration tests.
Modules: `/routing`.
Definition of done: routing cannot select an ineligible provider.

## WORK-014 — Live Execution Engine
Objective: Implement capability invocation, bounded retries, timeouts, idempotency, circuit breakers, policy-driven fallback and execution lifecycle.
Dependencies: WORK-010, WORK-012, WORK-013
Verification: unit, integration, failure-injection, concurrency and idempotency tests.
Modules: `/executions`, `/routing`.
Definition of done: a real provider-backed capability executes safely.

## WORK-015 — Observation Pipeline
Objective: Record provider calls, timings, costs, failures, retries, fallback events, strategy IDs and execution context as durable observations.
Dependencies: WORK-014
Verification: unit, integration and retention/provenance tests.
Modules: `/observations`.
Definition of done: live executions produce queryable factual evidence.

## WORK-016 — Outcome Engine
Objective: Turn observations into business/technical outcomes and compare actual results against goal metrics.
Dependencies: WORK-011, WORK-015
Verification: deterministic outcome tests and integration tests.
Modules: `/outcomes`.
Definition of done: optimization can reason about outcomes rather than raw provider success only.

## WORK-017 — Evidence Repository and Decision Provenance
Objective: Link claims, observations, strategies, decisions and outcomes through durable evidence/provenance records.
Dependencies: WORK-015, WORK-016
Verification: evidence linkage and auditability tests.
Modules: `/evidence`.
Definition of done: material decisions remain explainable after strategy changes.

## WORK-018 — Human Observability Console
Objective: Build developer/operator UI for Goal → Strategy → Eligibility → Provider → Attempt → Observation → Outcome, including rejected candidates and rationale.
Dependencies: WORK-004, WORK-012, WORK-014, WORK-015, WORK-016, WORK-017
Verification: API contract, component and end-to-end UI tests.
Modules: web application/read APIs only.
Definition of done: a human can understand what CP is doing under the hood without database access.

## WORK-019 — Experiment Engine
Objective: Implement historical replay, simulation, shadowing, bounded canaries and experiment state transitions.
Dependencies: WORK-014, WORK-015, WORK-016, WORK-017
Verification: replay, side-effect safety, integration and failure-injection tests.
Modules: `/experiments`.
Definition of done: candidates can be evaluated without mutating the active production strategy.

## WORK-020 — Optimization Engine
Objective: Generate evidence-linked candidate strategy proposals from observations/outcomes without production mutation authority.
Dependencies: WORK-017, WORK-019
Verification: deterministic fixture evaluation, proposal validation and integration tests.
Modules: `/optimization`, `/llm` where applicable.
Definition of done: safer candidate improvements can be discovered asynchronously.

## WORK-021 — Strategy Promotion and Rollback
Objective: Implement validation gates, canary progression, promotion, rejection, rollback and audit.
Dependencies: WORK-019, WORK-020
Verification: state-machine, integration, failure/rollback and concurrency tests.
Modules: `/experiments`, `/plans`, `/audit`.
Definition of done: optimizer cannot activate a strategy directly and rollback works without optimizer availability.

## WORK-022 — Audit and Material Event Trail
Objective: Persist policy, strategy, promotion, rollback, provider certification, connection and operator actions as attributable append-oriented events.
Dependencies: WORK-003, WORK-017, WORK-021
Verification: integration and security tests.
Modules: `/audit`.
Definition of done: material control-plane actions are traceable.

## WORK-023 — Domain Events and Customer Webhooks
Objective: Implement signed outbound events, duplicate-safe inbound processing, bounded delivery retries and lifecycle event schemas.
Dependencies: WORK-014, WORK-019, WORK-022
Verification: webhook signature, duplicate, retry and contract tests.
Modules: `/webhooks`, `/events`.
Definition of done: asynchronous integration is first-class.

## WORK-024 — Developer SDK and DX
Objective: Provide typed SDKs, copy-pasteable examples, cURL examples, idempotency helpers, webhook verification helpers and stable error types.
Dependencies: WORK-004, WORK-014, WORK-023
Verification: SDK contract and example execution tests.
Modules: SDK packages and API tooling.
Definition of done: first capability invocation feels Stripe-like in simplicity.

## WORK-025 — Provider Self-Service Marketplace
Objective: Provide provider onboarding, capability registration, pricing/coverage submission and certification workflow.
Dependencies: WORK-006, WORK-007, WORK-022, WORK-023
Verification: onboarding, authorization, API and certification tests.
Modules: `/providers`, `/catalog`, `/connections`.
Definition of done: providers can onboard themselves without changing the architecture.

## WORK-026 — Platform-Operated Provider Integration Pipeline
Objective: Build internal tooling for CP to create adapters, map endpoints to capabilities, run contract tests, attach evidence, certify and publish providers without provider-side code.
Dependencies: WORK-006, WORK-007, WORK-025
Verification: adapter fixtures, contract tests, certification integration and static architecture tests.
Modules: `/providers`, `/catalog`, `/evidence`.
Out of scope: arbitrary scraping or unsafe browser automation.
Definition of done: provider integration never depends on provider participation.

## WORK-027 — End-to-End Control Plane Lifecycle
Objective: Prove the complete lifecycle from provider/capability registration through live execution, human inspection, candidate generation, safe experiment, promotion/rejection, rollback and durable evidence.
Dependencies: WORK-021, WORK-022, WORK-023, WORK-024, WORK-025, WORK-026
Verification: full integration and end-to-end suite.
Definition of done: the real lifecycle executes without bypassing architectural authority boundaries.

## Implementation order

Phase 1: WORK-001..004 foundation.

Phase 2: WORK-005..010 capability and marketplace substrate.

Phase 3: WORK-011..014 goals, strategy, routing and live execution.

Phase 4: WORK-015..018 observations, outcomes, evidence and human observability.

Phase 5: WORK-019..021 replay/simulation/shadow/canary/optimization/promotion.

Phase 6: WORK-022..026 audit, events, SDK, self-service marketplace and platform-operated integrations.

Phase 7: WORK-027 complete lifecycle proof.
