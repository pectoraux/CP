# Control Plane Implementation Backlog — Dependency Graph

## 1. Architectural dependency graph

```text
PLAT-001
  ├→ DATA-001
  ├→ DATA-002
  ├→ DATA-003
  ├→ OBS-001
  ├→ SEC-001
  └→ API-001

DATA-001 → AUTH-001 → AUTH-002 → ORG-001 → PROJ-001

PROJ-001 → GOAL-001 → CAP-001
CAP-001 → PROVIDER-001 → CATALOG-001
CATALOG-001 → CONN-001 → ELIG-001

CAP-001 + CATALOG-001 + GOAL-001 → PLAN-001
PLAN-001 → STRAT-001 → EXEC-001

EXEC-001 → OBS-001 → OUTCOME-001

OBS-001 + OUTCOME-001 → OPT-001
OPT-001 → EXP-001
EXP-001 → PROMO-001

PROVIDER-001 → PROVIDER-002 → PROVIDER-003
PROVIDER-003 + ELIG-001 → ROUTE-001
ROUTE-001 + STRAT-001 → EXEC-001

EXEC-001 + OBS-001 + AUDIT-001 → HUMAN-OBS-001

API-001 + CAP-001 + EXEC-001 → SDK-001
SDK-001 + API-001 → DEVEX-001

SEC-001 + CONN-001 → SECRETS-001
WEBHOOK-001 + EVENTS-001 → EXEC-002

LLM-001 → OPT-001
AGENT-001 → OPT-001
```

## 2. Parallelizable streams after foundation

Once platform, persistence, tenancy, and public module-boundary foundations exist, the following streams can proceed concurrently:

- Capability and catalog semantics
- Provider adapter boundary and provider onboarding
- Authentication/organizations/project substrate
- API boundary and developer contracts
- Observability/evidence/audit foundation
- Goal/plan/strategy model
- Connection/credential boundary
- LLM and agent gateways

The main convergence point is the live execution plane, followed by the optimization/experiment plane.

## 3. Runtime convergence

```text
Goal
  ↓
Capability Graph
  ↓
Policy
  ↓
Eligibility
  ↓
Plan
  ↓
Strategy
  ↓
Live Execution
  ↓
Observation
  ↓
Outcome
  ↓
Optimization
  ↓
Experiment
  ↓
Promotion
  └──────────────→ new Strategy version
```

The incumbent strategy remains active until a candidate passes the controlled experiment/promotion boundary.

## 4. Provider onboarding convergence

```text
Provider discovery
    ↓
Provider adapter
    ↓
Normalization contract
    ↓
Contract tests
    ↓
Behavioral validation
    ↓
Observed provider contract
    ↓
Certification
    ↓
Catalog publication
    ↓
Eligibility
    ↓
Routing
```

Self-service and platform-operated providers converge at the normalization/certification boundary.

## 5. Optimization convergence

```text
Observations + Outcomes
          ↓
     Candidate Generator
          ↓
        Candidate
          ↓
       Simulation
          ↓
        Shadowing
          ↓
        Canary
          ↓
       Evaluation
       ↙        ↘
   Reject      Validate
                 ↓
             Promotion
                 ↓
           Active Strategy
```

## 6. Non-negotiable dependency invariants

- There is exactly one authoritative execution state machine.
- There is exactly one active strategy reference per governed project/context.
- Strategies are immutable versions.
- Optimization cannot bypass eligibility or policy.
- Provider adapters cannot import or mutate domain internals.
- API and UI layers cannot own domain state.
- Observation is not execution authority.
- LLM/agent proposals are not production authority.
- Experiment rollback must not require optimizer availability.
- Historical evidence must remain linked to the strategy/execution version that produced it.
- Tenant isolation is enforced server-side.

## 7. Work-item phase order

### Phase 1 — Platform foundation
1. WORK-001 — Modular monolith and runtime foundation
2. WORK-002 — PostgreSQL/Redis/object storage boundaries
3. WORK-003 — Observability, execution IDs, audit primitives
4. WORK-004 — Auth, organizations, tenant isolation
5. WORK-005 — Public API foundation

### Phase 2 — Capability and provider substrate
6. WORK-006 — Goal and objective model
7. WORK-007 — Capability registry and contracts
8. WORK-008 — Provider adapter gateway
9. WORK-009 — Catalog and provider capability mapping
10. WORK-010 — Connections and credential boundary
11. WORK-011 — Eligibility engine
12. WORK-012 — First platform-operated provider adapter

### Phase 3 — Plans, strategies, and live execution
13. WORK-013 — Plan graph model
14. WORK-014 — Immutable strategy model
15. WORK-015 — Routing engine
16. WORK-016 — Execution engine
17. WORK-017 — Reliability controls and safe fallback
18. WORK-018 — Execution evidence and outcomes

### Phase 4 — Developer experience and human observability
19. WORK-019 — Execution inspection API
20. WORK-020 — Developer SDK and local fixtures
21. WORK-021 — Human-under-the-hood console
22. WORK-022 — Provider onboarding console and tools

### Phase 5 — Optimization and experiments
23. WORK-023 — Optimization engine foundation
24. WORK-024 — Historical replay
25. WORK-025 — Simulation and shadow execution
26. WORK-026 — Canary experimentation
27. WORK-027 — Promotion, rollback, and optimization audit

### Phase 6 — Intelligence and marketplace expansion
28. WORK-028 — LLM planning/optimization gateway
29. WORK-029 — Agent gateway
30. WORK-030 — Provider marketplace publication and search
31. WORK-031 — Provider self-service integration
32. WORK-032 — Provider certification and health intelligence
33. WORK-033 — Adaptive routing based on evidence
34. WORK-034 — Multi-provider benchmark system

### Phase 7 — End-to-end proof
35. WORK-035 — Complete live execution lifecycle
36. WORK-036 — Complete safe optimization lifecycle
37. WORK-037 — Complete two-sided marketplace lifecycle

## 8. Critical convergence gates

`WORK-016` cannot begin execution against real providers until capability, catalog, connection, eligibility, strategy, and routing contracts exist.

`WORK-023` must not directly mutate live execution behavior; it only produces candidate strategies.

`WORK-026` must preserve an incumbent strategy and prove bounded canary behavior before promotion.

`WORK-027` must prove rollback without requiring the optimizer or LLM to be available.

`WORK-031` must use the same provider contract as platform-operated integrations.

`WORK-037` is not complete until a customer can submit a capability-oriented request through the API, observe the complete execution, inspect provider selection and reasoning, run a candidate optimization, safely canary it, and roll it back.
