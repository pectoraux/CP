# Control Plane Architecture

## Status

FROZEN

## Purpose

Control Plane (CP) is an API-first orchestration and optimization layer that operates above existing digital services, infrastructure, APIs, and service providers. It does not replace the systems it orchestrates. It composes their capabilities, executes against them through provider adapters, observes outcomes, and safely evaluates improved strategies without directly mutating an active production strategy.

## Core lifecycle

Goal → Capability Graph → Policy → Eligibility → Plan → Strategy → Live Execution → Observation → Outcome → Optimization → Experiment → Promotion

## Safety principle

The live execution plane is deliberately separated from the optimization plane. Optimization may propose, replay, simulate, shadow, canary, evaluate, and recommend strategy changes, but it cannot directly mutate the active production strategy.

## Human observability principle

Every material execution decision must be inspectable: what was requested, which capabilities/providers were considered, which policies excluded candidates, which strategy version executed, why a route was chosen, what happened at each execution step, what fallbacks were used, what evidence was collected, what outcome occurred, what the optimizer proposed, and why a candidate was promoted, rejected, or rolled back.

## Marketplace principle

CP is a two-sided marketplace. Demand-side customers consume capabilities; supply-side providers expose capabilities. Provider integration supports both self-service provider integrations and platform-operated adapters. CP may integrate and certify providers directly from public or private provider APIs/documentation without waiting for the provider to implement a native CP integration.

## Developer experience principle

The REST API and SDK are the primary product boundary. The experience should be as straightforward and composable as Stripe's developer products, with product interaction quality, visual hierarchy, responsiveness, restraint, and polish at Apple-level quality.

## Architecture

Initial deployment is a modular monolith with asynchronous workers. The architecture preserves strict module boundaries so components may later be extracted without changing domain contracts.

Primary modules:

- `/platform` — runtime foundation, IDs, execution context, queues, persistence, storage, observability
- `/auth` — authentication and authorization
- `/organizations` — tenant ownership and membership
- `/projects` — customer projects and configuration
- `/goals` — objectives and desired outcomes
- `/capabilities` — canonical capability definitions and contracts
- `/providers` — provider adapters and provider-specific implementation details
- `/catalog` — provider offerings, capability mappings, pricing, constraints, availability, certifications, observed contracts
- `/connections` — customer/provider connections
- `/credentials` — secret-reference boundary; credentials are never ordinary domain data
- `/resources` — provider resources and normalized resource identity
- `/policies` — customer/system policies and hard constraints
- `/eligibility` — candidate eligibility evaluation
- `/plans` — execution plan graphs
- `/strategies` — immutable strategy versions and active strategy references
- `/routing` — provider/capability routing
- `/executions` — authoritative live execution state
- `/observations` — raw execution and provider observations
- `/outcomes` — business and technical outcome evaluation
- `/optimization` — candidate strategy generation and optimization evidence
- `/experiments` — replay, simulation, shadow, canary, evaluation, promotion, rejection, rollback
- `/events` — asynchronous domain/application event publication and consumption
- `/webhooks` — external inbound webhook boundary
- `/evidence` — evidence and provenance linkage
- `/audit` — append-oriented audit trail
- `/llm` — provider-neutral LLM reasoning services
- `/agents` — provider-neutral agent execution services
- `/api` — HTTP/API boundary only; no domain authority
- `/workers` — background execution host and job handlers

## Authority

PostgreSQL is the authoritative CP application state. External provider systems remain authoritative for their provider-native state. Redis is transient coordination and queue infrastructure, not authoritative business state. Object storage holds large artifacts. LLMs and agents are non-authoritative participants that produce proposals, classifications, analyses, and evidence inputs.

Workflow/execution transitions are controlled by deterministic application services. No provider, LLM, agent, frontend, or API route may directly mutate authoritative state outside its public module contract.

## API-first integration

The primary public interface is `/v1`. Core resources include goals, capabilities, providers, strategies, executions, experiments, observations, outcomes, connections, and events. Long-running operations return an execution or operation identifier and proceed asynchronously. Webhooks and signed event delivery expose state changes to customers.

The API supports capability-oriented requests rather than provider-specific APIs. Provider selection remains a CP concern unless a customer explicitly constrains it.

## Capability model

A capability represents a semantic operation independent of its provider. A provider implementation advertises capabilities through normalized contracts. Capability definitions include input/output schema, required context, side effects, idempotency requirements, execution modes, safety class, and observability requirements.

