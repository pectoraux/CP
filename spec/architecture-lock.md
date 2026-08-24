# Architecture Lock — Control Plane v1.0

**Status: FROZEN**

This document is authoritative for the frozen architectural rules of Control Plane (CP). Implementers must not modify this file or `spec/architecture.md` during ordinary work-item execution. Architectural changes require an Architecture Change Request, review, and a new immutable architecture version.

## Core authority invariants

1. PostgreSQL is the authoritative CP application-state store.
2. External provider systems remain authoritative for provider-native state.
3. Redis is non-authoritative transient coordination/queue infrastructure.
4. Object storage is used for large artifacts and is addressed through an abstraction.
5. `/api` and `/workers` cannot own domain state transitions.
6. The active production strategy is immutable by identity; changing it means promoting a new immutable strategy version.
7. The optimizer cannot directly mutate the active production strategy.
8. Production execution must remain safe when optimization is unavailable.
9. Eligibility is evaluated before performance ranking/optimization.
10. Provider-specific SDK/API behavior remains behind `/providers`.
11. Capability semantics remain independent of provider implementation.
12. LLMs and agents cannot directly mutate authoritative application or execution state.
13. Frontend code cannot own authoritative workflow/execution state or authorization.
14. Tenant isolation is enforced server-side.
15. Secrets are not ordinary application data and never appear in logs, prompts, observations, audit records, or client state.

## Execution/optimization separation

CP has two architectural planes:

```text
LIVE EXECUTION PLANE
active strategy → deterministic execution → observations/outcomes

OPTIMIZATION PLANE
observations/outcomes → candidate → simulation → shadow → canary → evaluation → promotion
```

Optimization may observe production and evaluate alternatives but may not directly rewrite live execution logic.

## Strategy invariants

- Strategy versions are immutable.
- Every execution references exactly one strategy version.
- The active strategy is a pointer/reference to an immutable version.
- Promotions are auditable and reversible.
- Rollback restores a previously valid strategy reference; it does not rewrite historical strategy records.
- Candidate strategies are not production strategies until they pass the controlled promotion process.

## Experiment invariants

The experiment lifecycle is:

```text
CANDIDATE → SIMULATED → SHADOWED → CANARY → VALIDATED → PROMOTED
```

Alternative terminal states are `REJECTED`, `ROLLED_BACK`, and `EXPIRED`.

An experiment must preserve the incumbent strategy as the control where comparison is required. Historical replay and simulation must capture the same relevant request/context baseline when claiming comparative validity. Shadow execution has zero production side effects. Canary rollout must support bounded exposure and deterministic abort/rollback criteria.

## Human observability invariants

Every material execution decision must have enough durable evidence to answer:

- What objective was requested?
- What capability was requested?
- Which providers/candidates were considered?
- Which candidates were ineligible, and why?
- Which strategy version was selected?
- Why was the route selected?
- What happened during every relevant execution step?
- Which retries/fallbacks/circuit breakers fired?
- What outcome was observed?
- What alternative strategy was being evaluated, if any?
- What evidence supported promotion/rejection/rollback?
- Who or what initiated the material action?

The console must expose this information without requiring database access or model/provider-specific knowledge.

## Marketplace invariants

Two provider entry paths are first-class:

```text
SELF-SERVICE PROVIDER ONBOARDING
PLATFORM-OPERATED PROVIDER INTEGRATION
```

CP is permitted to build and operate an adapter for a provider using documented APIs/contracts without requiring the provider to implement CP-specific integration first.

Provider onboarding must move through explicit contract validation and certification states before normal routing eligibility.

## API invariants

- `/v1` is the stable public API boundary.
- API routes use domain/application interfaces; they never reach into module internals.
- Long-running operations are asynchronous and return operation/execution identifiers.
- Request idempotency is supported wherever a request can cause side effects.
- Every response participating in an asynchronous lifecycle is traceable by execution/request identifiers.
- Webhook delivery is signed, replay-resistant where practical, and idempotent.

## Module boundaries

Modules are independent bounded contexts with one public entry surface (`index.ts` or equivalent module interface). Cross-module implementation imports are forbidden. Cross-module interaction uses public contracts.

Canonical modules:

```text
/platform
/auth
/organizations
/projects
/goals
/capabilities
/providers
/catalog
/connections
/credentials
/resources
/policies
/eligibility
/plans
/strategies
/routing
/executions
/observations
/outcomes
/optimization
/experiments
/events
/webhooks
/evidence
/audit
/llm
/agents
```

## No hidden orchestration authority

No provider adapter, LLM service, agent service, frontend component, webhook handler, or worker may silently change execution or strategy state outside the authoritative application service for that module.

## Benchmark integrity

Comparative trials must preserve relevant workload/context and must report underlying measurements in addition to derived scores. Eligibility, subscription, quota, privacy, policy, and capability are hard filters, not performance penalties.

## Architecture evolution

A frozen architecture version remains immutable. A proposed architecture change creates:

1. Architecture Change Request
2. review decision
3. new architecture version
4. updated requirements/acceptance criteria/dependency graph/work items as needed

Historical work items retain their original architecture-version association.

## Implementation workflow lock

Implementation proceeds as:

```text
ARCHITECTURE
→ ARCHITECTURE LOCK
→ REQUIREMENTS
→ ACCEPTANCE CRITERIA
→ DEPENDENCY GRAPH
→ WORK ITEMS
→ IMPLEMENTATION
→ OBJECTIVE VERIFICATION
→ INDEPENDENT ARCHITECT REVIEW
→ CORRECTION CYCLE
→ MERGE GATE
→ EVIDENCE
```

Implementation agents must treat the frozen architecture and lock as authoritative and may not redesign them within an ordinary work item.
