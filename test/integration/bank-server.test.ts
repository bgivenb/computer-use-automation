import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DemoServer, startDemoServer } from "../../src/demo/server.js";

let demo: DemoServer;

beforeAll(async () => {
  demo = await startDemoServer({ port: 0 });
});

afterAll(async () => {
  await demo.close();
});

describe("legacy bank demo", () => {
  it("serves a nested shell with an iframe and generated IDs", async () => {
    const first = await fetch(`${demo.origin}/`);
    const second = await fetch(`${demo.origin}/`);
    const [firstHtml, secondHtml] = await Promise.all([first.text(), second.text()]);

    expect(first.status).toBe(200);
    expect(firstHtml).toContain("Legacy Bank Servicing");
    expect(firstHtml).toContain('<iframe id="workspace_');
    expect(firstHtml).toContain('src="/search"');
    expect(firstHtml.match(/<table/g)?.length).toBeGreaterThanOrEqual(3);
    expect(extractGeneratedId(firstHtml, "workspace")).not.toBe(
      extractGeneratedId(secondHtml, "workspace"),
    );
  });

  it("completes the happy path through the review checkpoint", async () => {
    const search = await fetch(`${demo.origin}/members/search?memberId=12345`);
    const searchHtml = await search.text();
    expect(searchHtml).toContain("Avery Morgan");
    expect(searchHtml).toContain("Open member record");

    const detail = await fetch(`${demo.origin}/members/12345`);
    const detailHtml = await detail.text();
    expect(detail.status).toBe(200);
    expect(detailHtml).toContain("$12,450.67");
    expect(detailHtml).toContain("Open savings sub-account");

    const form = await fetch(`${demo.origin}/members/12345/subaccounts/new`);
    expect(await form.text()).toContain('name="accountNickname"');

    const review = await fetch(`${demo.origin}/members/12345/subaccounts/review`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ accountNickname: "Rainy Day" }),
    });
    const reviewHtml = await review.text();
    expect(review.status).toBe(200);
    expect(reviewHtml).toContain("Review New Savings Sub-account");
    expect(reviewHtml).toContain("Rainy Day");
    expect(reviewHtml).toContain("Ready for final approval");
    expect(reviewHtml).toContain("Create account");
  });

  it("returns member not found as a normal search outcome", async () => {
    const response = await fetch(`${demo.origin}/members/search?memberId=00000`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Member not found");
  });

  it("fails member 77777 once per session and then recovers", async () => {
    const cookie = await createSession();
    const first = await fetch(`${demo.origin}/members/77777`, {
      headers: { Cookie: cookie },
    });
    const second = await fetch(`${demo.origin}/members/77777`, {
      headers: { Cookie: cookie },
    });

    expect(first.status).toBe(503);
    expect(await first.text()).toContain("Temporary system error");
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("Jordan Lee");

    const otherSession = await createSession();
    const otherFirst = await fetch(`${demo.origin}/members/77777`, {
      headers: { Cookie: otherSession },
    });
    expect(otherFirst.status).toBe(503);
  });

  it("returns a non-retryable permission failure for member 88888", async () => {
    const response = await fetch(`${demo.origin}/members/88888`);
    const html = await response.text();

    expect(response.status).toBe(403);
    expect(html).toContain("Permission denied");
    expect(html).toContain("Do not retry");
  });

  it("requires member 99999's interstitial to be dismissed in-session", async () => {
    const cookie = await createSession();
    const first = await fetch(`${demo.origin}/members/99999`, {
      headers: { Cookie: cookie },
    });
    expect(await first.text()).toContain("Unexpected confirmation required");

    const dismissal = await fetch(`${demo.origin}/members/99999/dismiss-interstitial`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "",
      redirect: "manual",
    });
    expect(dismissal.status).toBe(303);
    expect(dismissal.headers.get("location")).toBe("/members/99999");

    const resumed = await fetch(`${demo.origin}/members/99999`, {
      headers: { Cookie: cookie },
    });
    const resumedHtml = await resumed.text();
    expect(resumed.status).toBe(200);
    expect(resumedHtml).toContain("Morgan Reyes");
    expect(resumedHtml).not.toContain("Unexpected confirmation required");
  });

  it("escapes submitted nicknames on the review page", async () => {
    const response = await fetch(`${demo.origin}/members/12345/subaccounts/review`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        accountNickname: '<script>alert("nope")</script>',
      }),
    });
    const html = await response.text();

    expect(html).not.toContain('<script>alert("nope")</script>');
    expect(html).toContain("&lt;script&gt;alert(&quot;nope&quot;)&lt;/script&gt;");
  });
});

async function createSession(): Promise<string> {
  const response = await fetch(`${demo.origin}/`);
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Demo server did not issue a session cookie");
  return setCookie.split(";", 1)[0] ?? "";
}

function extractGeneratedId(html: string, prefix: string): string {
  const match = new RegExp(`id="(${prefix}_[a-f0-9]+)"`).exec(html);
  if (!match?.[1]) throw new Error(`Missing generated ${prefix} ID`);
  return match[1];
}
