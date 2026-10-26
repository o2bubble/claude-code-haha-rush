// ── super desktop「同名桌面重复 / 删了又回来」竞态复现 ──
//
// 用户报：超级桌面有时候出现多个 "Desktop 1"，删掉后又偶尔回来。
//
// ⚠️ 建模要点：**写是慢的、读是快的**。
//   · `db_save_desktop` / `db_delete_desktop` 是真 IPC → 服务端 / SQLite，要时间
//   · `db_get_desktops` 在写完成之前被调用，读到的是**旧状态**
// 早期版本用"立即 resolve 的 mock"建模，写瞬间"成功"、标记瞬间清空 ——
// 复现不出问题。那是**测试模型错了**，不是 bug 不存在。
//
// ⚠️ desktopStore 是模块级单例（desktops/_dirtyDesktops 等是顶层 let），
// 跨 test 会互相污染 —— 所有场景按序放进**单个 test**，用阶段注释区分。
import { describe, it, expect, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("../services/statusMsgStore", () => ({
  addStatusMessage: vi.fn(),
}));

import {
  loadDesktops, resetDesktopsLoad, createDesktop, deleteDesktop, getDesktops,
  forceSaveDesktop,
} from "./desktopStore";
import { windowBus } from "../services/windowBus";
import { Events } from "../services/events";

function rec(id: string, name: string) {
  const now = new Date().toISOString();
  return {
    id, name, pan_x: 0, pan_y: 0, zoom: 1, show_grid: true, grid_size: 20,
    snap_to_grid: false, created_at: now, updated_at: now, items: [], connections: [],
  };
}

/**
 * 让 loadDesktops 走一遍。
 *
 * ⚠️ 关键：`writeOk=false` 建模**写失败**（DB 锁 / server 不可用）。
 * 这是真实且**偶发**的路径 —— `flushDirtyDesktops` 的 catch 会把 id 重新标脏、
 * 但**不阻止本次 fetch 用旧数据覆盖内存**；`deleteDesktop` 的失败则完全被吞掉。
 * 用户说的"偶尔"正是这种间歇性写失败。
 */
async function load(
  getRecords: () => ReturnType<typeof rec>[],
  writeOk = true,
) {
  resetDesktopsLoad();
  windowBus.clearSticky(Events.BACKEND_PORT_READY);
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "db_get_desktops") return Promise.resolve(getRecords());
    if (cmd === "db_save_desktop" || cmd === "db_delete_desktop") {
      return writeOk ? Promise.resolve(cmd === "db_save_desktop" ? false : undefined)
                     : Promise.reject(new Error("database is locked"));
    }
    return Promise.resolve(undefined);
  });
  const p = loadDesktops();
  windowBus.emit(Events.BACKEND_PORT_READY, { port: 1 }, { sticky: true });
  await p;
}

describe("super desktop — 重复桌面竞态", () => {
  it("① 新建未落库时重载 → 新桌面被抹掉 → 再建一次 → 两条同名", async () => {
    // ── 阶段 0：空库 ──
    await load(() => []);
    expect(getDesktops()).toHaveLength(0);


    // ── 阶段 1：面板看到空列表 → 自动建 "Desktop 1"（生产代码名字写死）──
    createDesktop("Desktop 1");
    expect(getDesktops()).toHaveLength(1);

    // ── 阶段 2：防抖窗口内触发 refetch，且此时**保存失败**（DB 锁）──
    //     flush 的 catch 只重新标脏、不阻止接着用旧快照覆盖内存。
    await load(() => [], /* writeOk */ false);

    expect(getDesktops(), "重载不应丢掉内存中尚未落库的新建桌面").toHaveLength(1);

    // ── 阶段 3：再走一次面板的 finishLoad 逻辑（照 SuperDesktopPanel 的真实写法）──
    //     只有**列表为空**才建。若阶段 2 保住了新建桌面，这里就不该再建。
    if (getDesktops().length === 0) createDesktop("Desktop 1");

    // ── 阶段 4：两条同名 ──
    const names = getDesktops().map((d) => d.name);
    expect(
      names.filter((n) => n === "Desktop 1"),
      `不应出现同名桌面（当前 ${getDesktops().length} 条）`,
    ).toHaveLength(1);
  });

  it("② 删除未落库时重载 → 删掉的桌面回来", async () => {
    await load(() => [rec("d-x", "X"), rec("d-y", "Y")]);
    expect(getDesktops()).toHaveLength(2);

    // ── 删除（**DB 侧失败**：database is locked —— 偶发但真实）──
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "db_get_desktops") return Promise.resolve([rec("d-x", "X"), rec("d-y", "Y")]);
      if (cmd === "db_delete_desktop") return Promise.reject(new Error("database is locked"));
      return Promise.resolve(false);
    });
    deleteDesktop("d-x");
    await new Promise((r) => setTimeout(r, 0)); // 让 catch 跑完
    expect(getDesktops(), "删完内存应立刻少一条").toHaveLength(1);

    // 紧接着一次 refetch —— **读到的快照里 d-x 还在**。
    // 真实成因（三者任一）：
    //   · 走 server 时 `list_desktops` 是**另一条 RPC**，与 delete 不保证同一时刻可见
    //   · 跨实例 refetch 用了它自己的旧快照
    //   · 删除本身失败（DB 锁）而错误被吞
    // mock 里 delete 已 resolve（乐观成功），但读回来仍带 d-x —— 模拟这种不一致。
    await load(() => [rec("d-x", "X"), rec("d-y", "Y")]);

    expect(
      getDesktops().map((d) => d.id),
      "删除后重载不应把已删的桌面捞回来",
    ).not.toContain("d-x");
  });
});
