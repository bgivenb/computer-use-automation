import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { PermissionSet } from "../core/contracts.js";
import { routeMatches } from "../core/policy.js";

export type ControllerOwner = "automation" | "human" | "none";

export type SessionOptions = {
  headless?: boolean;
  permissions: PermissionSet;
  viewport?: { width: number; height: number };
};

export const networkUrlAllowed = (
  rawUrl: string,
  allowedOrigins: ReadonlySet<string>,
  allowedRoutes: readonly string[],
): boolean => {
  const url = new URL(rawUrl);
  if (url.protocol === "about:" || url.protocol === "data:") return true;

  const normalizedOrigin =
    url.protocol === "ws:"
      ? `http://${url.host}`
      : url.protocol === "wss:"
        ? `https://${url.host}`
        : url.origin;
  return (
    allowedOrigins.has(normalizedOrigin) &&
    allowedRoutes.some((candidate) => routeMatches(url.pathname, candidate))
  );
};

export class ControllerLeaseError extends Error {
  readonly code = "controller_lease";

  constructor(expected: ControllerOwner, actual: ControllerOwner) {
    super(`Controller lease belongs to ${actual}; ${expected} action rejected`);
    this.name = "ControllerLeaseError";
  }
}

export class RunSession {
  readonly id = randomUUID();
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly allowedRoutes: readonly string[];

  #owner: ControllerOwner = "automation";
  #closed = false;

  private constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    allowedOrigins: ReadonlySet<string>,
    allowedRoutes: readonly string[],
  ) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.allowedOrigins = allowedOrigins;
    this.allowedRoutes = allowedRoutes;
  }

  static async launch(options: SessionOptions): Promise<RunSession> {
    const allowedOrigins = new Set(
      options.permissions.origins.map((origin) => new URL(origin).origin),
    );
    const allowedRoutes = [...options.permissions.routes];
    const browser = await chromium.launch({ headless: options.headless ?? true });
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      viewport: options.viewport ?? { width: 1440, height: 900 },
    });

    await context.route("**/*", async (route) => {
      if (networkUrlAllowed(route.request().url(), allowedOrigins, allowedRoutes)) {
        await route.continue();
        return;
      }

      await route.abort("blockedbyclient");
    });

    await context.routeWebSocket(/.*/, async (socket) => {
      if (networkUrlAllowed(socket.url(), allowedOrigins, allowedRoutes)) {
        socket.connectToServer();
        return;
      }
      await socket.close({ code: 1008, reason: "Blocked by runtime policy" });
    });

    const page = await context.newPage();
    return new RunSession(browser, context, page, allowedOrigins, allowedRoutes);
  }

  get owner(): ControllerOwner {
    return this.#owner;
  }

  get closed(): boolean {
    return this.#closed;
  }

  assertOwner(expected: Exclude<ControllerOwner, "none">): void {
    if (this.#owner !== expected) {
      throw new ControllerLeaseError(expected, this.#owner);
    }
  }

  pauseAutomation(): void {
    this.assertOwner("automation");
    this.#owner = "none";
  }

  claimHuman(): void {
    if (this.#owner !== "none") {
      throw new ControllerLeaseError("human", this.#owner);
    }
    this.#owner = "human";
  }

  releaseHuman(): void {
    this.assertOwner("human");
    this.#owner = "none";
  }

  resumeAutomation(): void {
    if (this.#owner !== "none") {
      throw new ControllerLeaseError("automation", this.#owner);
    }
    this.#owner = "automation";
  }

  async withAutomation<T>(action: (page: Page) => Promise<T>): Promise<T> {
    this.assertOwner("automation");
    return action(this.page);
  }

  async withHuman<T>(action: (page: Page) => Promise<T>): Promise<T> {
    this.assertOwner("human");
    return action(this.page);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#owner = "none";
    await this.browser.close();
  }
}
