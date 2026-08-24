# Control Plane Dependency Graph

**Version:** 1.0  
**Purpose:** Define work/requirement dependencies and the implementation order for Control Plane 1.0.

---

# 1. Requirement Dependency Graph

```text
PLAT-001
  ├── DATA-001
  ├── DATA-002
  ├── DATA-003
  ├── OBS-001
  └── SEC-001

DATA-001 → ORG-001 → PROJ-001

PROJ-001 → CAP-001 → PROV-001
CAP-001 + PROV-001 → CAT-001

PROJ-001 + SEC-001 → POLICY-001
CAT-001 + POLICY-001 → ELIG-001

CAP-001 + ELIG-001 → PLAN-001
PLAN-001 + ELIG-001 → EXEC-001

PROV-001 + EXEC-001 → ROUTE-001
EXEC-001 → OBS-001 → OUT-001

EXEC-001 + OUT-001 → EXP-001
EXP-001 + OBS-001 → OPT-001
OPT-001 + PLAN-001 → STRAT-001
STRAT-001 + EXP-001 → PROMO-001

PROV-001 → CERT-001
CERT-001 + CAT-001 → MARKET-001

OBS-001 + EXEC-001 + EXP-001 → HUMAN-001

AUTH-001 + API-001 → all customer-facing operations
```

---

# 2. Work Item Dependency Graph

```text
WORK-001 Platform Foundation
        │
        ├──────────────┐
        ▼              ▼
WORK-002 Storage    WORK-003 Identity / Tenancy
        │              │
        └──────┬───────┘
               ▼
        WORK-004 Projects / API foundation
               │
       ┌───────┼────────┬─────────────┐
       ▼       ▼        ▼             ▼
    WORK-005 WORK-006 WORK-007     WORK-008
    Capabilities Providers Catalog   Policies
       │       │        │             │
       └───────┼────────┴──────┬──────┘
               ▼               ▼
           WORK-009        WORK-010
          Eligibility       Connections
               │               │
               └───────┬───────┘
                       ▼
                  WORK-011 Goals
                       │
                       ▼
                  WORK-012 Plans / Strategies
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
        WORK-013 Routing     WORK-014 Execution
             │                   │
             └─────────┬─────────┘
                       ▼
                  WORK-015 Observations
                       │
                       ▼
                  WORK-016 Outcomes
                       │
            ┌──────────┴──────────┐
            ▼                     ▼
       WORK-017 Evidence     WORK-018 Human Observability
            │                     │
            └──────────┬──────────┘
                       ▼
                  WORK-019 Experiments
                       │
                       ▼
                  WORK-020 Optimization
                       │
                       ▼
                  WORK-021 Strategy Promotion
                       │
          ┌────────────┼─────────────┐
          ▼            ▼             ▼
     WORK-022 Audit  WORK-023 Events  WORK-024 API/SDK
                       │             │
                       └──────┬──────┘
                              ▼
                         WORK-025
                    Provider marketplace
                              │
                              ▼
                         WORK-026
                    Initial integrations
                              │
                              ▼
                         WORK-027
                    End-to-end lifecycle
```

---

# 3. Parallelization

After WORK-001 through WORK-004 are stable, these streams can proceed in parallel:

```text
A. Capability / Provider / Catalog
B. Identity / Policy / Connections
C. Goals / Plans
D. Observability / Evidence
E. API contracts / SDK foundations
```

After the relevant contracts exist:

```text
Routing
Execution
Experiments
Human Observability
Provider Certification
```

can proceed in parallel where their dependencies are satisfied.

Optimization and promotion must converge only after execution, observation, outcome, and experiment contracts exist.

---

# 4. Critical Invariants

- Work-item dependencies must form an acyclic graph.
- `/eligibility` precedes performance ranking.
- `/executions` is independent of `/optimization` for live execution safety.
- `/experiments` owns promotion and rollback.
- `/plans` owns strategy identity/content.
- `/providers` owns provider-specific behavior.
- `/capabilities` remains provider-neutral.
- `/observations` preserves underlying measurements.
- Human observability consumes authoritative records rather than duplicating them.

---

# 5. Recommended Implementation Phases

## Phase 1 — Foundation

1. WORK-001
2. WORK-002
3. WORK-003
4. WORK-004

## Phase 2 — Marketplace Semantic Core

5. WORK-005
6. WORK-006
7. WORK-007
8. WORK-008
9. WORK-009
10. WORK-010

## Phase 3 — Planning and Runtime

11. WORK-011
12. WORK-012
13. WORK-013
14. WORK-014

## Phase 4 — Evidence and Operations

15. WORK-015
16. WORK-016
17. WORK-017
18. WORK-018

## Phase 5 — Safe Optimization

19. WORK-019
20. WORK-020
21. WORK-021

## Phase 6 — Marketplace and Developer Product

22. WORK-022
23. WORK-023
24. WORK-024
25. WORK-025
26. WORK-026

## Phase 7 — Convergence

27. WORK-027

---

# 6. Definition of First Usable Product

The first usable vertical is complete when WORK-001 through WORK-027 provide this flow:

```text
Create project
 → connect provider
 → invoke capability
 → execute with strategy
 → observe execution
 → inspect decision
 → record outcome
 → replay historical execution
 → produce candidate strategy
 → safely evaluate
 → canary
 → promote or reject
 → observe resulting improvement
```
