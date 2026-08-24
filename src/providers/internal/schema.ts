// /providers/internal/schema.ts
// PostgreSQL schema for the /providers module (WORK-006, architecture §7,
// §8, §32, lock §1). Owns the provider registry: provider identities,
// provider-capability implementation declarations, and certification
// evidence records. PostgreSQL is the authoritative store (lock §1).
//
// Authority model (WORK-006 §3, §11, frozen §7):
//   - Provider rows are GLOBAL CP-level records (like capabilities): a
//     provider such as `paystack` is not owned by an organization. There
//     is NO organization_id/project_id on provider identity.
//   - Tenant-scoped provider CONNECTIONS and credentials belong to future
//     work (WORK-010 /connections) and are intentionally absent here.
//   - Credential REQUIREMENTS (metadata: which secret kinds the adapter
//     needs) live on provider-capability declarations as JSONB; actual
//     secret VALUES never enter these tables.
//
// Cross-module foreign keys follow the existing precedent
// (cp_projects.organization_id → cp_organizations): the provider registry
// references the capability catalog it implements.
//
// DDL is idempotent (CREATE TABLE IF NOT EXISTS) so
// migrateProvidersSchema(db) is safe on every startup and in tests. Each
// statement runs individually via Database.exec() (the pg driver does not
// support multi-statement round-trips).
//
// DB-enforced invariants (WORK-006):
//   - provider identity is globally unique (case-insensitive) — race-safe
//     under concurrent creates
//   - a provider-capability declaration is uniquely identified by
//     (provider, capability, capability_version) — duplicate declarations
//     rejected
//   - declarations reference real providers and real capabilities (FKs)
//   - provider lifecycle status is constrained to the frozen §7 set
//   - declaration certification state/environment are constrained
//   - evidence rows reference real declarations (FK) and carry a pass/fail
//     result plus environment (fixture | live)

