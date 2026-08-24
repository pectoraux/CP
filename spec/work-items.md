# Control Plane Implementation Backlog — Work Items

**Version:** 1.0

Each work item is intentionally small enough for one implementation/review cycle and follows the WorkflowOS pattern: objective, dependencies, acceptance criteria, required verification, affected modules, out-of-scope boundary, and definition of done.

---

## WORK-001 — Platform and Modular-Monolith Foundation

**Objective:** Establish the TypeScript modular-monolith runtime, module boundary enforcement, execution context, asynchronous worker mechanism, logging, metrics interfaces, and error-tracking interfaces.

**Requirements:** PLAT-001, OBS-001, SEC-001

**Dependencies:** none

**Acceptance criteria:**
- PLAT-AC-01: frozen modules exist with public interfaces and private internals;
- PLAT-AC-02: forbidden cross-module imports are rejected by static checks;
- PLAT-AC-03: long-running jobs return without blocking the API;
- OBS-AC-01: execution IDs propagate into background jobs;
- OBS-AC-02: job-scoped logs carry execution/correlation identifiers.

**Required verification:** unit tests, async worker integration tests, static architecture checks.

**Modules:** `/platform`, `/api`.

**Out of scope:** domain logic and provider integrations.

**Definition of done:** reusable runtime foundation exists and boundaries are executable.

---

## WORK-002 — PostgreSQL, Redis, Object Storage

**Objective:** Establish authoritative persistence and supporting queue/artifact infrastructure.

**Requirements:** DATA-001..003

**Dependencies:** WORK-001

**Acceptance criteria:**
- DATA-AC-01: PostgreSQL persistence is available through a stable interface;
- DATA-AC-02: Redis queue/lock/cache interfaces are available;
- DATA-AC-03: object storage is available through a provider-neutral interface.

**Required verification:** database integration/recovery tests, Redis worker tests, storage tests.

**Modules:** `/platform`.

**Out of scope:** domain models.

**Definition of done:** all three persistence/infrastructure boundaries are available without coupling domain modules to vendors.

---

## WORK-003 — Identity, Organizations, and Tenant Isolation

**Objective:** Implement users, organizations, roles, permissions, API authentication, and server-side tenant isolation.

**Requirements:** AUTH-001..004, SEC-002

**Dependencies:** WORK-001, WORK-002

**Acceptance criteria:** authenticated project access is tenant-scoped; unauthorized cross-tenant reads/writes fail; privileged operations are permission-checked server-side.

**Required verification:** API authorization, integration, security tests.

**Modules:** `/auth`, `/organizations`.

**Out of scope:** provider credentials and capability authorization.

**Definition of done:** backend tenant/security boundary is enforced.

---

## WORK-004 — Projects and Public API Foundation

**Objective:** Implement projects plus the `/v1` API conventions, request IDs, idempotency headers, structured errors, pagination, and asynchronous-operation responses.

**Requirements:** PROJ-001, API-001..004

**Dependencies:** WORK-002, WORK-003

**Acceptance criteria:** project lifecycle works; `/v1` conventions are consistent; side-effecting requests support idempotency; asynchronous operations return durable operation/execution IDs.

**Required verification:** API contract and integration tests.

**Modules:** `/projects`, `/api`.

**Out of scope:** capability execution.

**Definition of done:** customer-facing API foundation is stable.

---

## WORK-005 — Capability Contracts

**Objective:** Implement provider-neutral capability definitions, schema/versioning, side-effect classification, idempotency semantics, and capability registry.

**Requirements:** CAP-001..004

**Dependencies:** WORK-004

**Acceptance criteria:** capabilities have stable identifiers, input/output schemas, versioning, side-effect class, and execution metadata.

**Required verification:** schema/unit/integration/contract tests.

**Modules:** `/capabilities`.

**Out of scope:** provider-specific adapters.

**Definition of done:** capabilities can be defined independently of providers.

