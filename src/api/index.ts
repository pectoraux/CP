// /api — public interface.
//
// Transport boundary (architecture §35). The API layer imports only the
// public interfaces of domain modules; it must not import any module's
// internal implementation (lock §8). WORK-001 ships the transport host +
// correlation middleware + async-operation demo route. WORK-003 adds
// authentication, organization, and tenant-isolation routes via @cp/auth
// and @cp/organizations public interfaces.

export { createApi, serve } from "./internal/server.ts";
export type {
  Api,
  ServedApi,
  ServeOptions,
} from "./internal/server.ts";
export type {
  ApiContext,
  AuthVars,
} from "./internal/middleware.ts";
export {
  authMiddleware,
  orgContextMiddleware,
  requirePrincipal,
  errorHandler,
} from "./internal/middleware.ts";

