import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Frame, Locator, Page } from "playwright";
import type {
  ActionReceipt,
  CheckReceipt,
  Command,
  Condition,
  EvidenceRef,
  LocatorAttempt,
  LocatorBundle,
  LocatorResolution,
  LocatorStrategy,
  Observation,
  Target,
} from "../core/contracts.js";
import type { RunSession } from "../runtime/session.js";

type LocatorRoot = Page | Frame;

export type ObservedControl = {
  frameUrl: string;
  tag: string;
  role: string;
  text: string;
  selector: string;
  name?: string;
  type?: string;
  href?: string;
  placeholder?: string;
  src?: string;
  title?: string;
};

export type SurfaceObservation = Observation & {
  controls: ObservedControl[];
};

export type SurfaceActionResult = {
  receipt: ActionReceipt;
  value?: unknown;
};

export type SurfacePolicyContext = {
  url: string;
  fingerprint: string;
  riskText: string;
};

type TargetInspection = {
  tag: string;
  type: string;
  name: string;
  text: string;
  destination: string;
};

const inspectElement = (element: Element): TargetInspection => {
  const link = element.closest("a[href]");
  const form = element.closest("form");
  const destination =
    link instanceof HTMLAnchorElement && !link.hasAttribute("download")
      ? link.href
      : form instanceof HTMLFormElement
        ? new URL(
            element.getAttribute("formaction") ?? form.action ?? document.URL,
            document.baseURI,
          ).href
        : document.URL;
  const value = element instanceof HTMLInputElement ? element.value : "";
  return {
    tag: element.tagName.toLowerCase(),
    type: element.getAttribute("type") ?? "",
    name: element.getAttribute("name") ?? "",
    text: [element.getAttribute("aria-label") ?? "", element.textContent ?? "", value]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500),
    destination,
  };
};

export class LocatorResolutionError extends Error {
  readonly attempts: LocatorAttempt[];

  constructor(target: Target, attempts: LocatorAttempt[]) {
    super(`No unique locator strategy resolved target: ${target.description}`);
    this.name = "LocatorResolutionError";
    this.attempts = attempts;
  }
}

const elapsed = (startedAt: number): number => Math.max(0, performance.now() - startedAt);

const sha256 = (content: Uint8Array): string => createHash("sha256").update(content).digest("hex");

const displayStrategy = (strategy: LocatorStrategy): string => {
  switch (strategy.kind) {
    case "role":
      return `role=${strategy.role} name=${strategy.name}`;
    case "label":
      return `label=${strategy.text}`;
    case "text":
      return `text=${strategy.text}`;
    case "css":
      return `css=${strategy.selector}`;
  }
};