---

## WORK-006 — Provider Adapter Framework

**Objective:** Implement the provider-neutral integration interface and adapter lifecycle.

**Requirements:** PROV-001..004

**Dependencies:** WORK-004, WORK-005

**Acceptance criteria:** adapters can declare supported capabilities; authentication and invocation are abstracted; provider-specific code is isolated.

**Required verification:** adapter contract tests and static architecture tests.

**Modules:** `/providers`, `/credentials`.

**Out of scope:** individual production provider integrations.

**Definition of done:** a new provider can be implemented without modifying capability semantics or execution domain internals.

---

## WORK-007 — Marketplace Catalog

**Objective:** Implement normalized provider, provider-capability, pricing, coverage, health, and certification metadata.

**Requirements:** CAT-001..005, MARKET-001

**Dependencies:** WORK-005, WORK-006

**Acceptance criteria:** catalog distinguishes declared/observed/verified/certified facts; provider capability relationships persist; pricing and coverage metadata are queryable.

**Required verification:** persistence, API, and catalog consistency tests.

**Modules:** `/catalog`, `/providers`.

**Out of scope:** provider ranking.

**Definition of done:** catalog can represent platform-integrated and provider-integrated offerings identically.

---

## WORK-008 — Policy Engine

**Objective:** Implement hard constraints, preferences, policy versions, and policy evaluation contracts.

**Requirements:** POLICY-001..004

**Dependencies:** WORK-003, WORK-005, WORK-007

**Acceptance criteria:** policies can constrain geography, capability, provider status, cost, latency, privacy/security attributes, and provider certification.

**Required verification:** deterministic policy tests, API/integration tests.

**Modules:** `/policies`.

**Out of scope:** provider performance ranking.

**Definition of done:** hard and soft constraints are represented separately.

---

## WORK-009 — Eligibility Engine

**Objective:** Implement deterministic candidate eligibility evaluation before ranking.

**Requirements:** ELIG-001..004

**Dependencies:** WORK-007, WORK-008

**Acceptance criteria:** eligibility evaluates capability compatibility, policy, credentials, geography, quota, provider state, and required capability support; every rejection has an explainable reason.

**Required verification:** exhaustive unit tests and integration tests.

**Modules:** `/eligibility`.

**Out of scope:** optimization ranking.

**Definition of done:** only eligible candidates reach routing/ranking.

---

## WORK-010 — Connections and Credential Boundary

**Objective:** Implement tenant/provider connection lifecycle and secure provider credential access.

**Requirements:** CONN-001..004, SEC-003

**Dependencies:** WORK-003, WORK-006, WORK-009

**Acceptance criteria:** tenants can connect providers; credentials are not exposed as ordinary API data; revocation works; adapter access is scoped.

**Required verification:** security, integration, credential lifecycle tests.

**Modules:** `/connections`, `/credentials`.

**Out of scope:** provider certification.

**Definition of done:** secure provider access boundary exists.

---

## WORK-011 — Goals and Outcome Contracts

**Objective:** Implement customer objectives and measurable outcome definitions.

**Requirements:** GOAL-001..003, OUT-001

**Dependencies:** WORK-004, WORK-005

**Acceptance criteria:** objectives can define maximize/minimize goals, hard targets, soft preferences, and measurable outcome metrics.

**Required verification:** domain/API tests.

**Modules:** `/goals`, `/outcomes`.

**Out of scope:** optimization.

**Definition of done:** execution can be evaluated against an explicit objective.

---

## WORK-012 — Plans and Immutable Strategies

**Objective:** Implement execution plans, immutable strategy versions, provenance, and active strategy references.

**Requirements:** PLAN-001..004, STRAT-001..003

**Dependencies:** WORK-009, WORK-011

**Acceptance criteria:** strategy versions are immutable; a strategy records execution graph and routing policy; active strategy selection is versioned and auditable.

