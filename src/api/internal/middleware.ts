// /api/internal/middleware.ts
// Transport-boundary middleware: assigns/preserves the request correlation
// identifier (architecture §23, §28), wraps the request in an execution
// context so logs carry the identifier, and emits structured request logs.
// Translates AppError failures into structured JSON responses (§31).

import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  newRequestId,
  runInContextAsync,
  type Runtime,
} from "@cp/platform";
import { AppError } from "@cp/platform";

interface Vars {
  requestId: string;
}

export function correlationMiddleware(
  runtime: Runtime,
): MiddlewareHandler<{ Variables: Vars }> {
  return async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const requestId = incoming && incoming.length > 0
      ? incoming
      : newRequestId();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    const start = performance.now();
    const method = c.req.method;
    const path = c.req.path;
    runtime.logger.info("api: request.start", { method, path });
    await runInContextAsync({ requestId }, async () => {
      await next();
    });
    const elapsedMs = Math.round(performance.now() - start);
    runtime.logger.info("api: request.end", {
      method,
      path,
      status: c.res.status,
      elapsed_ms: elapsedMs,
    });
  };
}

const STATUS_BY_CATEGORY: Record<string, ContentfulStatusCode> = {
  PROVIDER_FAILURE: 502,
  NETWORK_FAILURE: 502,
  RATE_LIMITED: 429,
  TIMEOUT: 504,
  POLICY_BLOCKED: 403,
  INELIGIBLE: 422,
  CREDENTIAL_FAILURE: 401,
  EXECUTION_FAILURE: 500,
  OUTCOME_FAILURE: 500,
  PLATFORM_FAILURE: 500,
  EXPERIMENT_FAILURE: 500,
};

export function errorMiddleware(): MiddlewareHandler<{
  Variables: Vars;
}> {
  return async (c, next) => {
    try {
      await next();
    } catch (err) {
      const requestId = c.get("requestId");
      if (err instanceof AppError) {
        const status: ContentfulStatusCode =
          STATUS_BY_CATEGORY[err.category] ?? 500;
        return c.json(
          {
            error: {
              category: err.category,
              code: err.code,
              message: err.message,
              retryable: err.retryable,
              request_id: requestId,
            },
          },
          status,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        {
          error: {
            category: "PLATFORM_FAILURE",
            code: "api.unhandled",
            message,
            retryable: false,
            request_id: requestId,
          },
        },
        500,
      );
    }
  };
}

export type ApiContext = Context<{ Variables: Vars }>;
