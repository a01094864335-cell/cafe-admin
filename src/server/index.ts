import { auditRoute } from "./routes/audit.ts";
import {
  cleanupExpired,
  operationalError,
  routeGroup,
} from "./services/operations.ts";
import { importRoute } from "./routes/imports.ts";
import { exportRoute } from "./routes/exports.ts";
import { summaryRoute } from "./routes/summary.ts";
import { payrollRoute } from "./routes/payroll.ts";
import { workRoute } from "./routes/work.ts";
import { inventoryRoute } from "./routes/inventory.ts";
import { ledgerRoute } from "./routes/ledger.ts";
import type { Env } from "./env.ts";
import { HttpError } from "./http.ts";
import { authRoute } from "./auth/routes.ts";
import { cafeRoute } from "./services/memberships.ts";
import { invitationRoute } from "./services/invitations.ts";
export default {
  async scheduled(_event: unknown, env: Env) {
    try {
      await cleanupExpired(env);
    } catch {
      console.error(
        JSON.stringify({ event: "cleanup_failed", code: "CLEANUP_FAILED" }),
      );
      throw new Error("CLEANUP_FAILED");
    }
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!/^\/(api|auth)(\/|$)/.test(path)) return env.ASSETS.fetch(request);
    const requestId = crypto.randomUUID();
    const started = Date.now();
    const headers = new Headers(request.headers);
    headers.set("X-Request-ID", requestId);
    request = new Request(request, { headers });
    try {
      const response =
        (await authRoute(request, env, requestId)) ??
        (await cafeRoute(request, env, requestId)) ??
        (await invitationRoute(request, env, requestId)) ??
        (await ledgerRoute(request, env, requestId)) ??
        (await inventoryRoute(request, env, requestId)) ??
        (await workRoute(request, env, requestId)) ??
        (await payrollRoute(request, env, requestId)) ??
        (await summaryRoute(request, env, requestId)) ??
        (await importRoute(request, env, requestId)) ??
        (await exportRoute(request, env, requestId)) ??
        (await auditRoute(request, env, requestId)) ??
        Response.json(
          {
            error: {
              code: "NOT_FOUND",
              message: "요청한 경로를 찾을 수 없습니다.",
            },
            requestId,
          },
          { status: 404, headers: { "Cache-Control": "no-store" } },
        );
      response.headers.set("Referrer-Policy", "no-referrer");
      response.headers.set("X-Request-ID", requestId);
      return response;
    } catch (error) {
      const safe = operationalError(error),
        { status, code } = safe;
      console.warn(
        JSON.stringify({
          event: "request_failed",
          requestId,
          method: [
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "HEAD",
            "OPTIONS",
          ].includes(request.method)
            ? request.method
            : "OTHER",
          route: routeGroup(path),
          status,
          code,
          durationMs: Date.now() - started,
        }),
      );
      return Response.json(
        {
          error: {
            code,
            message: code,
            ...(error instanceof HttpError && error.details
              ? { details: error.details }
              : {}),
          },
          requestId,
        },
        {
          status,
          headers: {
            "Cache-Control": "no-store",
            "X-Request-ID": requestId,
            ...([429, 503].includes(status) ? { "Retry-After": "60" } : {}),
            "Referrer-Policy": "no-referrer",
          },
        },
      );
    }
  },
};