**Required verification:** persistence, immutability, integration tests.

**Modules:** `/plans`.

**Out of scope:** promotion workflow.

**Definition of done:** live executions can reference a precise strategy version.

---

## WORK-013 — Routing Engine

**Objective:** Rank eligible candidates using observed performance and customer preferences without overriding hard eligibility.

**Requirements:** ROUTE-001..004

**Dependencies:** WORK-009, WORK-012

**Acceptance criteria:** routing never selects an ineligible provider; ranking exposes underlying measurements; routing decision rationale is persisted.

**Required verification:** deterministic routing tests, regression tests, integration tests.

**Modules:** `/routing`.

**Out of scope:** active strategy mutation.

**Definition of done:** execution can deterministically resolve a provider choice.

---

## WORK-014 — Live Execution Engine

**Objective:** Implement capability invocation, retries, timeout budgets, idempotency, circuit breakers, fallback, and execution lifecycle.

**Requirements:** EXEC-001..008

**Dependencies:** WORK-010, WORK-012, WORK-013

**Acceptance criteria:** execution produces durable state; failures are classified; retries are bounded; fallback is policy-driven; optimization downtime does not break execution.

**Required verification:** unit, integration, failure-injection, concurrency, idempotency tests.

**Modules:** `/executions`, `/routing`.

**Out of scope:** experiment promotion.

**Definition of done:** a real provider-backed capability invocation works safely end to end.

---

## WORK-015 — Observation Pipeline

**Objective:** Record provider and execution facts with correlation to strategy/provider/execution versions.

**Requirements:** OBS-002..005

**Dependencies:** WORK-014

**Acceptance criteria:** latency, status, provider, cost, retries, fallback, and execution metadata are persisted; observations preserve underlying measurements.

**Required verification:** ingestion, ordering/idempotency, integration tests.

**Modules:** `/observations`, `/evidence`.

**Out of scope:** derived optimization scores.

**Definition of done:** the system has trustworthy execution evidence.

---

## WORK-016 — Outcome Evaluation

**Objective:** Associate executions with technical and business outcome results.

**Requirements:** OUT-002..004

**Dependencies:** WORK-011, WORK-014, WORK-015

**Acceptance criteria:** technical success can be distinguished from business outcome success; outcomes are queryable by strategy/provider.

**Required verification:** unit and integration tests.

**Modules:** `/outcomes`.

**Out of scope:** strategy generation.

**Definition of done:** optimization can evaluate outcomes rather than only provider call success.

---

## WORK-017 — Evidence Repository and Decision Provenance

**Objective:** Implement evidence references, provenance records, and traceability between observations, decisions, and outcomes.

**Requirements:** EVID-001..004

**Dependencies:** WORK-015, WORK-016

**Acceptance criteria:** strategy decisions can link to evidence; provider claims can be distinguished from observed evidence; evidence remains queryable after strategy promotion.

**Required verification:** integration and auditability tests.

**Modules:** `/evidence`.

**Out of scope:** visual UI.

**Definition of done:** important decisions are evidence-linked.

---

## WORK-018 — Human Observability Console

**Objective:** Build the operator/developer UI for inspectable execution, decision explanations, provider comparison, fallbacks, evidence, and strategy state.

**Requirements:** HUMAN-001..006, UI-001..004

**Dependencies:** WORK-004, WORK-012, WORK-014, WORK-015, WORK-016, WORK-017

**Acceptance criteria:** a user can trace Goal → Execution → Strategy → Decision → Provider → Attempt → Observation → Outcome; facts and recommendations are visually distinguished; rejected candidates display reasons.

**Required verification:** API contract, component, end-to-end UI tests.

**Modules:** web application plus read APIs; no new domain authority.

**Out of scope:** client-owned workflow logic.

**Definition of done:** humans can understand what the platform is doing under the hood.

---

## WORK-019 — Experiment Engine

