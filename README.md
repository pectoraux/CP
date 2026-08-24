# Control Plane

Intelligent control plane for composing existing digital capabilities, executing them safely, and continuously discovering better strategies without directly mutating live production strategies.

## Authoritative specification

- `spec/architecture.md` — frozen architecture
- `spec/architecture-lock.md` — frozen invariants
- `spec/dependency-graph.md` — dependency and implementation order
- `spec/work-items.md` — implementation backlog

## Implementation model

The product follows a WorkflowOS-inspired development lifecycle:

Architecture → Requirements → Acceptance Criteria → Work Items → Implementation → Verification → Architect Review → Merge → Evidence

The runtime product follows:

Intent → Capability → Eligibility → Strategy → Execution → Observation → Outcome → Experiment → Promotion
