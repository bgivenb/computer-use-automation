import { describe, expect, it } from "vitest";
import { networkUrlAllowed } from "../../src/runtime/session.js";

describe("session network boundary", () => {
  const origins = new Set(["https://trusted.test", "http://127.0.0.1:4173"]);
  const routes = ["/", "/members/:memberId", "/stream/*"];

  it("applies the same origin and route ceiling to HTTP and WebSocket URLs", () => {
    expect(networkUrlAllowed("https://trusted.test/members/12345", origins, routes)).toBe(true);
    expect(networkUrlAllowed("wss://trusted.test/stream/updates", origins, routes)).toBe(true);
    expect(networkUrlAllowed("ws://127.0.0.1:4173/stream/updates", origins, routes)).toBe(true);
    expect(networkUrlAllowed("wss://other.test/stream/updates", origins, routes)).toBe(false);
    expect(networkUrlAllowed("https://trusted.test/admin", origins, routes)).toBe(false);
  });
});