**Objective:** Implement replay, simulation, shadow, canary, evaluation, and experiment state transitions using capability side-effect rules.

**Requirements:** EXP-001..008

**Dependencies:** WORK-014, WORK-015, WORK-016, WORK-017

**Acceptance criteria:** replay can compare incumbent and candidate strategies; shadow mode never produces unsafe duplicated side effects; canaries are bounded and reversible; experiment records are durable.

**Required verification:** replay tests, side-effect safety tests, integration tests, failure-injection tests.

**Modules:** `/experiments`.

**Out of scope:** automated strategy discovery.

**Definition of done:** a candidate can be evaluated without directly mutating production strategy.

---

## WORK-020 — Optimization Engine

**Objective:** Analyze observations/outcomes and generate candidate strategy proposals without direct production mutation.

**Requirements:** OPT-001..006

**Dependencies:** WORK-017, WORK-019

**Acceptance criteria:** optimizer preserves measured metrics; candidates are immutable proposals; generated recommendations are evidence-linked; optimizer can operate asynchronously.

**Required verification:** deterministic fixture evaluations, proposal validation, integration tests.

**Modules:** `/optimization`, `/llm` where applicable.

**Out of scope:** promotion authority.

**Definition of done:** the platform can discover candidate improvements safely.

---

## WORK-021 — Strategy Promotion and Rollback

**Objective:** Implement explicit validation gates, canary progression, promotion, rollback, and audit for active strategy changes.

**Requirements:** PROMO-001..006

**Dependencies:** WORK-019, WORK-020

**Acceptance criteria:** optimizer cannot directly activate a strategy; promotions require evidence and policy checks; canary progression is bounded; rollback restores a prior immutable version.

**Required verification:** state-machine, integration, failure/rollback, concurrency tests.

**Modules:** `/experiments`, `/plans`, `/audit`.

**Out of scope:** provider adapter implementation.

**Definition of done:** the complete safe optimization lifecycle is executable.

---

## WORK-022 — Audit and Material Event Trail

**Objective:** Persist policy, strategy, promotion, rollback, provider-certification, connection, and operator-action audit events.

**Requirements:** AUDIT-001..004

**Dependencies:** WORK-003, WORK-017, WORK-021

**Acceptance criteria:** material actions are append-oriented, attributable, timestamped, and evidence-linked.

**Required verification:** integration/security tests.

**Modules:** `/audit`.

**Out of scope:** notification UI.

**Definition of done:** material control-plane actions are traceable.

---

## WORK-023 — Domain Events and Customer Webhooks

**Objective:** Implement signed outbound webhooks and internal/customer-facing events for execution and experiment lifecycle.

**Requirements:** EVENT-001..004, WEBHOOK-001..003

**Dependencies:** WORK-014, WORK-019, WORK-022

**Acceptance criteria:** duplicate-safe inbound events and signed outbound events work; delivery retries are bounded and auditable.

**Required verification:** webhook contract, signature, duplicate delivery, retry tests.

**Modules:** `/webhooks`, `/events`.

**Out of scope:** provider-specific event parsing outside adapters.

**Definition of done:** asynchronous integrations are first-class.

---

## WORK-024 — Developer SDK and DX

**Objective:** Provide typed SDKs, examples, cURL snippets, idempotency helpers, webhook verification helpers, and clean error types around the public API.

**Requirements:** DX-001..005

**Dependencies:** WORK-004, WORK-014, WORK-023

**Acceptance criteria:** a developer can perform the first capability invocation with minimal integration; SDK contracts mirror `/v1`; examples are executable.

**Required verification:** SDK contract tests, example execution tests.

**Modules:** SDK package and API contract tooling.

**Out of scope:** provider dashboard UX.

**Definition of done:** API adoption feels Stripe-like in simplicity and consistency.

---

## WORK-025 — Provider Self-Service Marketplace

