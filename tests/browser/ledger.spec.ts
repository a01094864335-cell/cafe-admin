import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/legacy-v2.json", import.meta.url), "utf8"),
);
const key = "cafe-admin-public-v1";

test("all screens render and daily sales survive save and reload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  for (const name of [
    "sales",
    "expenses",
    "payroll",
    "inventory",
    "reports",
    "settings",
    "dashboard",
  ]) {
    await page.locator(`#nav [data-page="${name}"]`).click();
    await expect(page.locator("main h1")).toBeVisible();
  }
  await page.locator('#nav [data-page="sales"]').click();
  await page
    .locator('[data-action="date-record"][data-type="sale"]')
    .first()
    .click();
  await page.locator('#recordForm [name="card"]').fill("12345");
  await page.locator('#recordForm [name="cash"]').fill("0");
  await page.locator('#recordForm [name="note"]').fill("가상 브라우저 검증");
  await page.locator('#recordForm button[type="submit"]').click();
  await expect(page.locator("#modal")).not.toBeVisible();
  await page.reload();
  const data = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    key,
  );
  expect(data.sales[0]).toMatchObject({
    card: 12345,
    cash: 0,
    transfer: null,
    note: "가상 브라우저 검증",
  });
  expect(errors).toEqual([]);
});

test("v2 restore, period totals, theme and backup work", async ({ page }) => {
  await page.goto("/");
  await page.locator('#nav [data-page="settings"]').click();
  await page
    .locator("#restoreFile")
    .setInputFiles({
      name: "synthetic.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture)),
    });
  await expect(page.locator("#confirmDialog")).toBeVisible();
  await page.locator('#confirmDialog button[value="accept"]').click();
  await expect(page.locator(".store")).toContainText("가상 검증 카페");
  await page.locator('#nav [data-page="reports"]').click();
  await page.locator('[name="rangeStart"]').fill("2026-10-01");
  await page.locator('[name="rangeEnd"]').fill("2026-10-31");
  await page.locator('#periodForm button[type="submit"]').click();
  await expect(page.locator(".statement")).toContainText("-11,167원");
  await page.locator("#themeToggle").click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator('#nav [data-page="settings"]').click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator('[data-action="backup"]').click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const exported = JSON.parse(Buffer.concat(chunks).toString());
  expect(exported.sales).toEqual(fixture.sales);
  expect(exported.employment).toEqual(fixture.employment);
  expect(exported.lastBackup).toBeTruthy();
});

test("write failure keeps modal input and old persisted ledger", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator('#nav [data-page="sales"]').click();
  await page
    .locator('[data-action="date-record"][data-type="sale"]')
    .first()
    .click();
  await page.locator('#recordForm [name="card"]').fill("5000");
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Storage full", "QuotaExceededError");
    };
  });
  await page.locator('#recordForm button[type="submit"]').click();
  await expect(page.locator("#toast")).toContainText("저장 실패");
  await expect(page.locator("#modal")).toBeVisible();
  await expect(page.locator('#recordForm [name="card"]')).toHaveValue("5000");
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).sales.length,
      key,
    ),
  ).toBe(0);
});

test("corrupt saved data is not overwritten at startup", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "{broken"), key);
  await page.goto("/");
  await expect(page.locator("#main")).toContainText(
    "기존 저장값은 덮어쓰지 않습니다",
  );
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    "{broken",
  );
});
