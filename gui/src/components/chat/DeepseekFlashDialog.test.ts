import { describe, it, expect } from "vitest";
import { isDeepseekProModel, buildFlashProfileEnv } from "./DeepseekFlashDialog";

// 「建议换 Flash」触发判定 —— 只在激活模型确属 DeepSeek Pro 系时为 true：
// 过宽会误伤其它 provider 带 pro 的模型名（弹不该弹的提示），
// 过窄会漏掉真实的 pro 用户（提示形同虚设）。
describe("isDeepseekProModel", () => {
  it("matches DeepSeek pro model names", () => {
    expect(isDeepseekProModel("deepseek-v4-pro")).toBe(true);
    expect(isDeepseekProModel("deepseek-pro")).toBe(true);
    expect(isDeepseekProModel("DeepSeek-V4-Pro")).toBe(true); // 大小写不敏感
    expect(isDeepseekProModel("  deepseek-v4-pro  ")).toBe(true); // 容忍首尾空白
  });

  it("rejects DeepSeek non-pro models", () => {
    expect(isDeepseekProModel("deepseek-flash")).toBe(false);
    expect(isDeepseekProModel("deepseek-v4-flash-0731")).toBe(false);
    expect(isDeepseekProModel("deepseek-v4-flash-vision-exp")).toBe(false);
  });

  it("rejects non-DeepSeek models that merely contain 'pro'", () => {
    expect(isDeepseekProModel("qwen-3.8-pro")).toBe(false);
    expect(isDeepseekProModel("gpt-4-pro")).toBe(false);
    expect(isDeepseekProModel("")).toBe(false);
  });
});

// 「仅替换模型键、其余不变」是本次需求的核心承诺（用户对旧 profile 的自定义
// —— token / 端点 / 上下文窗口等 —— 不能因为换模型而丢失）。
describe("buildFlashProfileEnv", () => {
  const proEnv: Record<string, string> = {
    ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
    ANTHROPIC_AUTH_TOKEN: "sk-xxx",
    ANTHROPIC_MODEL: "deepseek-v4-pro",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-pro",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro",
    ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: "effort,max_effort,thinking,reasoning",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
    MAX_TOKENS: "131072",
    API_TIMEOUT_MS: "120000",
  };

  it("replaces all four template model keys with flash", () => {
    const next = buildFlashProfileEnv(proEnv);
    for (const k of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
    ]) {
      expect(next[k]).toBe("deepseek-flash");
    }
  });

  it("keeps every non-model key untouched (token / endpoint / context / capabilities)", () => {
    const next = buildFlashProfileEnv(proEnv);
    for (const k of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
      "MAX_TOKENS",
      "API_TIMEOUT_MS",
      "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
    ]) {
      expect(next[k]).toBe(proEnv[k]);
    }
    // 不引入任何新键（除补齐的模板模型键）
    const added = Object.keys(next).filter((k) => !(k in proEnv));
    expect(added.sort()).toEqual([]);
  });

  it("adds missing template model keys and swaps present secondary keys", () => {
    const sparse: Record<string, string> = {
      ANTHROPIC_MODEL: "deepseek-v4-pro",
      ANTHROPIC_SMALL_FAST_MODEL: "deepseek-v4-pro",
    };
    const next = buildFlashProfileEnv(sparse);
    // 缺失的模板键补齐为 flash
    expect(next.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("deepseek-flash");
    expect(next.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-flash");
    expect(next.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("deepseek-flash");
    // 存在的次级键替换
    expect(next.ANTHROPIC_SMALL_FAST_MODEL).toBe("deepseek-flash");
  });

  it("does not add secondary keys that were absent", () => {
    const next = buildFlashProfileEnv(proEnv);
    expect("ANTHROPIC_SMALL_FAST_MODEL" in next).toBe(false);
    expect("ANTHROPIC_DEFAULT_MODEL" in next).toBe(false);
  });

  it("does not mutate the input", () => {
    const copy = { ...proEnv };
    buildFlashProfileEnv(proEnv);
    expect(proEnv).toEqual(copy);
  });
});
