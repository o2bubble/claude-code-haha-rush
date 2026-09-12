import { describe, it, expect } from "vitest";
import { parsePluginSettings } from "./pluginRegistry";
import { savePluginSettings, getPluginSettings } from "./pluginSettingsStore";

// 存储层测试用纯函数(parsePluginSettings 容错) + store 的 mock 缺失时代码路径
// (非 Tauri 环境 invoke 失败 → 返回空/不抛, 保 GUI 可用)

describe("parsePluginSettings — manifest settings 容错解析", () => {
  it("合法声明全类型解析", () => {
    const s = parsePluginSettings({
      demoMode: { type: "boolean", title: "演示模式", description: "开演示" },
      apiKey: { type: "string", title: "API Key" },
      port: { type: "number", title: "端口", default: 3000 },
      region: { type: "select", title: "区域", options: [{ value: "cn", label: "中国" }, { value: "us", label: "美国" }], default: "cn" },
    });
    expect(s.demoMode.type).toBe("boolean");
    expect(s.apiKey.type).toBe("string");
    expect(s.port.default).toBe(3000);
    expect(s.region.options?.length).toBe(2);
    expect(s.region.default).toBe("cn");
  });

  it("非对象/缺 type/缺 title/非法 type → 跳过", () => {
    const s = parsePluginSettings({
      bad1: "not-object",
      bad2: { type: "bool", title: "t" }, // 非法 type
      bad3: { type: "boolean" }, // 缺 title
      ok: { type: "boolean", title: "OK" },
    });
    expect(Object.keys(s)).toEqual(["ok"]);
  });

  it("options 里无效条目过滤", () => {
    const s = parsePluginSettings({
      sel: { type: "select", title: "S", options: [{ value: "a", label: "A" }, { value: 1 }, { label: "no-value" }] },
    });
    expect(s.sel.options?.length).toBe(1);
  });

  it("空/非法输入 → {}", () => {
    expect(parsePluginSettings(undefined)).toEqual({});
    expect(parsePluginSettings([])).toEqual({});
    expect(parsePluginSettings("x")).toEqual({});
  });
});

describe("残留键无害（2026-09-09 决策 A）", () => {
  it("插件删除某设置项 → 旧 plugins-settings 残留键不暴露(渲染只读声明键)", () => {
    // 模拟: manifest 只声明新的 key, 值文件里残留旧 key
    const decl = parsePluginSettings({ newKey: { type: "boolean", title: "New" } });
    expect(Object.keys(decl)).toEqual(["newKey"]);
    // 旧残留键在 values 里但不在声明里 → 渲染层迭代的是 decl, 不会读到残键
    const residualValues: Record<string, boolean> = { oldKey: true, newKey: false };
    expect(Object.keys(decl).filter((k) => residualValues[k] !== undefined)).toEqual(["newKey"]);
  });
});

describe("pluginSettingsStore — 非 Tauri 环境安全降级", () => {
  it("getPluginSettings 不抛(返回空)", async () => {
    const v = await getPluginSettings("nope");
    expect(v).toEqual({});
  });
  it("savePluginSettings 不抛(console.error 已兜底, 非 Tauri invoke 失败)", async () => {
    await expect(savePluginSettings("nope", { a: 1 })).resolves.toBeUndefined();
  });
});
