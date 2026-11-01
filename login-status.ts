import type { Page } from "playwright-core";

export async function inspectLogin(page: Page) {
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 20000 });
  const account = page.locator('[data-testid="SideNav_AccountSwitcher_Button"]');
  const login = page.locator('input[autocomplete="username"], input[name="password"]').first();
  await Promise.race([
    account.waitFor({ state: "visible", timeout: 15000 }).catch(() => {}),
    login.waitFor({ state: "visible", timeout: 15000 }).catch(() => {}),
  ]);
  const path = new URL(page.url()).pathname;
  // A loaded page alone isn't evidence of a usable login.
  const challenge = /\/account\/access|\/challenge/.test(path)
    || await page.locator('iframe[src*="captcha"]').count() > 0;
  const outcome = challenge ? "challenge"
    : await account.isVisible() ? "authenticated"
    : await login.isVisible() || /\/i\/flow\/login|\/login/.test(path) ? "login_required"
    : "unknown";
  return { outcome, path };
}
