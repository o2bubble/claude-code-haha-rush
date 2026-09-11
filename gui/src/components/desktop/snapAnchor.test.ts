import { findSnapAnchor } from "./snapAnchor";
import type { DesktopItem } from "../../types/desktop";

console.log("=== findSnapAnchor tests ===\n");

function makeItem(id: string, x: number, y: number, w = 200, h = 150): DesktopItem {
  return {
    id, x, y, width: w, height: h, type: "text", label: id, color: "#eee",
    zIndex: 1, collapsed: false, desktopId: "test-desktop",
    content: { type: "text", format: "plain", text: "" },
    createdAt: Date.now(), updatedAt: Date.now(),
  } as DesktopItem;
}

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

// 两 item 相邻：A(100,100)，B(400,100)
const items = [makeItem("A", 100, 100), makeItem("B", 400, 100)];
// B.left 锚点 canvas 坐标 = (400, 175)

console.log("--- 鼠标精确在目标锚点上 → 必然命中 ---\n");
assert(
  "B.left 锚点上松手命中 B:left",
  findSnapAnchor(items, "A", 400, 175, 1)?.itemId === "B" &&
  findSnapAnchor(items, "A", 400, 175, 1)?.side === "left"
);

console.log("\n--- 命中圈放宽(32px/zoom)，轻微偏离也能吸住 ---\n");
assert(
  "B.left 锚点右偏 30px 仍命中",
  findSnapAnchor(items, "A", 430, 175, 1)?.itemId === "B"
);
assert(
  "B.left 锚点下偏 25px 仍命中",
  findSnapAnchor(items, "A", 400, 200, 1)?.itemId === "B"
);

console.log("\n--- 远离所有锚点 → 不命中 ---\n");
assert(
  "空旷处松手返回 null",
  findSnapAnchor(items, "A", 900, 500, 1) === null
);

console.log("\n--- 正确跳过起始 item ---\n");
assert(
  "在 A.right 上松手但 A 是起点 → A 不被命中(往 B 找)",
  findSnapAnchor(items, "A", 300, 175, 1)?.itemId !== "A"
);

console.log("\n--- zoom 缩放：屏幕 32px ≤ canvas 命中圈 ---\n");
const zoomed = findSnapAnchor(items, "A", 400 + 30 / 2, 175, 2);
assert("zoom=2 时 15 canvas px(≈30px 屏幕) 命中 B", zoomed?.itemId === "B");

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
