import { describe, expect, it } from "vitest";
import { classifyBackendStatus, classifyBackendPort, classifyWsConnected } from "./diagnosticsBackend";

describe("diagnosticsBackend", () => {
  it("running with port passes", () => {
    const c = classifyBackendStatus("running", 12345);
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("12345");
  });

  it("running without port warns", () => {
    expect(classifyBackendStatus("running", null).status).toBe("warn");
  });

  it("starting warns", () => {
    expect(classifyBackendStatus("starting", null).status).toBe("warn");
  });

  it("stopped warns", () => {
    expect(classifyBackendStatus("stopped", null).status).toBe("warn");
  });

  it("error fails with message", () => {
    const c = classifyBackendStatus("error", null, "boom");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("boom");
  });

  it("error falls back to generic message", () => {
    expect(classifyBackendStatus("error", null).detail).toContain("后端启动失败");
  });

  it("ws connected passes", () => {
    expect(classifyWsConnected(true).status).toBe("pass");
  });

  it("ws disconnected warns", () => {
    expect(classifyWsConnected(false).status).toBe("warn");
  });

  it("port present passes", () => {
    expect(classifyBackendPort(12345, "running").status).toBe("pass");
  });

  it("port absent on backend error fails", () => {
    expect(classifyBackendPort(null, "error").status).toBe("fail");
  });

  it("port absent otherwise warns", () => {
    expect(classifyBackendPort(null, "stopped").status).toBe("warn");
    expect(classifyBackendPort(null, "starting").status).toBe("warn");
  });
});
