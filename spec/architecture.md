# Intelligent Control Plane Architecture

**Version:** 1.0  
**Status:** FROZEN  
**Purpose:** Define the architecture of an API-first control plane that composes existing digital capabilities, executes them safely, observes them transparently, and continuously discovers and validates better execution strategies without directly mutating live production strategies.

---

# 1. Product Definition

The platform is an **Intelligent Digital Control Plane** that sits above existing services, products, APIs, infrastructure, and operational systems.

Its job is not to replace those systems. Its job is to provide a stable semantic layer above them:

```text
Business / Application Intent
          ↓
Capability
          ↓
Eligible Providers
          ↓
Strategy
          ↓
Execution
          ↓
Observation
          ↓
Outcome
          ↓
Safe Optimization
```

The platform is both:

1. a **developer-facing orchestration API**, and
2. a **two-sided marketplace** for capabilities and their providers.

The architecture must support both platform-operated provider integrations and provider self-service integrations.

---

# 2. Architectural Principles

## 2.1 Intent Over Provider

Customers request capabilities and outcomes rather than binding their application directly to one provider.

Example:

```text
payment.accept
```

rather than:

```text
stripe.payment.create
```

Provider choice is an implementation concern unless explicitly constrained by policy or customer preference.

## 2.2 Capability Is the Stable Semantic Primitive

A Capability defines a stable operation contract independent of its implementations.

Examples include:

```text
payment.accept
payment.refund
identity.verify
message.send
ai.generate
ai.embed
compute.run
storage.put
search.query
document.extract
```

Providers implement capabilities.

## 2.3 PostgreSQL Is the Authoritative Control-Plane System of Record

Persistent control-plane state is authoritative in PostgreSQL.

Redis, queues, caches, and transient coordination systems are not authoritative.

Provider systems remain authoritative for provider-owned resource state.

## 2.4 Evidence Over Claims

Provider output, optimizer claims, model-generated reasoning, and execution narratives are not authoritative proof.

Material conclusions must be backed by persisted observations, provider evidence, experiment results, or other traceable evidence whenever practical.

## 2.5 Production Stability Is More Important Than Optimization

The live execution path is conservative and deterministic.

The optimizer cannot directly mutate an active production strategy.

Optimization occurs through controlled candidate strategy lifecycles:

```text
CANDIDATE
→ SIMULATED
→ SHADOWED
→ CANARY
→ VALIDATED
→ PROMOTED
```

Candidates may instead become `REJECTED` or `ROLLED_BACK`.

## 2.6 Strategy Immutability

A Strategy is immutable once published.

Changing behavior produces a new Strategy Version.

A live execution always references the exact strategy version used.

This permits deterministic replay, rollback, comparison, and audit.

## 2.7 Optimization Has No Direct Production Mutation Authority

The Optimization and Experimentation domains may propose, simulate, shadow, evaluate, and recommend strategies.

They may not directly modify the active production strategy.

Promotion is a separate controlled domain action with explicit eligibility and evidence requirements.

## 2.8 Human Observability Is a First-Class Product Requirement

Every important execution and optimization decision must be explainable to a human operator.

For a material execution, the platform should expose:

- requested capability and objective;
- interpreted constraints and policies;
- eligible candidates;
- rejected candidates and reasons;
- selected strategy version;
- provider selection and routing rationale;
- execution attempts;
- retries and fallbacks;
- observed provider responses;
- latency and cost;
- business outcome;
- relevant evidence;
- candidate strategy comparisons;
- experiment status;
- promotion or rollback reasoning.

The system must never require users to infer critical behavior from raw logs alone.

## 2.9 API First

The public API is the primary product boundary.

The web console, SDKs, CLI, and other clients consume the same backend contracts.

The platform must remain useful without requiring adoption of the web console.

## 2.10 Provider Independence

Domain logic must not depend on provider-specific SDKs, authentication schemes, DOMs, response formats, pricing representations, or transport details.

Provider-specific behavior resides behind adapters.

## 2.11 First-Party Provider Integration

