// No automatic write retries. Keep the caller's idempotency key across failures.
export function createApi({
  csrfToken,
  messages,
  fetcher = fetch,
  now = Date.now,
}) {
  let blockedUntil = 0;
  return async (path, { method = "GET", data, key, signal } = {}) => {
    if (now() < blockedUntil) {
      const error = new Error(
        `요청을 잠시 멈췄습니다. ${Math.ceil((blockedUntil - now()) / 1000)}초 후 다시 시도해 주세요.`,
      );
      error.code = "RATE_LIMITED";
      throw error;
    }
    const response = await fetcher(path, {
      method,
      credentials: "same-origin",
      signal,
      headers: {
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        ...(method === "GET" ? {} : { "X-CSRF-Token": csrfToken() ?? "" }),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    let value;
    try {
      value = await response.json();
    } catch {
      value = null;
    }
    if (!response.ok || !value || typeof value !== "object") {
      const overloaded = [429, 502, 503, 504].includes(response.status);
      if (overloaded) {
        const retry = Number(response.headers.get("Retry-After"));
        blockedUntil =
          now() +
          (Number.isFinite(retry) && retry > 0
            ? Math.min(3600, Math.max(5, retry))
            : 60) *
            1000;
      }
      const code =
        value?.error?.code ??
        (response.status === 429 ? "RATE_LIMITED" : "TEMPORARILY_UNAVAILABLE");
      const requestId =
        value?.requestId ?? response.headers.get("X-Request-ID");
      const suffix = /^[0-9a-f-]{36}$/.test(requestId ?? "")
        ? ` (요청 번호: ${requestId})`
        : "";
      const error = new Error(
        (messages[code] ??
          "처리하지 못했습니다. 입력을 유지한 채 다시 시도해 주세요.") + suffix,
      );
      error.code = code;
      error.details = value?.error?.details;
      error.requestId = requestId;
      throw error;
    }
    return value;
  };
}
