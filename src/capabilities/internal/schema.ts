// /capabilities/internal/schema.ts
// PostgreSQL schema for the /capabilities module (architecture §2.2, §6, §36,
// §37, lock §1, §7, §8, WORK-005 CAP-001..004). Owns the provider-neutral
// capability catalog: capability identities, immutable versioned contracts,
// and the directed capability dependency graph. PostgreSQL is the
// authoritative store for capability state; Redis is never authoritative
// here (lock §1).
//
// Authority model (WORK-005 §12, §15): capabilities are GLOBAL CP-level
// platform primitives — a semantic capability such as `payment.accept` is
// not "owned" by a single organization. There is therefore NO
// organization_id / project_id column on the global capability identity.
// Customer-specific configuration and usage is tenant-scoped and belongs to
// future project/org/resource layers — explicitly out of scope for WORK-005.
//
// Mutations of the global catalog are gated by a CP-level platform-admin
// grant (`cp_capability_admins`), NOT by an org-membership role. This keeps
// "CP platform capability definition" distinct from "customer-owned
// configuration" (WORK-005 §12).
//
// DDL is idempotent (CREATE TABLE IF NOT EXISTS) so
// `migrateCapabilitiesSchema(db)` is safe on every startup and in tests. Each
// statement runs individually via `Database.exec()` because the `pg` driver
// does not support multi-statement queries in one round-trip.
//
// DB-enforced invariants (WORK-005):
//   - canonical capability id is globally unique (case-insensitive) — two
//     rows with the same `payment.accept` cannot coexist (race-safe under
//     concurrent creates)
//   - a capability version is uniquely identified by (capability_id, version)
//     — the same version string cannot be published twice
//   - a dependency edge is uniquely identified by (capability_id, version,
//     required_capability_id, required_version) — duplicate edges are rejected
//   - dependency rows reference real capabilities (FK → cp_capabilities)
//   - lifecycle status is constrained to draft|active|deprecated|retired
//   - side-effect classification is constrained to the §6 set
//   - version is a positive-integer string (1, 2, 3, ...)