The platform operator must be able to integrate a provider directly from public APIs, documentation, contracts, or observed behavior.

A provider does not need to implement the platform SDK before its capabilities can appear in the catalog.

Provider onboarding paths are:

```text
Provider self-integration
Platform-operated integration
```

Both produce the same normalized provider/capability representation.

## 2.12 Eligibility Before Performance Ranking

Candidate selection occurs in this order:

```text
Capability compatibility
        ↓
Policy/security eligibility
        ↓
Availability/quota/credential eligibility
        ↓
Performance evidence
        ↓
Preference / optimization ranking
```

A candidate that violates a hard constraint cannot win because of a higher benchmark score.

## 2.13 Resilience Is Distinct From Optimization

Failover, timeout handling, retries, circuit breakers, idempotency, rate limiting, and emergency routing exist to keep the live system operating.

They are not dependent on the experimental optimization lifecycle.

## 2.14 Modular Monolith First

The initial implementation is a TypeScript modular monolith with asynchronous workers.

The module boundaries must be explicit enough that high-scale components can later be extracted into services without changing domain contracts.

## 2.15 Asynchronous Long-Running Work

Long-running, retryable, experiment, ingestion, synchronization, and optimization work must execute outside the synchronous HTTP request path.

## 2.16 Tenant Isolation Is Server-Side

Organization and project/resource boundaries are enforced by the backend.

Frontend state does not constitute authorization.

## 2.17 Secrets Are Not Ordinary Domain Data

API keys, provider credentials, tokens, and secret material are accessed through a secrets boundary.

Domain modules receive capability-scoped secret access rather than raw credential values whenever possible.

## 2.18 LLMs Are Reasoning Participants, Not Workflow Authorities

LLMs may interpret intent, propose plans, analyze evidence, identify optimization opportunities, summarize operations, or generate candidate strategies.

They do not own authoritative workflow state, eligibility, promotion, or production mutation.

---

# 3. System Context

```text
                             ┌───────────────────┐
                             │      DEVELOPERS    │
                             │     OPERATORS      │
                             └─────────┬─────────┘
                                       │
                               REST / SDK / CLI
                                       │
                                       ▼
┌───────────────────────────────────────────────────────────────────┐
│                       INTELLIGENT CONTROL PLANE                  │
│                                                                   │
│ Capabilities • Catalog • Policy • Planning • Execution           │
│ Observation • Outcome • Optimization • Experiments • Audit      │
└───────────┬──────────────────────────┬───────────────────────────┘
            │                          │
            ▼                          ▼
      Provider systems           External event sources
            │                          │
 ┌──────────┼──────────┐              │
 ▼          ▼          ▼              ▼
Payments   AI       Compute        Webhooks / telemetry
Messaging  Identity Storage       provider events
Data       Search  Logistics
```

The platform is not itself the provider of every capability.

It is the control plane and marketplace over implementations owned by other systems or by the platform's own integration layer.

---

# 4. Runtime Planes

The platform has four logically separated planes.

## 4.1 Control Plane

Owns:

- capabilities;
- provider catalog;
- policies;
- eligibility;
- strategies;
- active strategy selection;
- execution metadata;
- experiments;
- optimization decisions;
- audit records.

## 4.2 Live Execution Plane

Owns the safe mechanics of invoking capabilities:

- provider invocation;
- timeout;
- retry;
- idempotency;
- circuit breaker;
- fallback;
- rate limiting;
- concurrency control;
- compensation where applicable.

It must remain safe even if the optimization plane is unavailable.

## 4.3 Observation / Evidence Plane

Records facts about executions and providers:

- provider response metadata;
- latency;
- cost;
- status;
- retries;
- fallback;
- resource utilization;
- experiment observations;
- business outcomes;
- evidence references.

## 4.4 Optimization / Experimentation Plane

Generates and evaluates candidate strategies using:

- historical replay;
- simulation;
- shadow execution;
- canary traffic;
- A/B experimentation where safe;
- performance analysis;
- cost analysis;
- outcome analysis;
- optional LLM-assisted reasoning.

