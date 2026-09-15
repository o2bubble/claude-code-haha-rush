import { describe, it, expect } from "vitest";
import {
  CLOUD_SERVER_URL,
  INTRANET_SERVER_URL,
  customServerUrlForDisplay,
  deriveServerProfile,
  serverProfileUrls,
} from "./serverProfile";

describe("serverProfileUrls — 档位映射", () => {
  it("intranet → 两字段都是内网地址", () => {
    expect(serverProfileUrls("intranet")).toEqual({
      skillRegistryUrl: INTRANET_SERVER_URL,
      updateServerUrl: INTRANET_SERVER_URL,
    });
  });
  it("public → 两字段都是云域名", () => {
    expect(serverProfileUrls("public")).toEqual({
      skillRegistryUrl: CLOUD_SERVER_URL,
      updateServerUrl: CLOUD_SERVER_URL,
    });
  });
  it("custom → 两字段都是传入值（防再次漂移）", () => {
    expect(serverProfileUrls("custom", "https://my.host")).toEqual({
      skillRegistryUrl: "https://my.host",
      updateServerUrl: "https://my.host",
    });
  });
  it("custom 缺参 → 空串而非 undefined", () => {
    expect(serverProfileUrls("custom")).toEqual({ skillRegistryUrl: "", updateServerUrl: "" });
  });
  it("custom 去掉首尾空格", () => {
    expect(serverProfileUrls("custom", "  https://my.host  ")).toEqual({
      skillRegistryUrl: "https://my.host",
      updateServerUrl: "https://my.host",
    });
  });
});

describe("deriveServerProfile — 反推档位", () => {
  it("两字段都是内网 → intranet", () => {
    expect(deriveServerProfile(INTRANET_SERVER_URL, INTRANET_SERVER_URL)).toBe("intranet");
  });
  it("两字段都是云 → public", () => {
    expect(deriveServerProfile(CLOUD_SERVER_URL, CLOUD_SERVER_URL)).toBe("public");
  });
  it("只有一个匹配预设 → custom（不猜）", () => {
    expect(deriveServerProfile(INTRANET_SERVER_URL, CLOUD_SERVER_URL)).toBe("custom");
    expect(deriveServerProfile(CLOUD_SERVER_URL, INTRANET_SERVER_URL)).toBe("custom");
  });
  it("历史漂移（旧面板只写 skillRegistryUrl）→ custom", () => {
    expect(deriveServerProfile(INTRANET_SERVER_URL, undefined)).toBe("custom");
  });
  it("两者皆空 → custom", () => {
    expect(deriveServerProfile(undefined, undefined)).toBe("custom");
    expect(deriveServerProfile("", "")).toBe("custom");
  });
  it("自定义地址 → custom", () => {
    expect(deriveServerProfile("https://my.host", "https://my.host")).toBe("custom");
  });
  it("首尾空格不影响判定", () => {
    expect(deriveServerProfile(` ${INTRANET_SERVER_URL} `, INTRANET_SERVER_URL)).toBe("intranet");
  });
});

describe("customServerUrlForDisplay — 输入框显示值", () => {
  it("优先 skillRegistryUrl", () => {
    expect(customServerUrlForDisplay(INTRANET_SERVER_URL, CLOUD_SERVER_URL)).toBe(INTRANET_SERVER_URL);
  });
  it("skillRegistryUrl 为空 → 退回 updateServerUrl", () => {
    expect(customServerUrlForDisplay(undefined, CLOUD_SERVER_URL)).toBe(CLOUD_SERVER_URL);
    expect(customServerUrlForDisplay("", CLOUD_SERVER_URL)).toBe(CLOUD_SERVER_URL);
  });
  it("两者皆空 → 空串", () => {
    expect(customServerUrlForDisplay(undefined, undefined)).toBe("");
  });
});
