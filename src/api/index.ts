// /api — public interface.
//
// Transport boundary (architecture §35). The API layer imports only the
// public interfaces of domain modules; it must not import any module's
// internal implementation (lock §8). Concrete /v1 resource families are
// added in WORK-004; WORK-001 ships the transport host + correlation
// middleware + async-operation demo route.

export { createApi, serve } from "./internal/server.ts";
export type {
  Api,
  ServedApi,
  ServeOptions,
} from "./internal/server.ts";
export type { ApiContext } from "./internal/middleware.ts";