export const CAP_SCHEMA_STATEMENTS: readonly string[] = [
  // ---- Capability identity (global, stable canonical id) ----------------
  `CREATE TABLE IF NOT EXISTS cp_capabilities (
    id                  TEXT PRIMARY KEY,
    capability_id       TEXT NOT NULL,
    name                TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    status              TEXT NOT NULL DEFAULT 'draft',
    created_by_user_id  TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cp_capabilities_status_chk
      CHECK (status IN ('draft', 'active', 'deprecated', 'retired'))
  )`,
  // Canonical capability id is globally unique (case-insensitive). The
  // application-layer validator rejects uppercase, so the stored value is
  // always lowercase; lower() is a defense-in-depth safety net so two rows
  // that differ only by case cannot both exist.
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_capabilities_capability_id_lower_uidx
    ON cp_capabilities (lower(capability_id))`,
  // Lookup by status for the public catalog list.
  `CREATE INDEX IF NOT EXISTS cp_capabilities_status_created_idx
    ON cp_capabilities (status, created_at DESC, id DESC)`,

  // ---- Capability version (immutable published contract) ----------------
  // A version is uniquely identified by (capability_id, version). Once a
  // version reaches status='active' its contract fields are IMMUTABLE
  // (architecture §2.6; WORK-005 §18). An incompatible change requires a
  // NEW version, never a mutation of an existing published version. The
  // service enforces immutability; the DB enforces identity uniqueness.
  `CREATE TABLE IF NOT EXISTS cp_capability_versions (
    id                       TEXT PRIMARY KEY,
    capability_id            TEXT NOT NULL,
    version                  TEXT NOT NULL,
    input_schema             JSONB NOT NULL,
    output_schema            JSONB NOT NULL,
    error_model              JSONB NOT NULL DEFAULT '[]'::jsonb,
    side_effect              TEXT NOT NULL,
    idempotency_semantics    JSONB NOT NULL DEFAULT '{}'::jsonb,
    required_context         JSONB NOT NULL DEFAULT '[]'::jsonb,
    execution_modes          JSONB NOT NULL DEFAULT '[]'::jsonb,
    policy_metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
    constraints              JSONB NOT NULL DEFAULT '[]'::jsonb,
    latency_expectations     JSONB NOT NULL DEFAULT '{}'::jsonb,
    status                   TEXT NOT NULL DEFAULT 'draft',
    created_by_user_id       TEXT NOT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cp_capability_versions_cap_fk
      FOREIGN KEY (capability_id) REFERENCES cp_capabilities(id) ON DELETE RESTRICT,
    CONSTRAINT cp_capability_versions_status_chk
      CHECK (status IN ('draft', 'active', 'deprecated', 'retired')),
    CONSTRAINT cp_capability_versions_side_effect_chk
      CHECK (side_effect IN ('pure', 'read_only', 'idempotent_write',
                             'non_idempotent_write', 'transactional', 'best_effort')),
    CONSTRAINT cp_capability_versions_version_chk
      CHECK (version ~ '^[0-9]+$')
  )`,
  // Immutable version identity: one row per (capability, version).
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_capability_versions_cap_version_uidx
    ON cp_capability_versions (capability_id, version)`,
  // At most ONE active version per capability. A partial unique index so the
  // "active version" (the current effective contract) is unambiguous — this
  // is what a NULL version-pinned dependency edge resolves to. When a new
  // version is published (draft→active), the service deprecates the previous
  // active version within the same transaction so this invariant always holds.
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_capability_versions_active_uidx
    ON cp_capability_versions (capability_id) WHERE status = 'active'`,
  // Lookup all versions of a capability, newest-first.
  `CREATE INDEX IF NOT EXISTS cp_capability_versions_cap_created_idx
    ON cp_capability_versions (capability_id, created_at DESC, id DESC)`,

  // ---- Capability dependency graph (directed, version-aware) ------------
  // An edge means: "capability A (at version vA) requires capability B
  // (optionally pinned to required_version of B, else the active version)."
  // The graph is SEMANTIC — it describes capability dependencies, never
  // provider topology (WORK-005 §10). Cycles are detected at insertion by
  // the service (DFS) and rejected; self-dependencies are rejected; duplicate
  // edges are rejected by the UNIQUE constraint.
  `CREATE TABLE IF NOT EXISTS cp_capability_dependencies (
    id                       TEXT PRIMARY KEY,
    capability_id            TEXT NOT NULL,
    version                  TEXT NOT NULL,
    required_capability_id   TEXT NOT NULL,
    required_version         TEXT,
    created_by_user_id       TEXT NOT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cp_capability_dependencies_cap_fk
      FOREIGN KEY (capability_id) REFERENCES cp_capabilities(id) ON DELETE RESTRICT,
    CONSTRAINT cp_capability_dependencies_req_cap_fk
      FOREIGN KEY (required_capability_id) REFERENCES cp_capabilities(id) ON DELETE RESTRICT,
    CONSTRAINT cp_capability_dependencies_version_chk
      CHECK (version ~ '^[0-9]+$'),
    CONSTRAINT cp_capability_dependencies_req_version_chk
      CHECK (required_version IS NULL OR required_version ~ '^[0-9]+$')
  )`,
  // Duplicate edge rejection: the same (A, vA, B, required_version) cannot
  // be inserted twice. Race-safe under concurrent adds.
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_capability_dependencies_edge_uidx
    ON cp_capability_dependencies
       (capability_id, version, required_capability_id, COALESCE(required_version, ''))`,
  // Outgoing edges for a (capability, version) — the dependency-list query.
  `CREATE INDEX IF NOT EXISTS cp_capability_dependencies_outgoing_idx
    ON cp_capability_dependencies (capability_id, version)`,
  // Incoming edges — used by cycle detection (who depends on B?).
  `CREATE INDEX IF NOT EXISTS cp_capability_dependencies_incoming_idx
    ON cp_capability_dependencies (required_capability_id)`,

  // ---- Platform-admin grant (CP-level, not org-scoped) -----------------
  // A user with a `capability.manage` grant may mutate the global capability
  // catalog (create/publish/version/deprecate/retire capabilities and add
  // dependencies). This is a CP-level authority, distinct from org-membership
  // roles (WORK-005 §12). An arbitrary org owner/admin without a grant cannot
  // mutate the catalog (proven in tests/security/capability-authority).
  `CREATE TABLE IF NOT EXISTS cp_capability_admins (
    user_id            TEXT NOT NULL,
    permission         TEXT NOT NULL DEFAULT 'capability.manage',
    granted_by_user_id TEXT,
    granted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cp_capability_admins_pk PRIMARY KEY (user_id, permission)
  )`,

  // ---- First-admin bootstrap claim (singleton, atomic) ------------------
  // Architect review #2 of PR #4: the FIRST capability-admin bootstrap must
  // be atomic AT THE DATABASE LEVEL. The prior check-then-insert
  // implementation (SELECT emptiness → INSERT) allowed two concurrent
  // instances with DIFFERENT user_ids to both observe an empty
  // cp_capability_admins and both insert their own bootstrap admin —
  // ON CONFLICT (user_id, permission) could not help because the two rows
  // have different primary keys.
  //
  // This table can contain AT MOST ONE row EVER: its PRIMARY KEY is the
  // constant TRUE (the CHECK rejects any other value). Concurrent bootstrap
  // attempts therefore conflict on this single key REGARDLESS of the
  // user_id they carry. PostgreSQL serializes concurrent inserts of the
  // same key: the loser's INSERT ... ON CONFLICT (singleton) DO NOTHING
  // blocks until the winner's statement commits, then resolves to a no-op.
  // Exactly one claim row can ever exist → exactly one bootstrap admin can
  // ever be granted by the deployment mechanism.
  //
  // The row is also the audit record of WHO bootstrapped the installation
  // (user_id + source + created_at).
  `CREATE TABLE IF NOT EXISTS cp_capability_admin_bootstrap (
    singleton  BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    user_id    TEXT NOT NULL,
    source     TEXT NOT NULL DEFAULT 'deployment-config',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];
