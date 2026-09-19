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
  addItem, removeItem, forceSaveDesktop, reloadDesktops, getActiveDesktopId,
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

    // 先清掉 seed 阶段留下的脏：`fetchDesktops` 收尾的 notify 会标脏激活桌面，
    // 不清掉就分不出下面这次写盘到底是谁触发的。
    await forceSaveDesktop();
    invokeMock.mockClear();

    // ── 阶段 0：setActiveDesktop **不落盘** ──
    // 选中态是本地交互态：`desktopToRecord` 没有这个字段，DB 里也没这一列 ——
    // 写盘存不下任何东西，却会产生一次 db_changed 广播，害得别的 GUI 实例
    // 无谓 refetch（多开时表现为"我这儿切个标签，那边跟着抖"）。
    setActiveDesktop("d-a");
    await forceSaveDesktop();
    expect(saves()).toHaveLength(0);
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

// ── 激活桌面在 refetch 中保持 ──
//
// Bug（多桌面切换回弹）：`fetchDesktops` 无条件 `activeDesktopId = desktops[0].id`，
// 于是任何一次 refetch 都会把用户选的桌面打回第一张。触发路径很常见 ——
// 跨 GUI 同步（`server:data-changed{desktop}` → reloadDesktops）：**另一个实例**
// 只要动了桌面数据，本窗口的选中就会跳回去，表现为"点了桌面 2 又自己回到桌面 1"。
//
// 同一函数里作者已经为 pan/zoom 等视图态做了保留（注释明说"无条件用服务端 view
// 重建会让用户刚做的缩放/平移闪回"），**只是漏了选中态**——它同样是本地交互态。
describe("activeDesktopId survives refetch", () => {
  it("refetch 保留用户的选中；仅当该桌面已消失才回退第一张", async () => {
    await seedDesktops();
    invokeMock.mockClear();

    // 用户点第二张
    setActiveDesktop("d-b");
    expect(getActiveDesktopId()).toBe("d-b");

    // 一次跨实例同步引发的 refetch —— 修复前这里会变回 "d-a"
    await reloadDesktops();
    expect(getActiveDesktopId()).toBe("d-b");

    // 连续多次（多实例频繁改动时会连发）
    await reloadDesktops();
    expect(getActiveDesktopId()).toBe("d-b");

    // 边界：选中的那张真的没了 → 才回退到第一张（兜底不能丢）
    setActiveDesktop("d-b");
    invokeMock.mockResolvedValue([
      { id: "d-a", name: "A", pan_x: 0, pan_y: 0, zoom: 1, show_grid: true, grid_size: 20, snap_to_grid: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), items: [], connections: [] },
    ]);
    await reloadDesktops();
    expect(getActiveDesktopId()).toBe("d-a");
  });
});
