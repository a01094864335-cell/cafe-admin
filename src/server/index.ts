import type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (/^\/(api|auth)(\/|$)/.test(path)) {
      // W05–W08 will register authenticated handlers. No unauthenticated demo DB API.
      return Response.json(
        {
          error: {
            code: "NOT_FOUND",
            message: "요청한 경로를 찾을 수 없습니다.",
          },
          requestId: crypto.randomUUID(),
        },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    return env.ASSETS.fetch(request);
  },
};