const parseCurrency = (value: string): number => {
  const normalized = value.replace(/[^0-9.-]/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error(`Cannot parse currency value: ${value}`);
  return parsed;
};

export class PlaywrightSurface {
  readonly session: RunSession;
  readonly runDirectory: string;

  #captureSequence = 0;

  constructor(options: { session: RunSession; runDirectory: string }) {
    this.session = options.session;
    this.runDirectory = resolve(options.runDirectory);
  }

  async observe(options: { capture?: boolean; reason?: string } = {}): Promise<SurfaceObservation> {
    return this.session.withAutomation(async (page) => {
      const frames = await Promise.all(
        page.frames().map(async (frame) => ({
          ...(frame.name() ? { name: frame.name() } : {}),
          url: frame.url(),
          visibleText: await this.#visibleText(frame),
        })),
      );
      const visibleText = frames
        .map((frame) => frame.visibleText)
        .filter(Boolean)
        .join("\n");
      const controls = (
        await Promise.all(page.frames().map(async (frame) => this.#controls(frame)))
      ).flat();
      const digest = sha256(
        Buffer.from(
          JSON.stringify({
            url: page.url(),
            visibleText: visibleText.replace(/\s+/g, " ").trim(),
            controls,
          }),
        ),
      );
      const screenshot = options.capture
        ? await this.#captureFromPage(page, options.reason ?? "observation")
        : undefined;

      return {
        url: page.url(),
        title: await page.title(),
        visibleText,
        frames,
        digest,
        controls,
        ...(screenshot === undefined ? {} : { screenshot }),
      };
    });
  }

  async execute(
    command: Command,
    timeoutMs = 10_000,
    expectedPolicy?: SurfacePolicyContext,
  ): Promise<SurfaceActionResult> {
    return this.session.withAutomation(async (page) =>
      this.#executeOnPage(page, command, timeoutMs, expectedPolicy),
    );
  }

  async policyContext(command: Command): Promise<SurfacePolicyContext> {
    return this.session.withAutomation(async (page) => {
      if (command.kind === "navigate") return this.#basicPolicyContext(command.url, command.url);
      if (command.kind === "wait") return this.#basicPolicyContext(page.url(), page.url());

      const resolved = await this.#resolveTarget(command.target);
      const inspection = await resolved.locator.evaluate(inspectElement);
      return this.#targetPolicyContext(command.kind, resolved.root.url(), inspection);
    });
  }

  async check(condition: Condition, options: { timeoutMs?: number } = {}): Promise<CheckReceipt> {
    const startedAt = performance.now();
    const deadline = Date.now() + (options.timeoutMs ?? 0);
    let result = await this.#evaluateCondition(condition);
    while (!result.passed && Date.now() < deadline) {
      await this.session.page.waitForTimeout(Math.min(50, Math.max(1, deadline - Date.now())));
      result = await this.#evaluateCondition(condition);
    }
    return {
      kind: condition.kind,
      passed: result.passed,
      expected: result.expected,
      observed: result.observed,
      durationMs: elapsed(startedAt),
    };
  }

  async capture(reason: string): Promise<EvidenceRef> {
    return this.#captureFromPage(this.session.page, reason);
  }

  async humanCheck(condition: Condition): Promise<boolean> {
    const result = await this.#evaluateCondition(condition);
    return result.passed;
  }

  async #executeOnPage(
    page: Page,
    command: Command,
    timeoutMs: number,
    expectedPolicy?: SurfacePolicyContext,
  ): Promise<SurfaceActionResult> {
    const startedAt = performance.now();
    let actionRoot: LocatorRoot = page;
    let urlBefore = page.url();
    let resolution: LocatorResolution | undefined;
    let value: unknown;

    switch (command.kind) {
      case "navigate":
        this.#assertPolicyContext(
          expectedPolicy,
          this.#basicPolicyContext(command.url, command.url),
        );
        await page.goto(command.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        break;
      case "click": {
        const resolved = await this.#resolveForExecution(command, expectedPolicy);
        actionRoot = resolved.root;
        urlBefore = actionRoot.url();
        resolution = resolved.resolution;
        const expectsNavigation = await resolved.handle.evaluate((element) => {
          const tag = element.tagName.toLowerCase();
          if (tag === "a") {
            return element.hasAttribute("href") && !element.hasAttribute("download");
          }
          const type = (element.getAttribute("type") ?? "submit").toLowerCase();
          return (
            (tag === "button" || tag === "input") && type === "submit" && !!element.closest("form")
          );
        });
        const navigation = expectsNavigation
          ? resolved.root
              .waitForNavigation({ waitUntil: "domcontentloaded", timeout: timeoutMs })
              .catch(() => null)
          : undefined;
        await resolved.handle.click({ timeout: timeoutMs });
        await navigation;
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        break;
      }
      case "fill": {
        const resolved = await this.#resolveForExecution(command, expectedPolicy);
        actionRoot = resolved.root;
        urlBefore = actionRoot.url();
        resolution = resolved.resolution;
        await resolved.handle.fill(command.value, { timeout: timeoutMs });
        break;
      }
      case "select": {
        const resolved = await this.#resolveForExecution(command, expectedPolicy);
        actionRoot = resolved.root;
        urlBefore = actionRoot.url();
        resolution = resolved.resolution;
        await resolved.handle.selectOption(command.value, { timeout: timeoutMs });
        break;
      }
      case "read": {
        const resolved = await this.#resolveForExecution(command, expectedPolicy);
        actionRoot = resolved.root;
        urlBefore = actionRoot.url();
        resolution = resolved.resolution;
        const text = (await resolved.handle.innerText()).trim();
        value = command.parse === "currency" ? parseCurrency(text) : text;
        break;
      }
      case "wait": {
        this.#assertPolicyContext(expectedPolicy, this.#basicPolicyContext(page.url(), page.url()));
        const timeoutAt = Date.now() + timeoutMs;
        while (Date.now() < timeoutAt) {
          if ((await this.#evaluateCondition(command.until)).passed) break;
          await page.waitForTimeout(50);
        }
        if (!(await this.#evaluateCondition(command.until)).passed) {
          throw new Error(`Wait condition did not pass: ${command.until.kind}`);
        }
        break;
      }
    }

    return {
      receipt: {
        action: command.kind,
        ok: true,
        durationMs: elapsed(startedAt),
        urlBefore,
        urlAfter: actionRoot.url(),
        ...(resolution === undefined ? {} : { resolution }),
        ...(command.kind === "read" ? { binding: command.bind } : {}),
      },
      ...(value === undefined ? {} : { value }),
    };
  }

  async #resolveForExecution(
    command: Exclude<Command, { kind: "navigate" | "wait" }>,
    expectedPolicy: SurfacePolicyContext | undefined,
  ) {
    const resolved = await this.#resolveTarget(command.target);
    const handle = await resolved.locator.elementHandle();
    if (!handle) {
      throw new Error(`Resolved target detached before action: ${command.target.description}`);
    }
    const inspection = await handle.evaluate(inspectElement);
    this.#assertPolicyContext(
      expectedPolicy,
      this.#targetPolicyContext(command.kind, resolved.root.url(), inspection),
    );
    return { ...resolved, handle };
  }

  #basicPolicyContext(url: string, riskText: string): SurfacePolicyContext {
    return {
      url,
      riskText,
      fingerprint: sha256(Buffer.from(JSON.stringify({ url, riskText }))),
    };
  }

  #targetPolicyContext(
    command: Exclude<Command, { kind: "navigate" | "wait" }>["kind"],
    rootUrl: string,
    inspection: TargetInspection,
  ): SurfacePolicyContext {
    const url = command === "click" ? inspection.destination : rootUrl;
    const riskText = [inspection.tag, inspection.name, inspection.text, url].join(" ");
    return {
      url,
      riskText,
      fingerprint: sha256(Buffer.from(JSON.stringify({ command, rootUrl, inspection }))),
    };
  }

  #assertPolicyContext(
    expected: SurfacePolicyContext | undefined,
    actual: SurfacePolicyContext,
  ): void {
    if (expected && (expected.url !== actual.url || expected.fingerprint !== actual.fingerprint)) {
      throw new Error("Target changed after policy evaluation; action refused");
    }
  }

  async #evaluateCondition(condition: Condition): Promise<{
    passed: boolean;
    expected: string;
    observed: string;
  }> {
    switch (condition.kind) {
      case "url": {
        const observed = new URL(this.session.page.url()).pathname;
        const wildcard = condition.path.endsWith("*");
        const expectedPath = wildcard ? condition.path.slice(0, -1) : condition.path;
        return {
          passed: wildcard ? observed.startsWith(expectedPath) : observed === expectedPath,
          expected: condition.path,
          observed,
        };
      }
      case "visible":
      case "hidden": {
        try {
          const resolved = await this.#resolveTarget(condition.target);
          const visible = await resolved.locator.isVisible();
          const passed = condition.kind === "visible" ? visible : !visible;
          return {
            passed,
            expected: `${condition.kind}: ${condition.target.description}`,
            observed: visible ? "visible" : "hidden",
          };
        } catch (error) {
          const missing =
            error instanceof LocatorResolutionError &&
            error.attempts.every(({ matches }) => matches === 0);
          return {
            passed: condition.kind === "hidden" && missing,
            expected: `${condition.kind}: ${condition.target.description}`,
            observed: missing ? "not found" : error instanceof Error ? error.message : "unknown",
          };
        }
      }
      case "text": {
        const expected = condition.includes;
        if (condition.target) {
          try {
            const resolved = await this.#resolveTarget(condition.target);
            const text = (await resolved.locator.innerText()).trim();
            const passed = text.includes(expected);
            return { passed, expected, observed: passed ? "present" : "absent" };
          } catch (error) {
            return {
              passed: false,
              expected,
              observed: error instanceof Error ? error.message : "unknown",
            };
          }
        }
        const text = (
          await Promise.all(this.session.page.frames().map((frame) => this.#visibleText(frame)))
        )
          .filter(Boolean)
          .join("\n");
        const passed = text.includes(expected);
        return { passed, expected, observed: passed ? "present" : "absent" };
      }
    }
  }

  async #resolveTarget(
    target: Target,
  ): Promise<{ locator: Locator; resolution: LocatorResolution; root: LocatorRoot }> {
    const root = target.frame ? await this.#resolveFrame(target.frame) : this.session.page;
    const attempts: LocatorAttempt[] = [];

    for (const [strategyIndex, strategy] of target.strategies.entries()) {
      const locator = this.#locator(root, strategy);
      const matches = await locator.count();
      attempts.push({ strategyIndex, kind: strategy.kind, matches });
      if (matches === 1) {
        return {
          locator,
          resolution: { strategyIndex, kind: strategy.kind, attempts },
          root,
        };
      }
    }

    throw new LocatorResolutionError(target, attempts);
  }

  async #resolveFrame(bundle: LocatorBundle): Promise<Frame> {
    const attempts: LocatorAttempt[] = [];
    for (const [strategyIndex, strategy] of bundle.strategies.entries()) {
      const locator = this.#locator(this.session.page, strategy);
      const matches = await locator.count();
      attempts.push({ strategyIndex, kind: strategy.kind, matches });
      if (matches !== 1) continue;
      const handle = await locator.elementHandle();
      const frame = await handle?.contentFrame();
      if (frame) return frame;
    }
    throw new Error(`No unique frame resolved (${attempts.map((item) => item.matches).join(",")})`);
  }

  #locator(root: LocatorRoot, strategy: LocatorStrategy): Locator {
    switch (strategy.kind) {
      case "role":
        return root.getByRole(strategy.role as never, {
          name: strategy.name,
          exact: strategy.exact ?? true,
        });
      case "label":
        return root.getByLabel(strategy.text, { exact: strategy.exact ?? true });
      case "text":
        return root.getByText(strategy.text, { exact: strategy.exact ?? true });
      case "css":
        return root.locator(strategy.selector);
    }
  }

  async #visibleText(frame: Frame): Promise<string> {
    return frame
      .locator("body")
      .innerText()
      .catch(() => "");
  }

  async #controls(frame: Frame): Promise<ObservedControl[]> {
    return frame
      .locator(
        'a, button, input, select, textarea, iframe, h1, h2, th, td, [role="button"], [data-observe]',
      )
      .evaluateAll(
        (elements, frameUrl) =>
          elements.slice(0, 100).map((element) => {
            const html = element as HTMLElement;
            const input = element as HTMLInputElement;
            const cssSelector = (() => {
              const title = element.getAttribute("title");
              if (element.tagName.toLowerCase() === "iframe" && title) {
                const escaped = title.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
                return `iframe[title="${escaped}"]`;
              }
              const name = element.getAttribute("name");
              if (name) {
                const escaped = name.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
                return `${element.tagName.toLowerCase()}[name="${escaped}"]`;
              }

              const parts: string[] = [];
              let current: Element | null = element;
              while (current && current !== document.body && parts.length < 5) {
                const tag = current.tagName.toLowerCase();
                const stableClasses = Array.from(current.classList)
                  .filter(
                    (value) => /^[a-z][a-z0-9_-]*$/i.test(value) && !/[a-f0-9]{8,}/i.test(value),
                  )
                  .slice(0, 2);
                let part = `${tag}${stableClasses.map((value) => `.${value}`).join("")}`;
                const parent: Element | null = current.parentElement;
                if (parent) {
                  const peers = Array.from(parent.children).filter(
                    (child) => child.tagName === current?.tagName,
                  );
                  if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(current) + 1})`;
                }
                parts.unshift(part);
                if (stableClasses.length > 0) break;
                current = parent;
              }
              return parts.join(" > ");
            })();
            return {
              frameUrl,
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role") ?? "",
              text: (html.innerText || input.value || "").trim().slice(0, 300),
              selector: cssSelector,
              ...(element.getAttribute("aria-label")
                ? { name: element.getAttribute("aria-label") as string }
                : {}),
              ...(element.getAttribute("type")
                ? { type: element.getAttribute("type") as string }
                : {}),
              ...(element.getAttribute("href")
                ? { href: element.getAttribute("href") as string }
                : {}),
              ...(element.getAttribute("placeholder")
                ? { placeholder: element.getAttribute("placeholder") as string }
                : {}),
              ...(element.getAttribute("src")
                ? { src: element.getAttribute("src") as string }
                : {}),
              ...(element.getAttribute("title")
                ? { title: element.getAttribute("title") as string }
                : {}),
              ...(input.name ? { name: input.name } : {}),
            };
          }),
        frame.url(),
      )
      .catch(() => []);
  }

  async #captureFromPage(page: Page, reason: string): Promise<EvidenceRef> {
    this.#captureSequence += 1;
    const safeReason = reason
      .replace(/[^a-z0-9_-]+/gi, "-")
      .toLowerCase()
      .slice(0, 50);
    const relativePath = `screenshots/${String(this.#captureSequence).padStart(3, "0")}-${safeReason}.png`;
    const absolutePath = resolve(this.runDirectory, relativePath);
    await mkdir(resolve(this.runDirectory, "screenshots"), { recursive: true });
    await page.screenshot({ path: absolutePath, type: "png", fullPage: false });
    const bytes = await readFile(absolutePath);
    return { kind: "screenshot", path: relativePath, sha256: sha256(bytes) };
  }
}

export const describeTarget = (target: Target): string =>
  `${target.description} (${target.strategies.map(displayStrategy).join(" -> ")})`;
