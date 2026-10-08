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
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!/^\/(api|auth)(\/|$)/.test(path)) return env.ASSETS.fetch(request);
    const requestId = crypto.randomUUID();
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
      return response;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500,
        code = error instanceof HttpError ? error.code : "INTERNAL_ERROR";
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
            "Referrer-Policy": "no-referrer",
          },
        },
      );
    }
  },
};
