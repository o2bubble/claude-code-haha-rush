// ── desktopStore 持久化脏集测试 ──
// Bug（create_item 假成功）：scheduleSave/forceSaveDesktop 只保存
// getActiveDesktop()——MCP 指定非激活 desktopId 创建条目时，内存有、盘上无，
// API 仍返回成功。修复后按**脏桌面集**逐个保存；bridge 侧 await 使
// "API success = 已落盘"。
//
// ⚠️ desktopStore 是模块级单例（desktops/_dirtyDesktops/activeDesktopId 均为
// 顶层 let），跨 test 会互相污染——所有场景按序放进**单个 test**，用计数器
// 区分阶段，不做 beforeEach 隔离。
import { describe, it, expect, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("../services/statusMsgStore", () => ({
  addStatusMessage: vi.fn(),
}));

import {
  loadDesktops, resetDesktopsLoad, createDesktop, setActiveDesktop,
  addItem, removeItem, forceSaveDesktop,
} from "./desktopStore";
import { windowBus } from "../services/windowBus";
import { Events } from "../services/events";

const saves = () => invokeMock.mock.calls.filter((c: unknown[]) => c[0] === "db_save_desktop");

async function seedDesktops() {
  resetDesktopsLoad();
  windowBus.clearSticky(Events.BACKEND_PORT_READY);
  invokeMock.mockResolvedValue([
    { id: "d-a", name: "A", pan_x: 0, pan_y: 0, zoom: 1, show_grid: true, grid_size: 20, snap_to_grid: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), items: [], connections: [] },
    { id: "d-b", name: "B", pan_x: 0, pan_y: 0, zoom: 1, show_grid: true, grid_size: 20, snap_to_grid: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), items: [], connections: [] },
  ]);
  // 真实时序：面板 mount 先订阅(loadDesktops)，后端起来后才 emit port ready。
  // 先 emit 后订阅 replay 路径在测试环境不稳定 → 按生产顺序写。
  const p = loadDesktops();
  windowBus.emit(Events.BACKEND_PORT_READY, { port: 1 }, { sticky: true });
  await p;
  invokeMock.mockClear();  // 清掉 seed 的 db_get_desktops 记录，后续阶段只看 db_save_desktop
}

describe("desktopStore dirty-set persistence", () => {
  it("saves exactly the mutated desktops (create_item 假成功回归)", async () => {
    await seedDesktops();

    // ── 阶段 0：setActiveDesktop 的 notify 已把 d-a 标脏 → 保存 d-a 快照（合法：任何变更最终落盘）──
    setActiveDesktop("d-a");
    await forceSaveDesktop();
    expect(saves()).toHaveLength(1);
    expect((saves()[0]![1] as { desktop: { id: string } }).desktop.id).toBe("d-a");
    invokeMock.mockClear();

    // ── 阶段 1：变更非激活桌面 d-b → 保存的是 d-b（含新条目），不是激活的 d-a ──
    const item = addItem("d-b", { x: 0, y: 0, width: 10, height: 10, label: "t", content: { type: "text", format: "plain", text: "hi" } });
    await forceSaveDesktop();
    expect(saves()).toHaveLength(1);
    const saved1 = (saves()[0]![1] as { desktop: { id: string; items: { id: string }[] } }).desktop;
    expect(saved1.id).toBe("d-b");
    expect(saved1.items.map((i: { id: string }) => i.id)).toContain(item.id);
    invokeMock.mockClear();

    // ── 阶段 2：激活桌面自身变更 → 照常保存 ──
    setActiveDesktop("d-b");
    addItem("d-b", { x: 1, y: 1, width: 10, height: 10, label: "t2", content: { type: "text", format: "plain", text: "x" } });
    await forceSaveDesktop();
    expect(saves()).toHaveLength(1);
    expect((saves()[0]![1] as { desktop: { id: string } }).desktop.id).toBe("d-b");
    invokeMock.mockClear();

    // ── 阶段 3：写失败 → 重新标脏，下次 force 重试落盘 ──
    addItem("d-a", { x: 2, y: 2, width: 10, height: 10, label: "t3", content: { type: "text", format: "plain", text: "y" } });
    invokeMock.mockRejectedValueOnce(new Error("db busy"));
    await forceSaveDesktop();                       // first write fails
    expect(saves()).toHaveLength(1);
    invokeMock.mockClear();
    await forceSaveDesktop();                       // retry hits disk
    expect(saves()).toHaveLength(1);
    expect((saves()[0]![1] as { desktop: { id: string } }).desktop.id).toBe("d-a");
    invokeMock.mockClear();

    // ── 阶段 4：删除**非激活**桌面的项 → 标脏到真实 owner（假成功回归）──
    // 激活是 d-b，t4 建在非激活 d-a。修复前 removeItem 删掉后 ownerDesktopIdOfItem
    // 必返回 undefined → scheduleSave 退化标激活 d-b 脏、d-a 永不落盘（删非激活项=假成功）。
    const t4 = addItem("d-a", { x: 3, y: 3, width: 10, height: 10, label: "t4", content: { type: "text", format: "plain", text: "z" } });
    await forceSaveDesktop();
    invokeMock.mockClear();                          // flush d-a 上的 t4（落盘 d-a）
    removeItem(t4.id);
    await forceSaveDesktop();
    expect(saves()).toHaveLength(1);
    expect((saves()[0]![1] as { desktop: { id: string } }).desktop.id).toBe("d-a");
  });
});