The optimization plane cannot bypass live execution safety controls.

---

# 5. Public Product Model

The customer-facing model consists of:

```text
Organization
  └── Project
        ├── Capability Requests
        ├── Connections
        ├── Policies
        ├── Strategies
        ├── Executions
        ├── Experiments
        └── Outcomes
```

Marketplace entities include:

```text
Provider
Capability
ProviderCapability
ProviderVersion
Certification
PricingModel
Coverage
ObservedPerformance
```

---

# 6. Capability Model

A Capability is a provider-neutral contract.

A capability contains:

- stable identifier;
- human-readable name;
- semantic description;
- input schema;
- output schema;
- error model;
- side-effect classification;
- idempotency semantics;
- required context;
- supported execution modes;
- policy-relevant metadata;
- version.

Capabilities must distinguish at least:

```text
PURE / READ_ONLY
IDEMPOTENT_WRITE
NON_IDEMPOTENT_WRITE
TRANSACTIONAL
BEST_EFFORT
```

This classification informs replay, simulation, shadowing, and experiment eligibility.

---

# 7. Provider Model

A Provider represents an implementation supplier.

A provider integration consists of:

```text
Provider
  └── Integration
       ├── Adapter
       ├── Authentication
       ├── Capability mappings
       ├── Normalization rules
       ├── Health checks
       ├── Pricing metadata
       ├── Coverage metadata
       ├── Contract tests
       └── Certification state
```

Provider integrations have lifecycle states:

```text
DISCOVERED
→ INTEGRATING
→ CONTRACT_TESTED
→ OBSERVED
→ CERTIFIED
→ ACTIVE
```

with:

```text
SUSPENDED
DEPRECATED
REVOKED
```

A provider can be added by the platform operator without provider-side code changes.

---

# 8. Provider Integration Paths

## 8.1 Platform-Operated Integration

The platform team may create an adapter from provider documentation/API behavior.

The integration process must produce:

- normalized interface;
- authentication boundary;
- schema mapping;
- error normalization;
- capability mapping;
- health behavior;
- contract tests;
- observed behavior record;
- certification evidence.

## 8.2 Provider Self-Integration

Providers may use the public integration API/SDK to register:

- company/provider metadata;
- capabilities;
- endpoints;
- credentials/authentication requirements;
- pricing;
- geographic coverage;
- quotas;
- SLAs;
- webhook/event metadata.

Provider-submitted claims remain claims until verified or certified.

---

# 9. Catalog

The catalog is the normalized marketplace inventory.

It answers:

> What can be done, by whom, where, under what constraints, at what price, and with what observed evidence?

The catalog must distinguish:

```text
DECLARED
OBSERVED
VERIFIED
CERTIFIED
```

for provider characteristics.

The system must not represent an unverified provider claim as independently verified fact.

---

# 10. Policy and Eligibility

A Policy defines hard or preference constraints.

Examples:

```text
region = EU
PII must not leave approved geography
provider must be certified
max cost < X
max latency < Y
required availability > Z
provider must support capability version N
```

Eligibility evaluates a concrete request against:

- capability compatibility;
- project policy;
- tenant policy;
- provider status;
- geographical requirements;
- credential availability;
- provider capability;
- quota;
- subscription;
- operational health;
- compliance restrictions.

Eligibility results must be explainable.

---

# 11. Strategy Model

A Strategy is an immutable execution policy.

It contains:

- strategy ID;
- version;
- capability graph / execution graph;
- routing rules;
- retry/fallback strategy references;
- constraints;
- optimization objective;
- evidence summary;
- creation timestamp;
- provenance.

Example:

```text
payment.accept
 ├── fraud.check → Provider F
 ├── authorize → Provider B
 ├── capture → Provider B
 └── notification → Provider N
```

A new proposal always creates a new version.

---

# 12. Execution Model

Every public capability invocation produces an Execution.

The API should support both immediate acknowledgment and asynchronous completion.

Example:

```http
POST /v1/executions
```

