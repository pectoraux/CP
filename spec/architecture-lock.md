# Architecture Lock

**Version:** 1.0  
**Status:** FROZEN

This document contains the non-negotiable architectural invariants for Control Plane 1.0.

## 1. Authority

- PostgreSQL is authoritative for application/control-plane state.
- Provider systems are authoritative for provider-owned external resource state.
- Redis, queues, caches, and object-storage indexes are not authoritative workflow/control state.
- `/executions` owns canonical live execution state.
- `/experiments` owns experiment lifecycle and strategy promotion/rollback.
- `/plans` owns strategy definitions and versions.
- `/eligibility` owns candidate eligibility decisions.
- `/policies` owns policy definitions.
- `/observations` owns factual observations.
- `/outcomes` owns outcome records.
- `/audit` owns the audit trail.

## 2. Production Safety

- The optimization subsystem MUST NOT directly mutate the active production strategy.
- Active strategies are immutable versions.
- Strategy changes create new versions.
- Promotion is an explicit control-plane operation.
- Rollback restores a prior immutable strategy version.
- The live execution plane remains functional if optimization is unavailable.
- Resilience behavior is independent of optimization behavior.

## 3. Optimization Lifecycle

Candidate strategies use the lifecycle:

```text
CANDIDATE → SIMULATED → SHADOWED → CANARY → VALIDATED → PROMOTED
```

with rejection and rollback states.

- Not every capability must support every experiment mode.
- Side-effecting capabilities must not receive unsafe duplicate shadow traffic.
- Provider sandbox/dry-run claims must be verified before being treated as safe experimentation surfaces.

## 4. Eligibility

- Eligibility is evaluated before performance ranking.
- Hard constraints cannot be overridden by benchmark scores.
- Quota, subscription, credential, privacy, security, capability, geography, and policy restrictions are eligibility filters.
- Provider performance is a ranking signal only among eligible candidates.

## 5. Evidence

- Provider claims are not automatically verified facts.
- LLM-generated reasoning is not verification.
- Agent output is not verification.
- Optimization scores cannot replace underlying measurements.
- Important decisions must retain evidence references.

## 6. Human Observability

- Material execution decisions must be inspectable by a human.
- The UI must distinguish facts, inferences, model recommendations, policy decisions, and operator actions.
- A user must be able to trace Goal → Execution → Strategy → Decision → Provider → Attempt → Observation → Outcome.
- Rejected provider candidates must have explainable reasons when observable.
- Strategy promotion and rollback must be auditable.

## 7. Provider Independence

- Provider-specific SDKs are allowed only inside provider adapters.
- Domain modules must not import provider SDKs directly.
- Provider-operated integrations and platform-operated integrations use the same normalized contracts.
- Providers do not need to self-integrate before the platform may operate an integration.

## 8. Module Boundaries

- Every backend module exposes one public interface entry point.
- Cross-module imports may target only another module's public interface.
- Cross-module imports into `internal/` are forbidden.
- `/platform` must not import domain modules.
- API handlers must not import module internals.

## 9. API First

- REST `/v1` is the primary external control-plane interface.
- SDKs and console actions use the same backend authority.
- Side-effecting API requests must support idempotency keys.
- Long-running operations return asynchronous execution identifiers.
- Webhooks/events are supported for asynchronous completion.

## 10. Security

- Tenant boundaries are enforced server-side.
- Provider credentials are not ordinary application data.
- Provider secrets must not be exposed to client applications when the backend can safely perform the action.
- Connections and credentials are scoped to tenants/projects and capabilities where applicable.

## 11. State and Idempotency

- Control-plane state transitions are deterministic and idempotent.
- Duplicate provider webhooks must produce one logical state effect.
- The execution plane must preserve execution/correlation IDs across asynchronous work.

## 12. Runtime Topology

- Version 1 is a modular monolith plus workers.
- Redis is used for asynchronous coordination and transient mechanisms.
- PostgreSQL is the authoritative state store.
- Object storage holds large artifacts/evidence where appropriate.
- Microservices are not required for Version 1.

## 13. LLM Authority

- LLMs may propose plans and candidate strategies.
- LLMs may not directly promote strategies.
- LLMs may not disable policy or safety constraints.
- LLMs may not directly mutate authoritative execution state.
- LLM outputs entering deterministic systems must be schema-validated.

## 14. Architecture Evolution

- Frozen architecture documents are immutable during ordinary implementation.
- Architecture changes require an Architecture Change Request and a new architecture version.
- Work items reference the architecture version they implement.

## 15. Implementation Integrity

- Every work item has explicit acceptance criteria.
- Every acceptance criterion requires traceable verification evidence.
- Implementation-agent claims are insufficient for completion.
- Verification and architect review are separate concerns.
- Z.ai and other implementation agents must read the actual codebase before changing code.
- Implementation agents must work only within the assigned work item scope.
