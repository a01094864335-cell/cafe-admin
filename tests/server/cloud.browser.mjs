import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { getPlatformProxy, unstable_dev } from "wrangler";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { migrate, seed, stmt } from "./helpers.mjs";
import { randomToken, hash } from "../../src/server/auth/crypto.ts";

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
test(
  "two isolated browsers share a sale; staff isolation, dirty input and mobile layout work",
  { timeout: 120000 },
  async (t) => {
    const persistTo = await mkdtemp(join(tmpdir(), "cafe-w08-browser-"));
    t.after(() => rm(persistTo, { recursive: true, force: true }));
    const proxy = await getPlatformProxy({
      configPath: "wrangler.toml",
      persist: { path: join(persistTo, "v3") },
      remoteBindings: false,
    });
    await migrate(proxy.env.DB);
    await seed(proxy.env.DB);
    const sessions = {};
    for (const id of ["u1", "u2"]) {
      const token = randomToken(),
        csrf = randomToken();
      sessions[id] = { token, csrf };
      await stmt(
        proxy.env.DB,
        "INSERT INTO sessions(token_hash,user_id,csrf_hash,expires_at) VALUES (?,?,?,?)",
        await hash(token),
        id,
        await hash(csrf),
        new Date(Date.now() + 86400000).toISOString(),
      ).run();
    }
    await proxy.dispose();
    const port = await freePort(),
      origin = `https://127.0.0.1:${port}`;
    const worker = await unstable_dev("src/server/index.ts", {
      config: "wrangler.toml",
      local: true,
      localProtocol: "https",
      ip: "127.0.0.1",
      port,
      inspectorPort: 0,
      persistTo,
      vars: {
        APP_ORIGIN: origin,
        INVITATION_TOKEN_KEY: randomToken(),
        CAFE_CREATOR_IDS: "u1",
      },
      logLevel: "error",
      experimental: {
        disableExperimentalWarning: true,
        disableDevRegistry: true,
        watch: false,
      },
    });
    t.after(() => worker.stop());
    const browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    });
    t.after(() => browser.close());
    async function session(user, viewport) {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport,
      });
      await context.addCookies([
        {
          name: "__Host-session",
          value: sessions[user].token,
          url: origin,
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
        {
          name: "__Host-csrf",
          value: sessions[user].csrf,
          url: origin,
          secure: true,
          sameSite: "Lax",
        },
      ]);
      return context;
    }
    const a = await session("u1", { width: 1360, height: 950 }),
      b = await session("u2", { width: 1360, height: 950 });
    const owner = await a.newPage(),
      admin = await b.newPage();
    await owner.goto(origin + "/cloud.html");
    await admin.goto(origin + "/cloud.html");
    await owner
      .locator("#sale-form")
      .waitFor({ timeout: 10000 })
      .catch(async (e) => {
        throw Error(
          (await owner.locator("body").innerText()) + " " + e.message,
        );
      });
    await admin.locator("#sale-form").waitFor();
    await owner.locator("[name=businessDate]").fill("2026-10-08");
    await owner.locator("[name=card]").fill("12345");
    await owner.locator("[name=cash]").fill("0");
    await owner.locator("[name=note]").fill("두 브라우저 공유 검증");
    await owner.getByRole("button", { name: "저장", exact: true }).click();
    await owner
      .getByRole("row")
      .filter({ hasText: "두 브라우저 공유 검증" })
      .waitFor();
    await admin.getByRole("button", { name: "새로고침" }).click();
    await admin
      .getByRole("row")
      .filter({ hasText: "두 브라우저 공유 검증" })
      .waitFor();
    assert.match(await admin.locator("#records").innerText(), /12,345원/);
    await owner.locator("[name=note]").fill("저장 전 입력");
    owner.once("dialog", (d) => d.dismiss());
    await owner.locator("#cafe").selectOption("b");
    assert.equal(await owner.locator("#cafe").inputValue(), "a");
    assert.equal(
      await owner.locator("[name=note]").inputValue(),
      "저장 전 입력",
    );
    owner.once("dialog", (d) => d.accept());
    await owner.locator("#cafe").selectOption("b");
    await owner.getByText("직원 권한으로 참여 중입니다").waitFor();
    assert.equal(await owner.locator("#sale-form").count(), 0);
    const denied = await a.request.get(origin + "/api/v1/cafes/b/sales");
    assert.equal(denied.status(), 403);

    const errors = [];
    admin.on("pageerror", (e) => errors.push(e.message));
    await admin.locator("[data-view=purchases]").click();
    await admin.locator("#sale-form [name=businessDate]").fill("2026-10-09");
    await admin.locator("[name=item]").fill("브라우저 매입");
    await admin.locator("[name=amount]").fill("5000");
    await admin.locator("#sale-form button[type=submit]").click();
    await admin.getByRole("row").filter({ hasText: "브라우저 매입" }).waitFor();
    await admin.locator("[data-view=inventory]").click();
    await admin.locator("#inventory-form [name=name]").fill("검증 원두");
    await admin.locator("#inventory-form [name=unit]").fill("kg");
    await admin.locator("#inventory-form [name=quantity]").fill("2.5");
    await admin.locator("#inventory-form button").first().click();
    await admin.getByRole("row").filter({ hasText: "검증 원두" }).waitFor();
    await admin.locator("[data-view=work]").click();
    await admin.waitForFunction(
      () => document.querySelector("#employee-select")?.options.length > 1,
    );
    await admin.locator("#employee-form [name=name]").fill("브라우저 직원");
    await admin.locator("#employee-form [name=hireDate]").fill("2026-10-01");
    await admin.locator("#employee-form button").first().click();
    await admin
      .waitForFunction(
        () =>
          document.querySelector("#employee-select")?.selectedOptions[0]
            ?.textContent === "브라우저 직원",
        {},
        { timeout: 10000 },
      )
      .catch(async (e) => {
        throw Error(
          (await admin.locator("body").innerText()) + " " + e.message,
        );
      });
    await admin.locator("#work-form [name=businessDate]").fill("2026-10-09");
    await admin.locator("#work-form [name=startTime]").fill("09:00");
    await admin.locator("#work-form [name=endTime]").fill("13:00");
    await admin.locator("#work-form button").first().click();
    await admin.getByRole("row").filter({ hasText: "2026-10-09" }).waitFor();
    await admin.locator("[data-view=payroll]").click();
    await admin
      .locator("#payroll-employee option")
      .filter({ hasText: "브라우저 직원" })
      .waitFor({ state: "attached" });
    await admin
      .locator("#payroll-employee")
      .selectOption({ label: "브라우저 직원" });
    await admin.locator("#settings-form [name=firstWeek]").fill("2026-10-05");
    await admin.locator("#settings-form [name=holidayDay]").selectOption("일");
    await admin.locator("#settings-form [name=rates]").fill('{"2026":10000}');
    await admin.locator("#settings-form button").first().click();
    await admin.locator("[data-setting]").waitFor();
    await admin.locator("[data-view=members]").click();
    await admin
      .locator("#invite-form [name=email]")
      .fill("staff@example.invalid");
    await admin.locator("#invite-form button").click();
    await admin.locator("#invite-result input").waitFor();
    assert.match(
      await admin.locator("#invite-result input").inputValue(),
      /#invite=[A-Za-z0-9_-]{43}$/,
    );
    await admin.locator("#cancel-invite").click();
    await admin.getByText("초대를 취소했습니다.").waitFor();
    await admin.locator("[data-view=sales]").click();
    await admin.locator("#sale-form").waitFor();
    assert.deepEqual(errors, []);
    await admin.screenshot({
      path: "/tmp/cafe-cloud-desktop.png",
      fullPage: true,
    });
    const mobile = await session("u2", { width: 390, height: 844 }),
      phone = await mobile.newPage();
    await phone.goto(origin + "/cloud.html");
    await phone.locator("#sale-form").waitFor();
    await phone.screenshot({
      path: "/tmp/cafe-cloud-mobile.png",
      fullPage: true,
    });
    assert.equal(
      await phone.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
  },
);