with a capability-oriented request.

The platform returns an execution ID.

```http
GET /v1/executions/{execution_id}
```

The platform additionally exposes event delivery via webhooks and event subscriptions.

An execution records:

- request;
- interpreted goal;
- applicable policies;
- eligibility snapshot;
- strategy version;
- attempts;
- provider calls;
- retries;
- fallback events;
- outputs;
- outcome;
- evidence;
- final status.

---

# 13. Execution Safety

The live execution plane must implement:

- bounded retries;
- deterministic retry policy;
- idempotency keys;
- timeout budgets;
- provider circuit breakers;
- fallback rules;
- rate limiting;
- concurrency limits;
- duplicate-delivery tolerance;
- cancellation where supported;
- compensation where the capability contract permits it.

Provider failures must not automatically invoke experimental optimization.

The current production strategy remains available while optimization services are unavailable.

---

# 14. Observation Model

An Observation is a factual record about something that happened or was measured.

Examples:

```text
provider = A
latency_ms = 418
status = success
cost = 0.013
region = GH
attempt = 1
```

Observations must be timestamped, correlated to an execution, and associated with relevant strategy/provider versions.

Raw observations should be retained independently from derived scores.

---

# 15. Outcome Model

An Outcome describes whether an execution achieved its intended business or technical result.

Examples:

```text
payment_completed
message_delivered
model_response_accepted
job_completed
cost_target_met
latency_target_met
```

An execution can succeed technically while failing the intended outcome.

Optimization must therefore use outcome evidence where available.

---

# 16. Human Observability

The platform UI must make the execution graph inspectable.

A user should be able to move from:

```text
Goal
→ Execution
→ Strategy
→ Decision
→ Provider
→ Attempt
→ Observation
→ Outcome
```

and back again.

For routing decisions the UI should expose a decision explanation:

```text
Candidate A: eligible
Candidate B: eligible
Candidate C: rejected — unsupported region

Selected B because:
- expected success: 99.1%
- expected latency: 420 ms
- expected cost: $0.011
- policy compliance: yes
```

The UI must distinguish:

```text
FACT
INFERENCE
MODEL RECOMMENDATION
POLICY DECISION
OPERATOR ACTION
```

This prevents AI-generated explanations from being confused with factual evidence.

---

# 17. Optimization Lifecycle

Optimization is an evidence-producing process.

```text
OBSERVE
  ↓
ANALYZE
  ↓
GENERATE CANDIDATE
  ↓
SIMULATE
  ↓
SHADOW
  ↓
CANARY
  ↓
EVALUATE
  ↓
PROMOTE or REJECT
```

Not every capability is eligible for every stage.

For capabilities with external side effects, shadowing must not duplicate unsafe side effects.

The experiment layer must use capability side-effect classifications to determine safe experiment modes.

---

# 18. Replay and Simulation

Replay uses historical execution inputs and relevant contextual state to evaluate a candidate strategy.

A replay record must identify:

- original strategy;
- candidate strategy;
- input digest;
- relevant provider/model versions;
- policy version;
- verification conditions;
- observed outcome;
- candidate result.

Where true simulation is impossible, the experiment must be explicitly marked as an estimate rather than a production-equivalent result.

---

# 19. Shadowing

Shadow execution evaluates a candidate without allowing candidate side effects to affect production.

For read-only and pure capabilities this may be a real provider execution.

For side-effecting capabilities, shadowing must use one of:

- provider sandbox;
- dry-run API;
- simulation;
- recorded-response replay;
- platform-level side-effect suppression where explicitly supported.

The platform must never assume that a provider has a safe dry-run mode without evidence.

---

# 20. Canary and Promotion

Promotion must be gradual when practical.

A canary may use:

```text
percentage
customer cohort
region
capability subset
risk class
```

Promotion gates must be defined by objective thresholds and policy.

The platform records:

- baseline;
- candidate;
- sample size;
- confidence/decision method where applicable;
- observed metrics;
- outcome metrics;
- operator actions;
- final verdict.

