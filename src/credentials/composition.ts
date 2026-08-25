// /credentials/composition.ts — the TRUSTED CAPABILITY CONSTRUCTION ENTRY
// (WORK-010; architect reviews #1 and #2 of PR #9).
//
// This file is the ONLY place in the codebase from which the privileged
// credential capabilities (mutationAuthority, adapterResolver) can be
// constructed. It is deliberately NOT exported through the module's
// ordinary public interface (index.ts): importing `@cp/credentials` can
// never obtain this factory, so an ordinary module cannot manufacture
// either capability (architect review #2 — the public factory recreated
// the authority problem one layer higher).
//
// The static architecture check (scripts/arch-check.mjs, rule
// `credentials-composition-restricted`) permits importing
// `@cp/credentials/composition` (or a relative path to this file) from
// EXACTLY ONE trusted file: the composition root
// (src/api/internal/server.ts). Every other importer — handlers, main,
// any domain module — is rejected. The invariant:
//
//     composition root (server.ts)
//            │ createCredentialsBoundary(...)
//            ├── service (metadata-only) ──→ ordinary domain consumers
//            ├── mutationAuthority ─────────→ /connections
//            └── adapterResolver ───────────→ future execution seam
//
//     ordinary module → @cp/credentials → ✗ cannot manufacture either
//     capability (the factory is not on the public interface, and the
//     composition path is importable only by the composition root).
//
// This remains a GENUINE RUNTIME authority boundary, not a TypeScript
// brand: the capabilities are frozen objects whose references propagate
// only via explicit injection from the composition root, and there is no
// minting method anywhere — authority is object ownership, and the only
// constructor of authority is reachable by exactly one trusted file.
//
// Tests import this file directly (they are the verification layer,
// outside the src/ module graph the architecture checker governs) to
// prove the composition mechanism distributes both capabilities.

export { createCredentialsBoundary } from "./internal/service.ts";
export type {
  CredentialsBoundary,
  CredentialsBoundaryOptions,
} from "./internal/service.ts";