export const PROVIDER_SCHEMA_STATEMENTS: readonly string[] = [
  // ---- Provider identity (global, stable canonical id) ------------------
  // Lifecycle = frozen architecture §7:
  //   DISCOVERED → INTEGRATING → CONTRACT_TESTED → OBSERVED → CERTIFIED → ACTIVE
  //   with SUSPENDED | DEPRECATED | REVOKED (REVOKED terminal).
  // Transitions beyond the linear path are enforced by the service
  // (PROVIDER_LIFECYCLE_TRANSITIONS); the CHECK constraint guarantees only
  // valid state STRINGS can persist.
  `CREATE TABLE IF NOT EXISTS cp_providers (
    id                 TEXT PRIMARY KEY,
    provider_id        TEXT NOT NULL,
    name               TEXT NOT NULL,
    description        TEXT NOT NULL DEFAULT '',
    status             TEXT NOT NULL DEFAULT 'discovered',
    integration_path   TEXT NOT NULL DEFAULT 'platform_operated',
    documentation_url  TEXT,
    created_by_user_id TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cp_providers_status_chk
      CHECK (status IN ('discovered', 'integrating', 'contract_tested',
                        'observed', 'certified', 'active',
                        'suspended', 'deprecated', 'revoked')),
    CONSTRAINT cp_providers_integration_path_chk
      CHECK (integration_path IN ('platform_operated', 'provider_operated'))
  )`,
  // Canonical provider id is globally unique (case-insensitive). The
  // application validator rejects uppercase, so stored values are already
  // lowercase; lower() is defense-in-depth.
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_providers_provider_id_lower_uidx
    ON cp_providers (lower(provider_id))`,
  // Catalog list lookups.
  `CREATE INDEX IF NOT EXISTS cp_providers_status_created_idx
    ON cp_providers (status, created_at DESC, id DESC)`,

  // ---- Provider capability implementation declarations ------------------
  // One row = "provider P implements capability C at EXACTLY version V
  // through adapter version A". Compatibility is contract/version based,
  // never name-based (WORK-006 §12): the FK references the capability's
  // internal surrogate and the version string must be a real, non-retired
  // capability version (service-validated against /capabilities).
  // Certification state advances ONLY on passing evidence (service-
  // enforced); the columns record the current state and the environment
  // the certifying evidence ran in (fixture evidence can never label
  // itself live — WORK-006 §14).
  `CREATE TABLE IF NOT EXISTS cp_provider_capabilities (
    id                        TEXT PRIMARY KEY,
    provider_id               TEXT NOT NULL,
    capability_id             TEXT NOT NULL,
    capability_version        TEXT NOT NULL,
    adapter_version           TEXT NOT NULL,
    status                    TEXT NOT NULL DEFAULT 'registered',
    certification_environment TEXT NOT NULL DEFAULT 'none',
    supported_constraints     JSONB NOT NULL DEFAULT '{}'::jsonb,
    credential_requirements   JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by_user_id        TEXT NOT NULL,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cp_provider_capabilities_provider_fk
      FOREIGN KEY (provider_id) REFERENCES cp_providers(id) ON DELETE RESTRICT,
    CONSTRAINT cp_provider_capabilities_capability_fk
      FOREIGN KEY (capability_id) REFERENCES cp_capabilities(id) ON DELETE RESTRICT,
    CONSTRAINT cp_provider_capabilities_status_chk
      CHECK (status IN ('registered', 'contract_verified', 'certified')),
    CONSTRAINT cp_provider_capabilities_cert_env_chk
      CHECK (certification_environment IN ('none', 'fixture', 'live')),
    CONSTRAINT cp_provider_capabilities_version_chk
      CHECK (capability_version ~ '^[0-9]+$'),
    CONSTRAINT cp_provider_capabilities_adapter_version_chk
      CHECK (adapter_version ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$')
  )`,
  // A provider declares a (capability, version) exactly once.
  `CREATE UNIQUE INDEX IF NOT EXISTS cp_provider_capabilities_decl_uidx
    ON cp_provider_capabilities (provider_id, capability_id, capability_version)`,
  // Declarations by capability (future catalog/eligibility lookups).
  `CREATE INDEX IF NOT EXISTS cp_provider_capabilities_cap_idx
    ON cp_provider_capabilities (capability_id, capability_version)`,
  `CREATE INDEX IF NOT EXISTS cp_provider_capabilities_provider_idx
    ON cp_provider_capabilities (provider_id)`,

  // ---- Certification evidence (append-oriented, evidence-first) ---------
  // One row = one contract-test observation. Certification state may only
  // advance when passing evidence exists (architecture §32: certification
  // is evidence-backed; WORK-006 §13: certification must produce evidence).
  // `environment` distinguishes fixture contract verification from live
  // provider certification — a fixture test can NEVER masquerade as live.
  `CREATE TABLE IF NOT EXISTS cp_provider_certification_evidence (
    id                   TEXT PRIMARY KEY,
    provider_capability_id TEXT NOT NULL,
    test_name            TEXT NOT NULL,
    result               TEXT NOT NULL,
    environment          TEXT NOT NULL,
    adapter_version      TEXT NOT NULL,
    artifact_ref         TEXT,
    detail               JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by_user_id   TEXT NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cp_provider_evidence_declaration_fk
      FOREIGN KEY (provider_capability_id)
      REFERENCES cp_provider_capabilities(id) ON DELETE RESTRICT,
    CONSTRAINT cp_provider_evidence_result_chk
      CHECK (result IN ('pass', 'fail')),
    CONSTRAINT cp_provider_evidence_environment_chk
      CHECK (environment IN ('fixture', 'live')),
    CONSTRAINT cp_provider_evidence_adapter_version_chk
      CHECK (adapter_version ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$')
  )`,
  // Evidence history per declaration, newest-first.
  `CREATE INDEX IF NOT EXISTS cp_provider_evidence_declaration_idx
    ON cp_provider_certification_evidence (provider_capability_id, created_at DESC, id DESC)`,
];