Rollback restores the prior immutable strategy version.

---

# 21. Optimization Objectives

An optimization objective may contain multiple dimensions, for example:

```text
maximize successful outcome
subject to:
  cost <= target
  latency <= target
  reliability >= target
  region = approved
```

Hard constraints remain eligibility filters.

Soft preferences are ranking signals.

The optimizer must preserve the underlying observed measurements; derived scores must not hide them.

---

# 22. LLM Integration

The `/llm` boundary may support:

- intent interpretation;
- plan generation;
- optimization analysis;
- experiment explanation;
- human-readable operational summaries.

LLM provider selection remains provider-independent.

LLM output must be structurally validated before entering deterministic systems.

An LLM cannot:

- directly invoke an arbitrary provider SDK from domain code;
- directly promote a strategy;
- directly disable safety rules;
- directly mutate canonical production state.

---

# 23. API Architecture

The public API is REST-first and versioned:

```text
/v1
```

Primary resource families:

```text
/capabilities
/providers
/catalog
/policies
/strategies
/executions
/experiments
/observations
/outcomes
/projects
/connections
/webhooks
```

The API must provide:

- consistent resource IDs;
- idempotency support for side-effecting operations;
- request correlation IDs;
- pagination;
- structured errors;
- webhook signatures;
- stable schema versioning;
- explicit asynchronous operation states.

SDKs and CLI are generated or implemented against the same public contracts.

---

# 24. Developer Experience

Developer UX is a first-class architectural constraint.

The product should feel:

```text
Stripe-like
    +
Apple-like polish
```

The API should be composable, predictable, typed, and easy to adopt incrementally.

A developer should be able to begin with one capability and one provider integration without adopting the entire platform.

The console should emphasize:

- fast comprehension;
- clean hierarchy;
- minimal visual noise;
- excellent defaults;
- progressive disclosure;
- responsive execution timelines;
- high-quality empty/error/loading states;
- copyable code and cURL examples;
- immediate visibility into why a decision occurred.

The web application must not own authoritative workflow or security logic.

---

# 25. Webhooks and Events

External events enter through dedicated webhook boundaries.

The canonical ingestion pattern is:

```text
Provider
  ↓
Webhook endpoint
  ↓
Signature validation
  ↓
Event persistence
  ↓
Queue
  ↓
Domain handler
```

Webhook delivery is assumed to be duplicated or delayed.

Handlers must be idempotent.

The platform also emits customer-facing events for material execution and experiment lifecycle changes.

---

# 26. Storage and Infrastructure

Initial runtime topology:

```text
API process
   │
   ├── PostgreSQL
   ├── Redis
   └── Object Storage
         │
         ▼
      Workers
```

PostgreSQL stores authoritative control-plane data.

Redis provides asynchronous job queues, locks, and transient cache.

Object storage stores large artifacts, provider evidence payloads, experiment artifacts, and execution snapshots where appropriate.

---

# 27. Background Workers

Representative job types include:

```text
provider.webhook
provider.sync
provider.health-check
catalog.refresh
execution.run
execution.retry
experiment.replay
experiment.shadow
experiment.evaluate
optimization.analyze
optimization.propose
strategy.canary
strategy.promote
observation.aggregate
notification.send
```

Workers receive an execution/correlation identifier that is preserved across asynchronous boundaries.

---

# 28. Observability of the Platform

Every platform execution must have traceable identifiers.

Structured logs, metrics, and traces must support:

```text
request_id
execution_id
organization_id
project_id
strategy_id
strategy_version
provider_id
experiment_id
```

Observability itself remains provider-neutral behind interfaces.

---

# 29. Audit

Material control-plane operations produce append-oriented audit events.

At minimum:

- policy changes;
- provider certification state changes;
- strategy creation;
- strategy promotion;
- strategy rollback;
- connection creation/revocation;
- experiment configuration;
- operator overrides;
- security-sensitive actions.

Audit records must identify actor, action, target, timestamp, reason where required, and relevant evidence/reference IDs.

---

