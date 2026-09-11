// gui vitest 配置 — 覆盖 gui/src 前端测试 + scripts/ 构建规划纯函数测试。
// `bun run test`（vitest run）统一跑两类；也可传路径过滤单个文件。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "../scripts/**/*.{test,spec}.?(c|m)[jt]s?(x)",
    ],
    // 预存问题：console 断言风格文件（无 vitest describe/it，用 bun run <file> 独立跑），
    // vitest 加载会报 "No test suite found"。排除以免全量测试误红。
    exclude: [
      "src/utils/pathDetector.test.ts",
      "src/utils/themeUtils.test.ts",
      "src/components/desktop/snapAnchor.test.ts",
    ],
  },
});