## Provider model

Providers may be onboarded through:

1. Provider self-integration using the public provider onboarding interface.
2. CP-operated integration using an internal adapter implementation.

Provider adapters own authentication, request/response translation, provider-specific error interpretation, rate-limit semantics, provider-specific identifiers, and provider API quirks. Provider-specific code must not leak into domain modules.

A provider moves through discovery, adapter implementation, contract validation, behavioral observation, certification, catalog publication, and continuous health monitoring.

## Eligibility vs optimization

Eligibility is a hard gate. Performance scoring and optimization operate only among eligible candidates. Hard constraints include authorization, capability support, geography, privacy, policy, quotas, credential availability, plan restrictions, provider availability, and other non-negotiable constraints.

Benchmark evidence must preserve native provider/model capability and observed differences. Benchmarks are never allowed to make providers appear equivalent by suppressing capabilities.

## Strategy model

A Strategy is immutable and versioned. It defines how an objective is satisfied, including capability composition, routing rules, retry/fallback rules, constraints, and optimization parameters. The active strategy is a pointer to an immutable version, not an editable object.

Candidate strategy lifecycle:

CANDIDATE → SIMULATED → SHADOWED → CANARY → VALIDATED → PROMOTED

Alternative terminal states:

REJECTED, ROLLED_BACK, EXPIRED

Promotion is an explicit, auditable action that creates a new active-strategy reference. The previous strategy remains available for rollback.

## Live execution plane

The live execution plane uses the active strategy and deterministic runtime protections including idempotency, timeouts, retries, circuit breakers, rate limits, fallback rules, compensation, concurrency limits, and safe failure handling. It does not receive arbitrary live mutations from the optimizer.

An execution is traceable through an execution ID and strategy version. Every significant step records an observation or evidence reference.

## Optimization plane

The optimizer consumes historical observations and outcomes and may generate candidate strategies. It can evaluate candidates through:

- Offline analysis
- Historical replay
- Simulation
- Shadow execution
- Canary rollout
- Controlled promotion

Optimization decisions require measurable evidence. A language model may propose reasoning or hypotheses, but deterministic policy, eligibility, and promotion controls remain authoritative.

## Human observability

The product must expose both high-level and low-level views:

- Goal/objective interpretation
- Candidate provider set
- Eligibility decisions with reasons
- Selected strategy and strategy version
- Step-by-step execution timeline
- Provider calls and latency/cost/result metadata where safe to expose
- Retry/fallback/circuit-breaker activity
- Observed vs expected outcome
- Shadow/canary comparison
- Optimization candidate details
- Promotion/rejection/rollback rationale
- Evidence and provenance links

The UI is a read/command client of backend-authoritative state. It must not invent workflow state.

## Developer experience

API design follows resource-oriented conventions, predictable authentication, idempotency keys, request IDs, pagination, typed errors, stable event schemas, SDK generation/source parity, and local test fixtures. Examples must be copy-pasteable and deterministic.

The console is optimized for developers: excellent onboarding, credential/connection setup, capability discovery, request explorer, execution timeline, strategy inspection, experiment controls, provider comparison, logs/evidence, and documentation discoverability.

## Reliability

The system is designed for safe degradation. Provider failures should trigger only policy-eligible fallback behavior. Optimizer failures must never stop live execution. Telemetry failures must not become silent causes of business mutation. Promotion requires evidence thresholds and rollback readiness.

## Security

Tenant boundaries are enforced server-side. Provider credentials are stored only through the secrets boundary and referenced by opaque identifiers. Secrets must not appear in logs, observations, model prompts, audit entries, or frontend state. Webhooks are signature-validated and idempotent. Customer data access is least-privilege.

## Auditability

All privileged operations, strategy promotions, rollbacks, policy changes, provider onboarding/certification actions, connection changes, and administrative operations produce append-oriented audit records with actor, tenant, action, target, request/execution context, timestamp, and evidence references.

## Implementation discipline

The repository follows a WorkflowOS-inspired development workflow: frozen architecture, architecture lock, requirements, acceptance criteria, dependency graph, small work items, objective verification, independent architect review, correction cycles, merge gating, and evidence documentation. Implementation agents must inspect the current repository and authoritative spec before changing code and may not redesign frozen architecture within an ordinary work item.