# 30. Security Boundary

The platform must separate:

```text
identity
authorization
secret access
provider credentials
execution authorization
```

Provider secrets must never be exposed to client applications when the server can perform the operation safely.

Adapters must receive only the credentials/scopes required for their provider operation.

---

# 31. Failure Model

The system must distinguish:

```text
PROVIDER_FAILURE
NETWORK_FAILURE
RATE_LIMITED
TIMEOUT
POLICY_BLOCKED
INELIGIBLE
CREDENTIAL_FAILURE
EXECUTION_FAILURE
OUTCOME_FAILURE
PLATFORM_FAILURE
EXPERIMENT_FAILURE
```

A provider failure must not be represented as a policy failure.

An outcome failure must not automatically mean that the provider call failed.

---

# 32. Provider Certification

Certification is evidence-backed.

Certification may assess:

- contract compatibility;
- authentication;
- input/output schema;
- error normalization;
- idempotency behavior;
- webhook behavior;
- latency measurement;
- pricing evidence;
- coverage evidence;
- security requirements;
- operational reliability.

A provider can remain visible as `OBSERVED` without being `CERTIFIED`.

---

# 33. Marketplace Fairness

The marketplace must not secretly favor one provider because it is operated by the platform.

Platform-owned integrations and provider-owned integrations use the same capability and certification abstractions.

Platform ownership can affect operational support and certification confidence, but must not silently falsify observed performance.

Performance data must preserve underlying measurements.

---

# 34. Tenant Model

The platform is multi-tenant.

Hierarchy:

```text
Organization
  └── Project
        ├── API Keys / Connections
        ├── Policies
        ├── Strategies
        ├── Executions
        └── Experiments
```

All customer-visible resources are tenant-scoped.

---

# 35. Module Boundaries

The frozen backend modules are:

```text
/platform
/auth
/organizations
/projects
/capabilities
/providers
/catalog
/policies
/eligibility
/goals
/plans
/executions
/routing
/optimization
/experiments
/observations
/outcomes
/evidence
/resources
/connections
/credentials
/webhooks
/events
/audit
/llm
/agents
```

Each module exposes one public interface entry point.

Other modules may consume only that public interface.

No module may import another module's internal implementation.

`/platform` may not import domain modules.

The API layer may not reach into module internals.

---

# 36. Module Ownership

| Module | Responsibility |
|---|---|
| `/platform` | runtime foundation, IDs, execution context, queues, database, storage, observability interfaces |
| `/auth` | authentication, authorization primitives, sessions, API authentication |
| `/organizations` | organization membership and tenant ownership |
| `/projects` | projects and customer configuration containers |
| `/capabilities` | provider-neutral capability contracts and versions |
| `/providers` | provider integrations and adapter contracts |
| `/catalog` | normalized marketplace inventory and provider capability facts |
| `/policies` | hard constraints and preferences |
| `/eligibility` | deterministic candidate eligibility evaluation |
| `/goals` | customer objectives and outcome definitions |
| `/plans` | immutable execution plans/strategies |
| `/executions` | live execution lifecycle and execution records |
| `/routing` | candidate routing and provider selection |
| `/optimization` | analysis, candidate strategy generation, optimization recommendations |
| `/experiments` | replay, simulation, shadow, canary, evaluation, promotion/rollback |
| `/observations` | factual execution/provider observations |
| `/outcomes` | business and technical outcome records |
| `/evidence` | evidence references and evidence lifecycle |
| `/resources` | external resource references and resource state snapshots |
| `/connections` | tenant/provider connection lifecycle |
| `/credentials` | secret access boundary and provider credential metadata |
| `/webhooks` | external webhook ingestion |
| `/events` | domain/customer event publication |
| `/audit` | append-oriented audit records |
| `/llm` | provider-neutral LLM access and reasoning services |
| `/agents` | provider-neutral agent/tool execution where needed |

---

# 37. Authority Model

The following authorities are immutable architectural rules:

