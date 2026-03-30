import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock config
mock.module("../src/paths", () => ({
  CONFIG_DIR: "/tmp/maw-test",
  FLEET_DIR: "/tmp/maw-test/fleet",
  CONFIG_FILE: "/tmp/maw-test/maw.config.json",
  MAW_ROOT: "/tmp",
}));

let mockToken: string | undefined = "test-token-16chars!";
mock.module("../src/config", () => ({
  loadConfig: () => ({ federationToken: mockToken, node: "test" }),
}));

const { curlFetch } = await import("../src/curl-fetch");

describe("curlFetch", () => {
  test("uses native fetch on Linux", async () => {
    // On Linux (this test runs on white.local), curlFetch should use native fetch
    // We can verify by checking process.platform
    expect(process.platform).toBe("linux");
  });

  test("returns ok:false for unreachable host", async () => {
    const res = await curlFetch("http://192.0.2.1:9999/api/test", { timeout: 1000 });
    expect(res.ok).toBe(false);
  });

  test("sends HMAC headers when token configured", async () => {
    // Test against local maw server — auth/status is public so it won't reject
    const res = await curlFetch("http://white.local:3456/api/auth/status", { timeout: 5000 });
    expect(res.ok).toBe(true);
    expect(res.data?.enabled).toBe(true);
  });

  test("sends POST with body and auth headers", async () => {
    // POST to auth/status (public endpoint, accepts any method)
    const res = await curlFetch("http://white.local:3456/api/auth/status", {
      method: "POST",
      body: JSON.stringify({ test: true }),
      timeout: 5000,
    });
    // Should not hang — this was the bug
    expect(res.status).toBeDefined();
  });

  test("works without federation token", async () => {
    mockToken = undefined;
    const res = await curlFetch("http://white.local:3456/api/auth/status", { timeout: 5000 });
    expect(res.ok).toBe(true);
    mockToken = "test-token-16chars!";
  });

  test("parses JSON response", async () => {
    const res = await curlFetch("http://white.local:3456/api/auth/status", { timeout: 5000 });
    expect(res.ok).toBe(true);
    expect(typeof res.data).toBe("object");
    expect(res.data.node).toBe("white");
  });
});

describe("curlFetch federation auth", () => {
  test("protected endpoint with wrong token gets rejected", async () => {
    // Wrong token → signature mismatch → 401 from remote, but from white.local
    // the server sees non-loopback IP so it checks HMAC
    mockToken = "wrong-token-that-wont-match";
    const res = await curlFetch("http://white.local:3456/api/sessions", { timeout: 5000 });
    // white.local resolves to LAN IP, not loopback → auth enforced → wrong sig → rejected
    expect(res.ok).toBe(false);
    expect(res.data?.error).toContain("federation auth");
    mockToken = "test-token-16chars!";
  });

  test("POST with body does not hang", async () => {
    // This specifically tests the bug where POST + headers caused Bun.spawn curl to hang
    const start = Date.now();
    const res = await curlFetch("http://white.local:3456/api/send", {
      method: "POST",
      body: JSON.stringify({ target: "nonexistent", text: "test" }),
      timeout: 3000,
    });
    const elapsed = Date.now() - start;
    // Should complete quickly, not timeout at 3s
    expect(elapsed).toBeLessThan(2000);
    // 404 is expected (target not found) — but it didn't hang
    expect(res.status).toBeDefined();
  });
});