**Objective:** Implement provider onboarding, capability registration, pricing/coverage submission, integration status, and certification workflow.

**Requirements:** MARKET-002..006

**Dependencies:** WORK-006, WORK-007, WORK-022, WORK-023

**Acceptance criteria:** providers can self-register; submitted claims are marked as declared until verified; certification state is visible; the same catalog model serves provider-owned and platform-integrated providers.

**Required verification:** API, onboarding, authorization, certification integration tests.

**Modules:** `/providers`, `/catalog`, `/connections`.

**Out of scope:** marketplace billing/settlement.

**Definition of done:** the supply side can onboard itself without changing the control-plane architecture.

---

## WORK-026 — Platform-Operated Provider Integration Pipeline

**Objective:** Build internal tooling and adapter lifecycle for integrating providers ourselves from public/observed contracts.

**Requirements:** FIRSTPARTY-001..005, CERT-001..005

**Dependencies:** WORK-006, WORK-007, WORK-025

**Acceptance criteria:** an operator can create an adapter, map provider endpoints to capabilities, run contract tests, attach evidence, certify the integration, and publish it into the catalog without provider-side code.

**Required verification:** adapter fixture suite, contract tests, certification integration tests, static architecture checks.

**Modules:** `/providers`, `/catalog`, `/evidence`.

**Out of scope:** arbitrary scraping or unsafe browser automation.

**Definition of done:** provider integration does not depend on provider participation.

---

## WORK-027 — End-to-End Control Plane Lifecycle

**Objective:** Prove the entire platform from capability registration through real execution and safe optimization.

**Requirements:** all core v1 requirements.

**Dependencies:** WORK-021, WORK-022, WORK-023, WORK-024, WORK-025, WORK-026

**Acceptance criteria:**
1. create tenant/project;
2. register or connect provider;
3. expose capability;
4. define policy;
5. create strategy;
6. execute capability;
7. observe routing/attempts/fallback;
8. record outcome;
9. inspect human-visible execution trace;
10. replay historical work;
11. generate candidate strategy;
12. simulate/shadow/canary safely;
13. evaluate candidate versus incumbent;
14. promote or reject;
15. roll back successfully;
16. preserve audit/evidence trace.

**Required verification:** full integration and end-to-end suite.

**Modules:** all core modules and provider adapters.

**Out of scope:** new architecture version.

**Definition of done:** a complete real lifecycle executes without bypassing architectural authority boundaries.

---

# 2. Implementation Order

### Phase 1 — Foundation
1. WORK-001
2. WORK-002
3. WORK-003
4. WORK-004

### Phase 2 — Semantic Marketplace Core
5. WORK-005
6. WORK-006
7. WORK-007
8. WORK-008
9. WORK-009
10. WORK-010

### Phase 3 — Goal, Strategy, and Execution
11. WORK-011
12. WORK-012
13. WORK-013
14. WORK-014

### Phase 4 — Evidence and Human Operations
15. WORK-015
16. WORK-016
17. WORK-017
18. WORK-018

### Phase 5 — Safe Optimization
19. WORK-019
20. WORK-020
21. WORK-021

### Phase 6 — Product and Marketplace
22. WORK-022
23. WORK-023
24. WORK-024
25. WORK-025
26. WORK-026

### Phase 7 — Convergence
27. WORK-027

---

# 3. Work Item Rules for Implementers

Every implementation agent must:

1. read `spec/architecture.md` and `spec/architecture-lock.md` before coding;
2. inspect the current repository implementation rather than trusting summaries;
3. read the relevant dependencies and public contracts;
4. work only on the assigned work item;
5. never modify frozen architecture documents during ordinary implementation;
6. never cross module boundaries through internal files;
7. write tests before implementation where practical;
8. verify against objective acceptance criteria;
9. report evidence, not only completion claims;
10. leave architectural changes for an Architecture Change Request.

A work item is not complete because an implementation agent says it is complete.