```text
/eligibility     → candidate eligibility
/executions      → live execution state
/plans           → strategy identity/content
/experiments     → experiment lifecycle and promotion
/observations    → observations
/outcomes        → outcomes
/policies        → policy definitions
/providers       → provider adapter implementation boundary
/audit           → audit records
```

No LLM, provider, frontend, or adapter may directly mutate another module's authoritative records.

---

# 38. State Transitions

## Strategy Lifecycle

```text
DRAFT
 ↓
CANDIDATE
 ↓
VALIDATED
 ↓
ACTIVE
 ↓
SUPERSEDED
```

A candidate may become:

```text
REJECTED
```

An active strategy may become:

```text
ROLLED_BACK
```

only through the promotion/rollback control path.

## Experiment Lifecycle

```text
DRAFT
→ READY
→ RUNNING
→ EVALUATING
→ PROMOTED | REJECTED | ROLLED_BACK
```

## Execution Lifecycle

```text
CREATED
→ ELIGIBILITY_CHECKED
→ PLANNED
→ EXECUTING
→ COMPLETED
```

Alternative terminal/error paths include:

```text
BLOCKED
FAILED
CANCELLED
TIMED_OUT
```

A running execution may enter:

```text
DEGRADED
```

when it remains live but has used fallback/recovery behavior.

---

# 39. Determinism and Idempotency

Control-plane state transitions are deterministic and idempotent.

Provider invocation idempotency is capability-specific and must be declared by the capability contract.

Duplicate provider events must not produce duplicate logical state transitions.

---

# 40. Architecture Changes

The architecture is frozen once version 1.0 is accepted.

Architecture changes require:

1. Architecture Change Request.
2. Explicit impact analysis.
3. Approved new immutable architecture version.
4. Updated requirements/dependency graph/work items as required.

Implementation agents must not modify frozen architecture documents as part of ordinary work.

---

# 41. Implementation Workflow

The product implementation follows the WorkflowOS-inspired lifecycle:

```text
Architecture
  ↓
Architecture Lock
  ↓
Requirements
  ↓
Acceptance Criteria
  ↓
Dependency Graph
  ↓
Work Items
  ↓
Implementation Agent
  ↓
Pull Request
  ↓
Objective Verification
  ↓
Architect Review
  ↓
Correction if required
  ↓
Merge
  ↓
Evidence / Audit
```

The implementation agent is never the final authority on whether a work item is complete.

---

# 42. API and SDK Compatibility

A customer must be able to integrate incrementally.

Minimum adoption path:

```text
API key
  ↓
One connection
  ↓
One capability
  ↓
One execution
  ↓
Observe
  ↓
Optionally enable routing
  ↓
Optionally enable optimization
```

No feature may require adopting the entire marketplace.

---

# 43. Non-Goals for Version 1

Version 1 does not attempt to:

- automatically integrate every provider in the world;
- directly modify customer application source code;
- replace provider control planes;
- guarantee optimality in a mathematical sense;
- use LLMs as authoritative controllers;
- run unsafe shadow side effects;
- hide provider performance differences behind a single opaque score;
- require providers to implement platform-specific code before platform-operated integration is possible.

---

# 44. Initial Vertical Strategy

The architecture is horizontal, but initial implementation should use a narrow set of capabilities that exercise the hard parts of the system.

The preferred first capability families are:

1. AI inference/model routing.
2. Payment routing.
3. Message delivery.
4. Generic HTTP/service invocation.

These provide different combinations of latency, cost, provider health, side effects, fallbacks, and optimization difficulty.

---

# 45. Definition of Architectural Success

Architecture 1.0 succeeds when a customer can:

1. connect an existing provider;
2. invoke a capability through the API;
3. see exactly what happened;
4. inspect why a provider was selected;
5. observe failure/fallback behavior;
6. replay historical executions;
7. create a candidate strategy;
8. shadow or simulate it safely;
9. canary it under policy;
10. compare measured outcomes;
11. promote or reject it;
12. roll back to the prior strategy;
13. do all of this without the live production execution plane depending on the optimizer.

That is the core product contract.
