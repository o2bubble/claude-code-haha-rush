#!/usr/bin/env node
// ── 鼠标键盘插件 · 后台进程 ──
//
// 职责：把 AI 的工具调用翻译成真实的鼠标/键盘输入。这是**能改变系统状态**的能力
// （与只读的截屏插件根本不同）—— AI 能点任何按钮、在任何窗口打字。
//
// ## 三条硬约束（违反会静默出问题）
//
// 1. `PLUGIN_PORT=` 必须是 **stdout 的第一行、也是最后一行**。
//    宿主读到端口后**停止读 stdout**（plugin_process.rs），之后任何 stdout 写入
//    都会 EPIPE；而"宿主没读出端口"会让进程永远停在 starting。
//    → 日志一律走 stderr。
// 2. spawn 任何系统命令都要 `windowsHide: true`（宿主的 CREATE_NO_WINDOW 只作用于
//    直接子进程，不传给孙子进程）—— Windows 上否则闪黑框。
// 3. **任何会按下按键/按钮的操作，都必须能被"释放"** —— 进程被急停、被 kill、
//    面板点"释放"时都要把按下的东西抬起来。否则鼠标停在"按下"状态，用户下一次
//    物理点击会变成拖拽/多选（比"停不下来"更常见的实际危害）。
//
// ## 安全模型（本插件的核心，不是附加项）
//
// ① **防 AI 操作宿主自己的窗口**：权限确认框就是普通窗口按钮 —— AI 一边调用工具
//    触发确认框、一边点「允许」，就能用它的权限框给自己授权、绕过"人在环中"。
//    → 每次操作前检查前台窗口是否属于宿主进程，是则拒绝。
// ② **急停**：进程内轮询按键组合（不是注册全局热键 —— 那是 OS 进程级独占的，
//    多开时只有先注册的实例能用，而急停必须任何情况都能用）。轮询不抢键、
//    每个实例各自有效、无需焦点。
// ③ **急停后不自动恢复**：后续调用统一返回"已急停"，由用户在面板显式解除。

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

// ── 原生库加载（vendor 内自带预编译件，无需 npm install）──────────────
//
// robotjs（MIT）负责输入注入，koffi（MIT）负责调 Win32 API（急停轮询 / 前台窗口
// 检查 / DPI）。两者都是 N-API 预编译，与 Node 版本无关；直接 require `.node`
// 文件即可，**绕开各自主包与其依赖**（robotjs 的 node-gyp-build、koffi 的平台包
// 解析）—— 这样插件 zip 里只需放两个二进制，用户装上就能用。
// 版权声明见 vendor/*-LICENSE。

const PLATFORM_DIR = `${process.platform}-${process.arch}`;
const VENDOR = path.join(__dirname, "vendor", PLATFORM_DIR);

function loadNative(file, label) {
  const p = path.join(VENDOR, file);
  if (!fs.existsSync(p)) {
    throw new Error(
      `缺少原生库 ${label}：${p}\n` +
      `本插件当前只附带 win32-x64（Windows 64 位）的预编译件；` +
      `当前平台是 ${PLATFORM_DIR}。`
    );
  }
  return require(p);
}

let robot, koffi;
try {
  robot = loadNative("robotjs.node", "robotjs");
  koffi = loadNative("koffi.node", "koffi");
} catch (e) {
  // 端口协议要求：即使加载失败也必须打印 PLUGIN_PORT，否则宿主永远停在 starting、
  // 用户看不到任何原因。把真实原因写进 stderr（宿主会把它带进进程状态里）。
  console.error("[mouse-keyboard] 原生库加载失败:", e && e.message || e);
  console.log(`PLUGIN_PORT=0`);
  process.exit(1);
}

const IS_WIN = process.platform === "win32";

// ── 插件设置（宿主随每次命令下发；面板也可 PUT 过来）──────
//
// ⚠️ 宿主侧 `getCachedPluginSettings` 可能是 `{}`（用户没打开过本插件的设置页
// 时），所以这里的缺省值必须能独立工作。
let settings = {
  smoothMoveMs: 400,
  typeDelayMs: 4,
  blockHostWindows: true,
};

function mergeSettings(s) {
  if (s && typeof s === "object") settings = { ...settings, ...s };
}

function log(...a) {
  console.error("[mouse-keyboard]", ...a);
}

// ── Win32（koffi）──────────────────────────────────────────────────
//
// DPI 感知必须在**任何坐标计算之前**设置：非 DPI-aware 进程拿到的坐标会被系统
// 按缩放比虚拟化（125% 缩放下点 1000 会落到 1250 的位置）。
// PER_MONITOR_AWARE_V2 = -4。
/**
 * Win32 绑定。**逐项独立初始化** —— 一个 API 失败不该拖垮其它（安全层是核心能力，
 * 曾因一个笔误导致整个 w32 为 null、前台检查/急停/滚轮全部静默降级）。
 */
let w32 = null;
if (IS_WIN) {
  w32 = {};
  const bind = (name, fn) => {
    try { w32[name] = fn(); }
    catch (e) { log(`Win32 API "${name}" 绑定失败：${e && e.message || e}`); }
  };

  const user32 = koffi.load("user32.dll");

  // DPI 感知：必须在任何坐标计算之前设置，否则非 100% 缩放下点偏。
  // PER_MONITOR_AWARE_V2 = -4。失败可忽略（系统可能已设）。
  try { user32.func("bool SetProcessDpiAwarenessContext(intptr_t value)")(-4); }
  catch (e) { log("DPI 感知设置失败（高缩放下坐标可能偏移）:", e && e.message || e); }

  bind("getForegroundWindow", () => user32.func("void* GetForegroundWindow()"));
  bind("getWindowThreadProcessId", () => user32.func("uint32 GetWindowThreadProcessId(void* hWnd, _Out_ uint32* lpdwProcessId)"));
  bind("getAsyncKeyState", () => user32.func("uint16 GetAsyncKeyState(int vKey)"));

  // 指示窗定位：FindWindowW 按**标题**精确查找（宿主把 title 设成 `indicator::<插件名>`）
  // + GetWindowRect 拿屏幕矩形。这样"别操作指示窗所在区域"的判断与用户拖动窗口都能
  // 自动跟上 —— 不必让页面跨源向父窗要坐标（iframe 里读不到顶层窗口的屏幕位置）。
  bind("findWindow", () => user32.func("void* FindWindowW(str16 cls, str16 name)"));
  bind("getWindowRect", () => {
    const RECT = koffi.struct("RECT", {
      left: "int32", top: "int32", right: "int32", bottom: "int32",
    });
    const fn = user32.func("bool GetWindowRect(void* hWnd, _Out_ RECT* rect)");
    return (hwnd) => {
      const r = {};
      if (!fn(hwnd, r)) return null;
      return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
    };
  });

  // ── 输入锁定用的低级钩子（见"输入锁定"一节）──
  //
  // WH_KEYBOARD_LL / WH_MOUSE_LL 是**唯一不需要注入 DLL、也不需要管理员权限**的钩子
  // （回调在安装它的进程里执行，系统只是把事件转过来）。实测在普通权限下能装上并
  // 收到事件、能区分物理/注入（LLKHF_INJECTED）。
  bind("setWindowsHookEx", () => user32.func("void* SetWindowsHookExW(int idHook, void* lpfn, void* hMod, uint32 dwThreadId)"));
  bind("unhookWindowsHookEx", () => user32.func("bool UnhookWindowsHookEx(void* hhk)"));
  bind("callNextHookEx", () => user32.func("intptr_t CallNextHookEx(void* hhk, int nCode, uintptr_t wParam, intptr_t lParam)"));
  bind("peekMessage", () => {
    const MSG = koffi.struct("MSG", {
      hwnd: "void*", message: "uint32", wParam: "uintptr_t", lParam: "intptr_t",
      time: "uint32", ptX: "int32", ptY: "int32",
    });
    const fn = user32.func("bool PeekMessageW(_Out_ MSG* msg, void* hWnd, uint32 min, uint32 max, uint32 remove)");
    const buf = {};
    return () => fn(buf, null, 0, 0, 1 /* PM_REMOVE */);
  });
  bind("getModuleHandle", () => koffi.load("kernel32.dll").func("void* GetModuleHandleW(str16 name)"));

  // ── 自己实现滚轮（robotjs 的 scrollMouse 在本机实测**窗口收不到消息**）──
  //
  // 实测数据：`robot.scrollMouse(0, -1)` 连发多次，目标窗口的 <MouseWheel> 事件数
  // 保持 0、内容不滚动；而这段 SendInput 一次就生效。
  // 另外 robotjs 把 mouseData 直接设成 ±1，而 **Windows 标准一格是
  // WHEEL_DELTA = 120** —— 传 ±1 多数应用会当"滚动量太小"忽略。
  // 自己发还附带两个好处：用标准 120、且拿得到 SendInput 返回值（被 UIPI 拦截时
  // 返回 0，robotjs 是直接丢弃返回值的）。
  bind("sendWheel", () => {
    const MOUSEINPUT = koffi.struct("MOUSEINPUT", {
      dx: "int32", dy: "int32", mouseData: "uint32",
      dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr_t",
    });
    const INPUT = koffi.struct("INPUT", { type: "uint32", mi: MOUSEINPUT });
    const size = INPUT.size;   // x64/arm64 = 40（cbSize 传错 SendInput 直接失败）
    if (size !== 40) log(`警告：INPUT 大小为 ${size}，预期 40 —— 滚轮可能无效`);
    const SendInput = user32.func("uint32 SendInput(uint32 nInputs, INPUT* pInputs, int cbSize)");
    return (delta, horizontal) => SendInput(1, [{
      type: 0,
      mi: {
        dx: 0, dy: 0, mouseData: delta,
        dwFlags: horizontal ? 0x1000 : 0x0800,   // MOUSEEVENTF_HWHEEL / WHEEL
        time: 0, dwExtraInfo: 0,
      },
    }], size);
  });

  const okCount = Object.keys(w32).length;
  log(`Win32 已绑定 ${okCount} 项 API${okCount < 4 ? "（部分缺失，相关功能会降级）" : ""}`);
}

/** 一个滚轮"格"对应的增量 —— Windows 标准值。 */
const WHEEL_DELTA = 120;

// ── 指示窗（"AI 操作中"浮标）──────────────────────────────────────
//
// 用户要的：AI 操作时有个**看得见**的东西，显示在做什么、最近几步、累计数，以及
// 一个停止按钮。窗口由**宿主**建（进程开不了窗口），这里负责：
//   · 决定何时请宿主开窗（AI 开始操作时；已开着就不重复请求 —— 重复 = 重建 = 闪）
//   · 查它的屏幕矩形（FindWindowW + GetWindowRect），用于"别操作它所在区域"
//   · 提供 /activity 给窗口轮询

/**
 * 指示窗的标题 —— 与宿主 Rust 侧**必须完全一致**（`indicator::<插件名>::<宿主PID>`）。
 *
 * ⚠️ 带宿主 PID 是必需的：多开时每个实例各有一个指示窗，标题只含插件名的话
 * FindWindow 可能返回**另一个实例**的窗口 → 读错矩形、挪错窗口。
 * 宿主 PID 来自 env（见 plugin_process.rs 的注入）；手动跑的实例没有它，
 * 此时定位不到指示窗（功能自然降级，不报错）。
 */
const PLUGIN_NAME = path.basename(__dirname);
const HOST_PID = Number(process.env.CLAUDE_PLUGIN_HOST_PID) || 0;
const INDICATOR_TITLE = `indicator::${PLUGIN_NAME}::${HOST_PID}`;
/** 指示窗尺寸（配合 indicator.html 的高度；尽量小，少遮挡）。 */
const INDICATOR_W = 300;
const INDICATOR_H = 132;

/** 指示窗当前的屏幕矩形（物理像素）。null = 窗口不在（没开 / 已关）。 */
function indicatorRect() {
  if (!w32 || !w32.findWindow || !w32.getWindowRect) return null;
  try {
    const hwnd = w32.findWindow(null, INDICATOR_TITLE);
    if (!hwnd) return null;
    return w32.getWindowRect(hwnd);
  } catch (e) {
    log("查询指示窗矩形失败:", e && e.message);
    return null;
  }
}

/** 点是否落在指示窗内（用于拒绝会打到它身上的操作）。 */
function inIndicator(x, y) {
  const r = indicatorRect();
  if (!r) return false;
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

/** 操作目标是文字描述（给指示窗显示）。 */
function describeStep(action, args) {
  const a = args || {};
  const coord = (p) => (a.x !== undefined ? `(${a.x},${a.y})`
    : a.dx !== undefined || a.dy !== undefined ? `+(${a.dx || 0},${a.dy || 0})` : "");
  switch (action) {
    case "move": return `移动 ${coord()}`;
    case "click": return `点击 ${coord() || "当前处"}${a.double ? "（双击）" : ""}${a.button && a.button !== "left" ? ` ${a.button}` : ""}`;
    case "drag": return `拖拽 (${a.fromX},${a.fromY})→(${a.toX},${a.toY})`;
    case "scroll": return `滚动 (${a.dx || 0},${a.dy || 0})`;
    case "key": {
      const mods = Array.isArray(a.modifiers) && a.modifiers.length ? `${a.modifiers.join("+")}+` : "";
      return `按键 ${mods}${a.key}${a.hold ? "（按住）" : ""}`;
    }
    case "type": {
      const t = String(a.text ?? "");
      return `输入「${t.length > 14 ? t.slice(0, 14) + "…" : t}」`;
    }
    case "screen_info": return "读取屏幕信息";
    case "move_indicator": return "移动指示窗";
    case "abort": return "停止";
    default: return action;
  }
}

// ── 活动记录（指示窗展示用）──
const ACTIVITY_MAX = 20;
let activityLog = [];        // `{ t, text }[]`，最近在后
let actionCount = 0;         // 本次进程生命周期内累计执行的动作数
const sessionStart = Date.now();
let lastActivityAt = 0;

/**
 * 距上次操作多久还算"活跃"（指示窗据此显示「AI 操作中 / AI 空闲」）。
 *
 * ⚠️ **不能只看瞬时状态**（`currentAction !== ""`）：一批操作可能几百毫秒就跑完，
 * 而指示窗**恰恰是操作做完才打开的**（`open-indicator` 随工具响应返回）——
 * 于是窗口一出现就是"空闲"，用户看到鼠标在动、窗口却说「AI 空闲」，完全对不上。
 * 实测用户报的就是这个：「指示器里一直显示 AI 空闲 啥意思」。
 *
 * 给一段活跃窗口：刚操作过的这段时间内仍显示"操作中"，与实际观感一致。
 *
 * **取 10 秒**（不是 3 秒）：AI 干活的节奏是"发一批操作 → 想 2~10 秒 → 再发一批"，
 * 而"想"的那几秒里 `currentAction` 是空的。窗口太短（试过 3 秒）会让显示在这两者
 * 之间反复横跳 —— 用户看到的是"AI 一直在干活，但窗口一会儿操作中一会儿空闲"，
 * 跟"永远显示空闲"一样让人困惑。10 秒能盖住一轮思考，连续工作期间稳定显示"操作中"。
 *
 * 与 `IDLE_CLOSE_MS`（30 秒）的分工：
 *   0~10 秒   → "AI 操作中"（在干活，或刚干完一批，可能正在想下一批）
 *   10~30 秒  → "AI 空闲"（大概真停手了，窗口还留着让你看最后结果）
 *   30 秒后   → 窗口淡出
 */
const ACTIVE_WINDOW_MS = 10000;

function noteActivity(action, args) {
  lastActivityAt = Date.now();
  actionCount++;
  activityLog.push({ t: lastActivityAt, text: describeStep(action, args) });
  if (activityLog.length > ACTIVITY_MAX) activityLog.shift();
}

// ── 输入锁定（低级钩子）────────────────────────────────────────────
//
// ## 为什么需要
//
// 用户报的：「AI 操作时如果用户也操作，互相抢夺，其实没法保证最终 AI 操作的结果」。
// 确实 —— 鼠标只有一个，用户动一下就可能让 AI 的点击落到别处。用户要的解法：
// **AI 提前声明"这个长操作别打扰我"，期间屏蔽用户的物理输入**。
//
// ## 为什么不用 BlockInput
//
// 实测 `BlockInput(TRUE)` **返回 false**（失败）：它要求调用线程是**前台线程**，
// 而本插件是后台进程。所以只能走低级钩子。
//
// ## 为什么钩子比 BlockInput 安全得多
//
//   · 回调超过 LowLevelHooksTimeout（默认 300ms）没返回 → 系统**自动忽略该钩子**，
//     事件照常传递（不会把用户键鼠锁死）
//   · 进程退出/崩溃 → 系统**自动卸载**钩子
//   这两条是"锁输入"这类功能能安全存在的前提。
//
// ## 怎么只锁用户、不锁 AI 自己
//
// 钩子回调里读 `LLKHF_INJECTED / LLMHF_INJECTED` 标志：
//   · **物理**事件（用户操作）→ 吞掉（返回 1，不再传给目标窗口）
//   · **注入**事件（AI 自己的 SendInput）→ 放行
// 这是 BlockInput 做不到的（它不区分来源，会把 AI 自己也锁住）。
//
// ## 逃生门
//
// 锁定时用户按 **Ctrl+Q** → 立即解除锁定 + 完全停住 AI（沿用急停语义：需要用户
// 在面板显式解除才能继续）。为什么必须留这个：锁输入如果因为任何意外没解开，
// 用户的键鼠就"没反应"了 —— 必须有用户自己能按的出路。

const WH_KEYBOARD_LL = 13;
const WH_MOUSE_LL = 14;
const HC_ACTION = 0;
/** 键盘事件是"注入的"（SendInput）—— 见 KBDLLHOOKSTRUCT.flags */
const LLKHF_INJECTED = 0x10;
/** 鼠标事件是"注入的" */
const LLMHF_INJECTED = 0x01;

// 钩子回调 wParam（消息）常量。
// ⚠️ 这几个**必须定义**：早期实现漏了，而回调里的 try/catch 会把 ReferenceError
// 静默吞掉 —— 表现是"钩子装上了、事件计数也在涨，但逃生键永不触发"，日志里只有
// 一行不易察觉的"键盘钩子异常"。回调里的这类错误特别隐蔽。
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_SYSKEYDOWN = 0x0104;
const WM_SYSKEYUP = 0x0105;

/** 逃生键：Q（配合 Ctrl）。见文件头的"逃生门"说明。 */
const ESCAPE_VK = 0x51;
const VK_CONTROL = 0x11;

/**
 * 测试模式：把**注入**事件当成**物理**事件处理（即也吞掉）。
 *
 * 为什么需要：验证"物理事件被吞掉"必须有人真的按键 —— 而自动化测试只能发注入
 * 事件（那些本该放行）。开了这个开关，注入事件也会被吞 → 用"目标窗口收不到"
 * 就能验证吞掉逻辑真的生效。
 */
const TEST_SWALLOW_INJECTED = process.env.MK_TEST_SWALLOW_INJECTED === "1";

/** 临时诊断：把钩子里看到的事件打出来（排查"逃生键不触发"这类问题用）。 */
const DEBUG_HOOK = process.env.MK_DEBUG_HOOK === "1";

// ── 租约（⚠️ 锁绝不能是永久的）──
//
// 锁忘了解除 = 用户键鼠全没反应 —— 这是这个功能最大的风险。所以锁是**租约**：
//   · 最长 LOCK_LEASE_MS 后**自动解除**（无论 AI 在不在续）
//   · AI 每次续期（heartbeat）把到期时间往后推
//   · 即使续期全断（进程卡死/被杀/网络断），用户最多只被锁这么久
//
// 与"AI 死了怎么办"的关系：租约到期即解锁，所以**不需要**依赖任何一方活着。
const LOCK_LEASE_MS = 10000;
/** 租约剩余多少时该续期（AI 每批操作、以及指示窗轮询时都会顺带续） */
const LOCK_RENEW_WITHIN_MS = 3000;

/** 当前锁定状态（给 /activity、/status 与指示窗用）。 */
const lockState = {
  active: false, scope: "none", installed: false,
  since: 0,        // 本次锁定开始的时刻
  expiresAt: 0,    // 租约到期时刻 —— 到点自动解除
};

let hookProcs = null;     // koffi 回调（必须保引用，否则被 GC 掉 → 崩溃）
let hooks = { kb: null, ms: null };
let pumpTimer = null;
let leaseTimer = null;

/** 事件是否算"物理"（= 该被吞）。测试模式下注入事件也算物理。 */
function isPhysicalEvent(flags, injectedBit) {
  if (TEST_SWALLOW_INJECTED) return true;
  return (flags & injectedBit) === 0;
}

/**
 * Ctrl 键是否按下的两种判定 —— **用途不同，不能混用**。
 *
 * ① `escapeComboDownAsync()`：用 GetAsyncKeyState 现读。
 *    只适用于**没装钩子**的时候（未锁定）。锁定期间被吞掉的按键**不会**进入系统的
 *    键状态表，这个接口读不到 —— 早期实现就踩了这个坑：逃生键在锁定时完全失效。
 *
 * ② `ctrlDown`（由钩子自己跟踪）：锁定期间唯一可靠的来源。
 *    钩子能拿到每一个物理按键消息，所以自己维护一份按下集合。
 */
function escapeComboDownAsync() {
  if (!w32 || !w32.getAsyncKeyState) return false;
  if (!(w32.getAsyncKeyState(ESCAPE_VK) & 0x8000)) return false;
  // Ctrl 左右键的 vk 不同（0xA2/0xA3），一并查（只查 0x11 在某些键盘上会漏）
  return (w32.getAsyncKeyState(VK_CONTROL) & 0x8000) !== 0
      || (w32.getAsyncKeyState(0xA2) & 0x8000) !== 0
      || (w32.getAsyncKeyState(0xA3) & 0x8000) !== 0;
}

/**
 * 钩子活动计数（排查用）。
 *
 * 为什么留这个：钩子"没生效"和"生效了但判定错"从外面看起来一样（都是"输入没被吞"
 * 或"逃生键不灵"），而日志里什么都不会有 —— 有这个计数器就能一眼区分：
 * 计数涨了 = 钩子在跑；不涨 = 根本没收到事件（装错了/被系统忽略）。
 */
const hookStats = { kb: 0, ms: 0, escapes: 0 };

/** 钩子跟踪的 Ctrl 按下集合（含左右键）；只在锁定期间维护。 */
const ctrlDown = new Set();
const CTRL_VKS = new Set([VK_CONTROL, 0xA2, 0xA3]);   // Control / LControl / RControl

/** 钩子里更新 Ctrl 状态（keydown/keyup 都会走到）。 */
function trackCtrl(vk, isKeyDown) {
  if (!CTRL_VKS.has(vk)) return;
  if (isKeyDown) ctrlDown.add(vk);
  else ctrlDown.delete(vk);
}

/** 锁定期间判定逃生组合：钩子看到 Ctrl 按下（跟踪）+ 此刻按下的是 Q。 */
function escapeComboDownInHook() {
  return ctrlDown.size > 0;
}

/**
 * 用户按下逃生键：解除锁定 + 急停。
 *
 * 语义是**完全停住**（不是暂停）：用户插手意味着桌面状态可能已经变了，
 * 之前那批操作的前提不再成立 —— 继续执行是危险的（同"失败即停"的理由）。
 */
function triggerEscape() {
  uninstallLock();
  setAborted("用户按下 Ctrl+Q 强行接管");
}

/**
 * 消息泵。
 *
 * ⚠️ 低级钩子的回调是在**安装钩子的线程**上、由系统投递消息触发的 —— 该线程必须
 * 抽消息（PeekMessage/GetMessage）回调才会跑。Node 的事件循环**不抽 Win32 消息**，
 * 所以必须自己轮询。
 *
 * 间隔取 4ms：钩子没及时响应时事件会延迟（最多这么多），但锁定期间用户的输入本来
 * 就是被吞的，延迟只影响 AI 自己的注入事件 —— 4ms 对观感无影响。
 */
function startPump() {
  if (pumpTimer || !w32 || !w32.peekMessage) return;
  pumpTimer = setInterval(() => {
    try {
      // 抽空队列（一次 tick 多抽几次，避免进程忙碌时积压）
      for (let i = 0; i < 32; i++) {
        if (!w32.peekMessage()) break;
      }
    } catch (e) {
      log("消息泵异常:", e && e.message);
    }
  }, 4);
  if (pumpTimer.unref) pumpTimer.unref();   // 不阻止进程退出
}

function stopPump() {
  if (pumpTimer) { clearInterval(pumpTimer); pumpTimer = null; }
}

/** 是否该锁键盘 / 鼠标。 */
const wantsKeyboard = (scope) => scope === "keyboard" || scope === "both";
const wantsMouse = (scope) => scope === "mouse" || scope === "both";

/** 池化范围校验（AI 传进来的值）。 */
function normalizeLockScope(v) {
  // AI 常写 `lock: true` 表示"这次别打扰我" —— 等价于 both。
  // 布尔比字符串省 token，且意图明确，所以两种都收。
  if (v === true) return "both";
  if (typeof v !== "string") return "none";
  const s = v.trim().toLowerCase();
  if (s === "keyboard" || s === "mouse" || s === "both") return s;
  return "none";
}

/**
 * 键盘钩子回调。
 * ⚠️ 回调里绝不能抛异常 —— 会让钩子链断掉、输入行为不可预期。全部包 try。
 */
function onKeyboardEvent(nCode, wParam, lParam) {
  try {
    if (nCode === HC_ACTION && lockState.active && wantsKeyboard(lockState.scope)) {
      const info = koffi.decode(lParam, "KBDLLHOOKSTRUCT");
      if (isPhysicalEvent(info.flags, LLKHF_INJECTED)) {
        // ⚠️ wParam 声明为 uintptr_t → koffi 传进来的是 **BigInt**（如 256n）。
        // 直接跟数字常量比（256n === 256 为 false）会让 isKeyDown 永远不成立 ——
        // 表现是"按键确实被吞了，但逃生键死活不触发"（实测踩到）。
        hookStats.kb++;
        const msg = Number(wParam);
        const isKeyDown = msg === WM_KEYDOWN || msg === WM_SYSKEYDOWN;
        const isKeyUp = msg === WM_KEYUP || msg === WM_SYSKEYUP;

        // 自己跟踪 Ctrl —— 见 escapeComboDownAsync 注释（吞掉的键读不到键状态表）
        if (isKeyDown) trackCtrl(info.vkCode, true);
        else if (isKeyUp) trackCtrl(info.vkCode, false);

        if (DEBUG_HOOK && hookStats.kb < 40) {
          const isEsc = isKeyDown && info.vkCode === ESCAPE_VK && escapeComboDownInHook();
          log(`[hook] vk=0x${Number(info.vkCode).toString(16)} down=${isKeyDown} up=${isKeyUp} ctrlAfter=${ctrlDown.size} isEscVk=${info.vkCode === ESCAPE_VK} esc=${isEsc}`);
        }

        // 逃生组合：Ctrl 跟踪为按下 + 此刻按下的是 Q → 接管（并把 Q 吞掉，
        // 免得它落到当前前台应用里触发什么快捷键）
        if (isKeyDown && info.vkCode === ESCAPE_VK && escapeComboDownInHook()) {
          hookStats.escapes++;
          log("用户按下 Ctrl+Q —— 接管");
          triggerEscape();
        }
        return 1;   // 吞：不传下去
      }
    }
  } catch (e) {
    // 钩子里的异常很容易被忽略（日志里只有一行），但它会让**整个锁定失效**：
    // 异常 → 走到下面的 callNextHookEx → 事件被放行（既不吞、也不检测逃生键）。
    // 所以计入 stats（/activity 可见）并带上堆栈。
    hookStats.kbErrors = (hookStats.kbErrors || 0) + 1;
    if (hookStats.kbErrors <= 3) log("键盘钩子异常（锁定会失效！）:", (e && e.stack) || e);
  }
  return w32.callNextHookEx(hooks.kb, nCode, wParam, lParam);
}

/** 鼠标钩子回调（移动/点击/滚轮全部按需吞掉）。 */
function onMouseEvent(nCode, wParam, lParam) {
  try {
    if (nCode === HC_ACTION && lockState.active && wantsMouse(lockState.scope)) {
      const info = koffi.decode(lParam, "MSLLHOOKSTRUCT");
      hookStats.ms++;
      if (isPhysicalEvent(info.flags, LLMHF_INJECTED)) {
        return 1;   // 吞掉用户的一切鼠标事件（含移动）
      }
    }
  } catch (e) {
    hookStats.msErrors = (hookStats.msErrors || 0) + 1;
    if (hookStats.msErrors <= 3) log("鼠标钩子异常（锁定会失效！）:", (e && e.stack) || e);
  }
  return w32.callNextHookEx(hooks.ms, nCode, wParam, lParam);
}

/** 注册结构体与回调（只做一次）。 */
function ensureHookProcs() {
  if (hookProcs) return hookProcs;
  koffi.struct("KBDLLHOOKSTRUCT", {
    vkCode: "uint32", scanCode: "uint32", flags: "uint32", time: "uint32", dwExtraInfo: "uintptr_t",
  });
  koffi.struct("POINT", { x: "int32", y: "int32" });
  koffi.struct("MSLLHOOKSTRUCT", {
    pt: "POINT", mouseData: "uint32", flags: "uint32", time: "uint32", dwExtraInfo: "uintptr_t",
  });
  // ⚠️ 回调原型必须用 koffi.proto 定义（直接写字符串签名会报
  // "Unexpected character '(' in type specifier"）；返回值必须是 intptr_t
  const HOOKPROC = koffi.proto("intptr_t HOOKPROC(int nCode, uintptr_t wParam, intptr_t lParam)");
  hookProcs = {
    kb: koffi.register(onKeyboardEvent, koffi.pointer(HOOKPROC)),
    ms: koffi.register(onMouseEvent, koffi.pointer(HOOKPROC)),
  };
  return hookProcs;
}

/**
 * 锁定用户输入（AI 声明独占时调用）。
 * @param scope "keyboard" | "mouse" | "both"
 * @returns 成功锁定的范围（可能是 "none" —— 钩子装不上时如实返回）
 */
function installLock(scope) {
  if (!IS_WIN || !w32 || !w32.setWindowsHookEx) return "none";
  if (lockState.active) {
    // 已在锁定：取并集（sequence 里嵌套调用时不会互相解锁）
    if (scope === "both" || lockState.scope !== scope) lockState.scope = "both";
    inLockDepth++;
    return lockState.scope;
  }
  const procs = ensureHookProcs();
  const hMod = w32.getModuleHandle ? w32.getModuleHandle(null) : null;
  let ok = false;
  if (wantsKeyboard(scope)) {
    hooks.kb = w32.setWindowsHookEx(WH_KEYBOARD_LL, procs.kb, hMod, 0);
    if (hooks.kb) ok = true;
    else log("键盘钩子安装失败（锁定不生效）");
  }
  if (wantsMouse(scope)) {
    hooks.ms = w32.setWindowsHookEx(WH_MOUSE_LL, procs.ms, hMod, 0);
    if (hooks.ms) ok = true;
    else log("鼠标钩子安装失败（锁定不生效）");
  }
  if (!ok) return "none";

  lockState.active = true;
  lockState.scope = scope;
  lockState.installed = true;
  // 清空 Ctrl 跟踪：装锁这一刻的状态是未知的（用户可能正按着 Ctrl），
  // 保留旧值会让"下一个 Q"被误判成逃生组合
  ctrlDown.clear();
  lockState.since = Date.now();
  lockState.expiresAt = Date.now() + LOCK_LEASE_MS;
  inLockDepth = 1;
  startPump();
  startLeaseWatchdog();
  log(`已锁定用户输入（${scope}，租约 ${LOCK_LEASE_MS / 1000}s）—— 逃生键 Ctrl+Q`);
  return scope;
}

/**
 * 租约续期（心跳）。
 * 每批操作、以及指示窗轮询 /activity 时都会调 —— 两重来源，避免单点依赖。
 */
function renewLock() {
  if (!lockState.active) return false;
  lockState.expiresAt = Date.now() + LOCK_LEASE_MS;
  return true;
}

/**
 * 租约看门狗：到点自动解除。
 *
 * ⚠️ 这是"忘了解除"的**唯一兜底**，必须有。用定时器而不是"每次操作时检查"——
 * 因为最坏情况恰恰是"没有任何操作了"（AI 进程卡死、宿主崩了、网络断了），
 * 那种情况下没有东西会来触发检查。
 */
function startLeaseWatchdog() {
  if (leaseTimer) return;
  leaseTimer = setInterval(() => {
    if (!lockState.active) { stopLeaseWatchdog(); return; }
    if (Date.now() >= lockState.expiresAt) {
      log(`锁定租约到期（${LOCK_LEASE_MS / 1000}s 未续期）→ 自动解除`);
      uninstallLock(true);
    }
  }, 500);
  if (leaseTimer.unref) leaseTimer.unref();
}

function stopLeaseWatchdog() {
  if (leaseTimer) { clearInterval(leaseTimer); leaseTimer = null; }
}

/**
 * 解除锁定。
 * @param force true = 无视嵌套深度强制解除（租约到期、急停、进程退出时用）
 */
function uninstallLock(force = false) {
  if (!lockState.active) return;
  if (!force) {
    inLockDepth = Math.max(0, inLockDepth - 1);
    if (inLockDepth > 0) return;    // 还有嵌套的调用在锁着
  }
  try {
    if (hooks.kb && w32.unhookWindowsHookEx) w32.unhookWindowsHookEx(hooks.kb);
    if (hooks.ms && w32.unhookWindowsHookEx) w32.unhookWindowsHookEx(hooks.ms);
  } catch (e) {
    log("卸载钩子失败（进程退出时系统会自动清）:", e && e.message);
  }
  hooks.kb = null;
  hooks.ms = null;
  lockState.active = false;
  lockState.scope = "none";
  lockState.installed = false;
  lockState.expiresAt = 0;
  ctrlDown.clear();
  inLockDepth = 0;
  stopPump();
  stopLeaseWatchdog();
  log("已解除输入锁定");
}

/** 嵌套深度（sequence 内部的子动作不会再装/卸一次） */
let inLockDepth = 0;

/** 供 /activity、/status 用的快照。 */
function lockSnapshot() {
  return {
    locked: lockState.active,
    lockScope: lockState.scope,
    lockedMs: lockState.active ? Date.now() - lockState.since : 0,
    /** 距租约到期还有多久 —— 用户/调试都能看到"锁还剩几秒" */
    lockRemainMs: lockState.active ? Math.max(0, lockState.expiresAt - Date.now()) : 0,
    escapeKey: "Ctrl+Q",
    hookEvents: { ...hookStats },
  };
}

// ── 安全层 ────────────────────────────────────────────────────────

/** AI 是否被急停（进程级状态，不自动恢复）。 */
let aborted = false;
/** 急停原因（面板/工具都能看到，便于用户判断谁按的）。 */
let abortReason = "";

/** 正在被"按住"的键与鼠标按钮 —— 必须在急停/退出时释放。 */
const heldKeys = new Set();
const heldButtons = new Set();

/** 当前正在执行的操作名（面板显示用）。 */
let currentAction = "";

function setAborted(reason) {
  if (aborted) return;
  aborted = true;
  abortReason = reason;
  // 急停必解锁：用户要拿回控制权，锁着键鼠就本末倒置了（force=true 无视嵌套深度）
  uninstallLock(true);
  // 刷新活动时间：指示窗用它决定何时淡出。用户刚按了停止，窗口至少再留
  // IDLE_CLOSE_MS（30 秒）让人看清"已停止"—— 否则会按"上次操作"的时间算，
  // 可能刚点完就消失。
  lastActivityAt = Date.now();
  log(`ABORT: ${reason}`);
  releaseAll();
}

/** 解除急停（只在面板由用户显式触发）。 */
function clearAbort() {
  aborted = false;
  abortReason = "";
}

/**
 * 把按下的键与鼠标按钮全部抬起。
 *
 * 为什么必须有：`mouseToggle('down')` 之后进程若被急停/杀掉，按钮在系统层面**仍是
 * 按下状态** —— 用户的下一次物理点击会变成拖拽或多选（很难联想到是这个原因）。
 */
function releaseAll() {
  for (const b of heldButtons) {
    try { robot.mouseToggle("up", b); } catch (e) { log("释放按钮失败:", b, e && e.message); }
  }
  heldButtons.clear();
  for (const k of heldKeys) {
    try { robot.keyToggle(k, "up"); } catch (e) { log("释放按键失败:", k, e && e.message); }
  }
  heldKeys.clear();
}

// ── 中断检查 ──────────────────────────────────────────────────────
//
// 长操作（拖拽、长文本输入）在每个循环里调 `checkAbort()` —— 已急停就抛错打断。
//
// **用户的中断途径**（两条，都在本文件别处实现）：
//   · 键盘 → Ctrl+Q，由输入锁定的钩子捕获（见 ESCAPE_VK / triggerEscape）
//   · 鼠标 → 点指示窗的「停止」按钮（仅在未锁定时可点）
//
// 为什么**不用"注册全局热键"**：那是 OS 进程级独占的，多开 GUI 时只有先注册的
// 实例能用（用户正是因为这个把截屏热键改成了窗口内）。钩子没有这个问题 ——
// 每个实例各自装自己的。

/**
 * 在长操作期间轮询中断；已急停则抛错打断。
 *
 * 只在操作循环里调用（`drag` 的每一步、`type` 的每个字符）—— 短操作（一次点击）
 * 不需要，也来不及按。
 *
 * 用户的**中断途径**统一为 Ctrl+Q（锁定与否都有效）：
 *   · 锁定期间 → 键盘钩子捕获（见 onKeyboardEvent，那里能拿到被吞的按键）
 *   · 未锁定时 → 这里轮询（GetAsyncKeyState 在没装钩子时是可靠的）
 * 两者都走 setAborted，效果一致。
 */
function checkAbort() {
  if (aborted) throw new AbortError();

  // 长操作期间把租约往后推 —— 否则一个 30 秒的 sequence 会在中途租约到期、
  // 用户输入突然恢复（正是要防止的"半路被插手"）。纯内存操作，代价可忽略。
  if (lockState.active) renewLock();

  // 逃生组合的**第二重检测**：锁定期间由钩子负责（那里能拿到被吞的按键）；
  // 未锁定时没有任何东西被吞，GetAsyncKeyState 可靠，就在这里轮询。
  // 两重覆盖完整：锁定 → 钩子；未锁定 → 这里。
  if (!lockState.active && escapeComboDownAsync()) {
    setAborted("用户按下 Ctrl+Q 强行接管");
    throw new AbortError();
  }
}

class AbortError extends Error {
  constructor() { super("已急停"); this.name = "AbortError"; }
}

// ── 前台窗口检查（防 AI 操作宿主自己）──────────────────────────────

/**
 * 前台窗口是否属于宿主 GUI 进程。
 *
 * 宿主 spawn 时注入 `CLAUDE_PLUGIN_HOST_PID`（见 plugin_process.rs）。
 * 没有这个变量（手动跑的实例）→ 不检查（否则本地开发时寸步难行）。
 *
 * ⚠️ 不能用 `process.ppid` 顶替：宿主退出后的孤儿进程其 ppid 指向已被复用的
 * PID，会误判。实测确认过这种情况真实存在。
 */
function foregroundIsHost() {
  if (!w32 || !IS_WIN) return false;
  if (settings.blockHostWindows === false) return false;
  const hostPid = Number(process.env.CLAUDE_PLUGIN_HOST_PID) || 0;
  if (!hostPid) return false;
  try {
    const hwnd = w32.getForegroundWindow();
    if (!hwnd) return false;
    const out = [0];
    w32.getWindowThreadProcessId(hwnd, out);
    return out[0] === hostPid;
  } catch {
    return false;   // 查询失败不阻断（宁可少拦，也不要让工具莫名其妙全废）
  }
}

/**
 * 拒绝落在指示窗上的操作。
 *
 * 为什么需要：指示窗是**置顶**的 —— 点它会打到窗口自己，而不是目标应用。更糟的是
 * robotjs 不会报错，AI 会以为点成功了，然后困惑"为什么没反应"。
 *
 * 用户给的解法很干净：**让 AI 自己挪**（`move_indicator`），所以错误信息里明确告诉它
 * 怎么做，而不是简单粗暴地拒绝。
 */
function assertNotOnIndicator(x, y) {
  if (!inIndicator(x, y)) return;
  const r = indicatorRect();
  throw new Error(
    `目标坐标 (${x},${y}) 落在「AI 操作中」指示窗上（它当前在 ${r.x},${r.y}，${r.w}×${r.h}）` +
    `—— 点它不会打到目标应用。请先用 action:"move_indicator" 把它挪到别处（例如屏幕角落），再重试。`
  );
}

/** 操作类 action 的统一前置检查。 */
function guard(action) {
  if (action === "abort" || action === "screen_info") return;   // 只读/自停豁免
  if (aborted) {
    throw new Error(
      `已急停（${abortReason || "原因未知"}），本操作未执行。` +
      `请在插件面板点「解除急停」后再试。`
    );
  }
  if (foregroundIsHost()) {
    throw new Error(
      "当前前台窗口是本 GUI 自己，拒绝操作 —— 界面上的弹窗（如工具权限确认框）" +
      "必须由用户处理，AI 不能代替用户点它。请先切换到目标窗口，或请用户操作。"
    );
  }
}

// ── 工具实现 ──────────────────────────────────────────────────────

/**
 * 异步等待。
 *
 * ⚠️ **必须异步，不能用 `Atomics.wait` 同步阻塞**：本进程同时是个 HTTP 服务，
 * 同步 sleep 会把事件循环整个卡住 —— 长操作（拖拽、长文本输入）期间
 * `/activity`（指示窗轮询）与 `/abort`（停止按钮）**都得不到响应**，
 * 表现是"指示窗卡住不动、点了停止没反应，操作跑完才生效"。
 * 停止按钮延迟到操作结束才起作用，等于没有。
 *
 * 代价是操作之间可能交错，故有 `withOpLock` 串行化。
 */
function sleep(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/**
 * 操作串行锁：同一时刻只允许一个**会动鼠标键盘**的操作。
 *
 * 为什么需要：改成异步 sleep 后，两个并发调用（AI 同时发多个 tool call）会在
 * `await` 处交错 —— 一个的 `mouseToggle('down')` 可能和另一个的移动混在一起，
 * 拖出莫名其妙的结果。
 *
 * 已有操作在进行 → **直接拒绝并说明**（不排队）：排队会让调用方等到天荒地老，
 * 也看不出发生了什么；拒绝是即时的、可理解的，AI 重试即可。
 */
let opInFlight = false;

async function withOpLock(label, fn) {
  if (opInFlight) {
    throw new Error(
      `已有操作正在进行中（${opInFlight}），本次「${label}」未执行。` +
      `请稍等片刻后重试；若卡住了，用 action:"abort" 或急停键停止。`
    );
  }
  opInFlight = label;
  try {
    return await fn();
  } finally {
    opInFlight = false;
  }
}

/** 稳定读取鼠标位置（UIPI 拦截时 robotjs 不报错，只能靠比对发现）。 */
function mousePos() {
  try { return robot.getMousePos(); } catch { return null; }
}

/**
 * 解析目标坐标 —— 支持**绝对**（x/y）与**相对**（dx/dy，相对当前位置）两种写法。
 *
 * 为什么要有相对坐标：AI 经常只想"往右挪一点再点"，用绝对坐标就得先查一次
 * `screen_info` 拿到当前位置再算 —— 多一轮工具调用（1~3 秒）。给 dx/dy 就省掉了。
 *
 * @returns `{x, y}` 绝对坐标；两者都没给返回 null（= 用当前位置）。
 */
function resolveTarget(args) {
  const hasAbs = Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y));
  if (hasAbs) return { x: Math.round(Number(args.x)), y: Math.round(Number(args.y)) };
  const hasRel = Number.isFinite(Number(args.dx)) || Number.isFinite(Number(args.dy));
  if (!hasRel) return null;
  const cur = mousePos();
  if (!cur) throw new Error("需要相对坐标（dx/dy）但读不到当前鼠标位置");
  return { x: cur.x + Math.round(Number(args.dx) || 0), y: cur.y + Math.round(Number(args.dy) || 0) };
}

function actScreenInfo() {
  let displays = [];
  try { displays = robot.getDisplays() || []; } catch (e) { log("getDisplays 失败:", e && e.message); }
  const pos = mousePos();
  return {
    ok: true,
    displays: displays.map((d) => ({
      id: d.id, x: d.x, y: d.y, width: d.width, height: d.height, isMain: !!d.isMain,
    })),
    mouse: pos ? { x: pos.x, y: pos.y } : null,
    // 坐标是**虚拟桌面绝对坐标** —— 与截屏插件返回的图内坐标换算：
    //   绝对 = 该显示器的 (x, y) + 图内坐标
    coordinateSpace: "virtual-desktop-absolute",
    aborted,
  };
}

function actMove(args) {
  const t = resolveTarget(args);
  if (!t) throw new Error("move 需要 x/y（绝对）或 dx/dy（相对当前位置）");
  assertNotOnIndicator(t.x, t.y);
  if (args.smooth) {
    robot.moveMouseSmooth(t.x, t.y, Number(args.speed) || 3);
  } else {
    robot.moveMouse(t.x, t.y);
  }
  const after = mousePos();
  const ok = after && Math.abs(after.x - t.x) <= 2 && Math.abs(after.y - t.y) <= 2;
  return {
    ok: true,
    movedTo: t,
    actual: after,
    ...(ok ? {} : { warning: `鼠标未到达目标位置（期望 ${t.x},${t.y}，实际 ${after ? `${after.x},${after.y}` : "未知"}）—— 可能被系统拦截（目标窗口权限更高？）` }),
  };
}

function actClick(args) {
  const btn = (args.button === "right" || args.button === "middle") ? args.button : "left";
  const t = resolveTarget(args);   // null = 不给坐标，点当前位置
  if (t) {
    assertNotOnIndicator(t.x, t.y);
    robot.moveMouse(t.x, t.y);
  } else {
    // 不给坐标时点的是**当前位置** —— 若它恰好在指示窗上，同样要拦
    const cur = mousePos();
    if (cur) assertNotOnIndicator(cur.x, cur.y);
  }
  const before = mousePos();
  robot.mouseClick(btn, !!args.double);
  return { ok: true, clicked: btn, double: !!args.double, at: before };
}

async function actDrag(args) {
  const fx = Math.round(Number(args.fromX)), fy = Math.round(Number(args.fromY));
  const tx = Math.round(Number(args.toX)), ty = Math.round(Number(args.toY));
  if (![fx, fy, tx, ty].every(Number.isFinite)) {
    throw new Error("drag 需要数字 fromX / fromY / toX / toY");
  }
  const btn = (args.button === "right" || args.button === "middle") ? args.button : "left";
  const dur = Math.max(50, Math.min(5000, Number(args.duration) || settings.smoothMoveMs || 400));
  assertNotOnIndicator(fx, fy);   // 起点落在指示窗上 → 按下就丢了
  assertNotOnIndicator(tx, ty);   // 终点落在上面 → 松开也丢

  robot.moveMouse(fx, fy);
  robot.mouseToggle("down", btn);
  heldButtons.add(btn);
  try {
    await sleep(50);   // 按下后停一下再动 —— 有些应用需要时间进入拖拽态
    const steps = Math.max(8, Math.min(150, Math.round(dur / 12)));
    const stepMs = Math.round(dur / steps);
    for (let i = 1; i <= steps; i++) {
      checkAbort();   // 每一步都可中断
      const t = i / steps;
      robot.moveMouse(
        Math.round(fx + (tx - fx) * t),
        Math.round(fy + (ty - fy) * t),
      );
      await sleep(stepMs);
    }
  } finally {
    // 无论成功、出错还是急停，都必须把按钮抬起来
    try { robot.mouseToggle("up", btn); } catch (e) { log("拖拽结束释放按钮失败:", e && e.message); }
    heldButtons.delete(btn);
  }
  return { ok: true, from: { x: fx, y: fy }, to: { x: tx, y: ty }, button: btn, durationMs: dur };
}

/**
 * 滚轮。`dx`/`dy` 的单位是**格**（不是原始 delta）—— AI 与人都按"滚几格"思考，
 * 一格 = WHEEL_DELTA = 120，由这里换算。正 dy = 向下，正 dx = 向右。
 *
 * 用自己发的 SendInput 而不是 `robot.scrollMouse`（后者在本机实测无效，见 w32
 * 初始化处注释）。
 */
function actScroll(args) {
  const dx = Math.round(Number(args.dx) || 0);
  const dy = Math.round(Number(args.dy) || 0);
  if (!dx && !dy) return { ok: true, scrolled: { dx, dy }, note: "dx 与 dy 都是 0，未滚动" };
  if (!w32 || !w32.sendWheel) {
    // 退路：安全层的 Win32 初始化失败时仍尽力而为（robotjs 那条路，可能无效）
    try { robot.scrollMouse(dx, dy); return { ok: true, scrolled: { dx, dy }, degraded: true }; }
    catch (e) { throw new Error(`滚轮不可用：${e && e.message}`); }
  }
  // ⚠️ 符号要取反：**Windows 原生约定是"正 delta = 向上/向左"**，而本工具面向
  // AI 的语义是"正 dy = 向下、正 dx = 向右"（robotjs 也是这个约定，更符合直觉）。
  // 实测踩过：不取反会把"向下滚 3 格"变成滚回顶部。
  const sentY = dy ? w32.sendWheel(-dy * WHEEL_DELTA, false) : 1;
  const sentX = dx ? w32.sendWheel(dx * WHEEL_DELTA, true) : 1;
  const ok = sentY > 0 && sentX > 0;
  return {
    ok: true,
    scrolled: { dx, dy },
    ...(ok ? {} : {
      warning: "滚动事件被系统拦截（SendInput 返回 0）—— 光标所在的窗口可能以更高权限运行。",
    }),
  };
}

/**
 * 键名/修饰键的**别名映射** —— robotjs 只认它自己那张表（修饰键叫 `control`
 * 而不是 `ctrl`，键名是 `escape` 而不是 `esc`），写错直接抛
 * "Invalid key flag specified."（对使用者毫无帮助）。AI 与人都会用更自然的写法，
 * 所以在这里翻译，而不是要求他们记住库的内部命名。
 */
const MOD_ALIASES = {
  ctrl: "control", control: "control",
  leftctrl: "left_control", left_ctrl: "left_control", rctrl: "right_control", right_ctrl: "right_control",
  alt: "alt", option: "alt", right_alt: "right_alt",
  shift: "shift", right_shift: "right_shift",
  cmd: "command", meta: "command", command: "command", win: "command", super: "command",
};

const KEY_ALIASES = {
  esc: "escape", return: "enter", cr: "enter", del: "delete",
  pgup: "pageup", pgdn: "pagedown", pagedn: "pagedown",
  win: "command", cmd: "command", meta: "command",
  spacebar: "space", plus: "+",
};

function normalizeMods(mods) {
  if (!Array.isArray(mods)) return undefined;
  return mods.map((m) => {
    const s = String(m).toLowerCase().replace(/[\s-]/g, "");
    return MOD_ALIASES[s] ?? s;
  });
}

function actKey(args) {
  const raw = String(args.key || "").toLowerCase().trim();
  if (!raw) throw new Error("key 需要 key 参数");
  const key = KEY_ALIASES[raw] ?? raw;
  const mods = normalizeMods(args.modifiers);
  const hold = args.hold === true;   // hold=true 表示按下不放（keyToggle down）

  // ⚠️ **没有修饰键时必须少传一个参数**，不能传 `undefined` 占位：
  // robotjs 的 keyTap/keyToggle 按 `arguments.length` 分支，显式传 undefined 会
  // 走"解析 flags"那条路 → `GetFlagsFromValue(undefined)` 返回 -2 → 抛
  // "Invalid key flag specified."（实测：`keyTap('escape', undefined)` 必报此错，
  // 而 `keyTap('escape')` 正常）。
  const hasMods = Array.isArray(mods) && mods.length > 0;

  try {
    if (hold) {
      if (hasMods) robot.keyToggle(key, "down", mods);
      else robot.keyToggle(key, "down");
      heldKeys.add(key);
      return { ok: true, key, modifiers: mods, held: true };
    }
    if (hasMods) robot.keyTap(key, mods);
    else robot.keyTap(key);
    return { ok: true, key, modifiers: mods };
  } catch (e) {
    // 把 robotjs 那句含糊的报错换成可行动的：附上常用键名与修饰键名
    throw new Error(
      `按键失败（key=${key}${mods ? `, modifiers=${mods.join("+")}` : ""}）：${e && e.message}。` +
      `修饰键可用 control/alt/shift/command（ctrl 会自动转成 control）；` +
      `键名可用 enter/tab/escape/space/backspace/delete/up/down/left/right/home/end/` +
      `pageup/pagedown/f1-f24/insert/printscreen 或单个字母数字。`
    );
  }
}

/**
 * 输入文字。
 *
 * 中文走 `unicodeTap`（`KEYEVENTF_UNICODE` → 系统合成 WM_CHAR），**天然绕过输入法**
 * 组合态。关键细节：**按 UTF-16 码元（charCodeAt）逐个发**，而不是按码点 ——
 * robotjs 的 `unicodeTap` 参数是 WORD(16bit)，非 BMP 字符（emoji / 扩展 B 汉字）
 * 传码点会被截断成垃圾；按码元发则代理对天然正确。
 */
async function actType(args) {
  const text = String(args.text ?? "");
  if (!text) throw new Error("type 需要非空 text");
  const delay = Math.max(0, Math.min(100, Number(args.delayMs ?? settings.typeDelayMs ?? 4)));
  let typed = 0;

  for (let i = 0; i < text.length; i++) {
    checkAbort();   // 长文本可中断
    const code = text.charCodeAt(i);
    if (code === 0) continue;                  // U+0000 会让 unicodeTap 抛异常
    if (code === 13) continue;                 // \r —— 与 \n 重复，跳过
    if (code === 10) { robot.keyTap("enter"); typed++; await sleep(delay); continue; }
    if (code === 9) { robot.keyTap("tab"); typed++; await sleep(delay); continue; }
    robot.unicodeTap(code);
    typed++;
    await sleep(delay);
  }
  return { ok: true, chars: typed, textLength: text.length };
}

// ── 批量执行（sequence）────────────────────────────────────────────
//
// 为什么需要：**慢的不是插件执行**（那是毫秒级），而是每步都要等 AI 想一轮
// （模型生成下一个 tool call 要 1~3 秒）。"点击 → 输入 → 回车"三连如果分三次调用，
// 光往返就 3~9 秒；合成一次调用则在毫秒级做完。
//
// ⚠️ 但有个硬约束：**宿主 MCP 是 10 秒超时**（gui/src-tauri/src/mcp.rs 的
// recv_timeout）。批量执行若超过它，宿主直接返回 timeout —— AI 会以为失败，
// 而操作其实还在做，于是**可能重试造成重复操作**。所以这里必须自己掐预算（见下方）。

/** 单次 sequence 的步数上限（防 AI 一轮刷屏式操作）。 */
const SEQ_MAX_STEPS = 100;
/** 每步的 repeat 上限。 */
const SEQ_MAX_REPEAT = 200;
/**
 * 总时长预算（毫秒）。宿主超时是 10s，留 2s 余量给协议往返与网络。
 * 超预算就停下并如实上报"还剩几步没做"，让 AI 再发一次 —— 绝不做到超时。
 */
const SEQ_BUDGET_MS = 8000;

/** 估算一步要花多久（用于"这一步做下去会不会撑爆预算"的前瞻）。 */
function estimateStepMs(step) {
  if (step.action === "drag") {
    return Math.max(50, Math.min(5000, Number(step.duration) || settings.smoothMoveMs || 400)) + 100;
  }
  if (step.action === "type") {
    const delay = Math.max(0, Math.min(100, Number(step.delayMs ?? settings.typeDelayMs ?? 4)));
    return String(step.text ?? "").length * (delay + 1) + 50;
  }
  if (step.action === "move" && step.smooth) return 600;
  return 60;
}

/**
 * 批量提前收尾 —— 统一出口，保证"做到哪、剩什么"始终如实上报。
 *
 * ⚠️ `remaining` 会**修正停在半途的那个 repeat 步骤**：若某步声明 `repeat:200` 而
 * 只做到第 163 次就停了，remaining 里那步会被改写成 `repeat:37`。不改的话 AI 直接
 * 重发会把已经做过的 163 次**再做一遍**（比如多按 163 次方向键）。
 *
 * `note` 反复强调"已执行的都已生效，不要重做" —— 同理，防 AI 看到 ok:false
 * 就以为整批失败而整批重发。
 *
 * @param halfStep 停在半途的步骤信息（`{ index, doneRounds }`）—— 停在步与步之间时不传
 */
function seqStop(kind, results, remaining, error, started, halfStep) {
  let rem = remaining;
  if (halfStep && halfStep.doneRounds > 0 && remaining.length > 0) {
    const declared = Math.max(1, Math.min(SEQ_MAX_REPEAT, Number(remaining[0].repeat) || 1));
    const left = declared - halfStep.doneRounds;
    rem = left > 0
      ? [{ ...remaining[0], repeat: left }, ...remaining.slice(1)]
      : remaining.slice(1);
  }

  return {
    ok: false,
    stopped: kind,                         // step_failed | budget | invalid
    executed: results.length,              // 已执行的动作数（repeat 展开后的）
    failedStep: results.length + 1,
    remaining: rem,
    elapsedMs: Date.now() - started,
    results,
    error,
    note: "已执行的步骤都已生效，**不要重做**。" +
      (kind === "budget"
        ? "把 remaining 里没做的再发一次即可（半途那步的 repeat 已改成剩余次数）。"
        : "请先检查失败原因再决定怎么办。"),
  };
}

/**
 * 批量执行一串动作。
 *
 * 为什么需要：**慢的不是插件执行**（那是毫秒级），而是每步都要等 AI 想一轮
 * （模型生成下一个 tool call 要 1~3 秒）。"点击 → 输入 → 回车"三连分三次调用，
 * 光往返就 3~9 秒；合成一次则在毫秒级做完。
 *
 * 设计要点：
 * - **每步都过 guard**（急停 + 前台窗口检查）—— 不能只在开头查一次：执行途中可能
 *   弹出了确认框（前台变成宿主），后续步骤必须被拦，这正是防"AI 给自己授权"的机制
 * - **失败即停**：后续步骤可能依赖前面的（点输入框失败后输入密码会打到别处去）
 * - **超预算即停**：见 SEQ_BUDGET_MS 注释
 * - 不允许嵌套 sequence（防递归/失控）；允许 `abort`（它是安全出口）
 */
async function actSequence(args) {
  const steps = Array.isArray(args.steps) ? args.steps : null;
  if (!steps || steps.length === 0) throw new Error("sequence 需要非空的 steps 数组");
  if (steps.length > SEQ_MAX_STEPS) {
    throw new Error(`步骤太多（${steps.length}），单次最多 ${SEQ_MAX_STEPS} 步 —— 请分批发送`);
  }
  const gapMs = Math.max(0, Math.min(2000, Number(args.stepDelayMs ?? 30)));

  const started = Date.now();
  const results = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== "object" || typeof step.action !== "string") {
      return seqStop("invalid", results, steps.slice(i), `第 ${i + 1} 步缺少合法的 action`, started);
    }
    if (step.action === "sequence") {
      return seqStop("invalid", results, steps.slice(i),
        `第 ${i + 1} 步试图嵌套 sequence —— 不支持（会失控）。请把步骤平铺开`, started);
    }
    // abort 是安全出口，允许出现在序列里
    if (step.action === "abort") {
      setAborted("AI 在批量执行中主动停止");
      return { ok: true, executed: results.length, total: steps.length, aborted: true, results,
        note: "已在第 " + (i + 1) + " 步停止。请在面板点「解除急停」后才能继续。" };
    }
    if (!ACTIONS[step.action]) {
      return seqStop("invalid", results, steps.slice(i), `未知 action: ${step.action}`, started);
    }

    const repeat = Math.max(1, Math.min(SEQ_MAX_REPEAT, Number(step.repeat) || 1));

    for (let r = 0; r < repeat; r++) {
      // 预算前瞻：这步做下去会不会超宿主超时？会就停在这里（宁可少做，不可超时）
      const used = Date.now() - started;
      if (used + estimateStepMs(step) > SEQ_BUDGET_MS) {
        return seqStop("budget", results, steps.slice(i),
          `已用 ${used}ms，再执行会超出 ${SEQ_BUDGET_MS}ms 预算（工具调用硬超时是 10 秒，` +
          `超了宿主会报 timeout 而操作其实还在做 → 你会误判失败并重做）。`,
          started, { index: i, doneRounds: r });
      }

      // 每次重复都重新过 guard —— 急停与前台窗口状态在执行途中会变
      currentAction = `${describeStep(step.action, step)} · ${i + 1}/${steps.length}`;
      if (r === 0) noteActivity(step.action, step);   // 每步记一次（不是每次重复，免得刷屏）
      try {
        guard(step.action);
        const out = await ACTIONS[step.action](step);
        results.push({ step: i + 1, action: step.action, ...(repeat > 1 ? { round: r + 1 } : {}), ...out });
      } catch (e) {
        if (e instanceof AbortError) throw e;   // 急停：抛给外层统一成"已急停"
        return seqStop("step_failed", results, steps.slice(i), String((e && e.message) || e), started);
      }
      if (gapMs) await sleep(gapMs);
    }
  }

  return {
    ok: true,
    // executed 是**动作次数**（repeat 展开后），totalActions 是同一维度的总数 ——
    // 别拿它和 steps.length（步数）比，那会让 AI 看到 "7/3" 这种莫名其妙的数
    executed: results.length,
    totalActions: steps.reduce((n, s) => n + Math.max(1, Math.min(SEQ_MAX_REPEAT, Number(s.repeat) || 1)), 0),
    steps: steps.length,
    elapsedMs: Date.now() - started,
    results,
  };
}

/**
 * 移动指示窗（用户要求：AI 发现它挡住操作时自己挪开）。
 *
 * 窗口是宿主建的，进程只能**请求**宿主移动 —— 响应里带 `host: [{kind:"move-indicator"}]`，
 * 宿主（mcpBridge）会派发。坐标用绝对像素；也可给 `dx`/`dy` 相对**当前窗口位置**偏移。
 */
function actMoveIndicator(args) {
  const cur = indicatorRect();
  let x, y;
  if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
    x = Math.round(Number(args.x));
    y = Math.round(Number(args.y));
  } else if (Number.isFinite(Number(args.dx)) || Number.isFinite(Number(args.dy))) {
    if (!cur) throw new Error("指示窗当前不在（未打开），无法按相对位置移动");
    x = cur.x + Math.round(Number(args.dx) || 0);
    y = cur.y + Math.round(Number(args.dy) || 0);
  } else {
    throw new Error("move_indicator 需要 x/y（绝对）或 dx/dy（相对当前位置）");
  }
  // 简单边界保护：别让它跑到离谱的地方找不回来
  if (Math.abs(x) > 30000 || Math.abs(y) > 30000) {
    throw new Error(`目标位置 (${x},${y}) 超出合理范围 —— 请给屏幕内的坐标`);
  }
  return {
    ok: true,
    movedTo: { x, y },
    from: cur,
    host: [{ kind: "move-indicator", payload: { x, y } }],
    note: "指示窗已移动（宿主执行）。若仍挡住目标区域，可再调整。",
  };
}

/** 会真正操作鼠标键盘的动作 —— 这些要串行（见 withOpLock）。 */
const OPERATE_ACTIONS = new Set(["move", "click", "drag", "scroll", "key", "type", "sequence"]);

/** action → 实现（只读与急停豁免前置检查，见 guard）。 */
const ACTIONS = {
  screen_info: actScreenInfo,
  move: actMove,
  click: actClick,
  drag: actDrag,
  scroll: actScroll,
  key: actKey,
  type: actType,
  sequence: actSequence,
  move_indicator: actMoveIndicator,
};

// ── HTTP ─────────────────────────────────────────────────────────

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

/** 跑一个 action（统一错误→结构化返回，AI 需要看到原因而不是"服务器错误"）。 */
async function runAction(action, args) {
  // sequence 不在这一层记活动 —— 它每步自己记（否则列表里只有一条"序列"，
  // 看不出到底做了什么）
  if (action !== "sequence") {
    currentAction = describeStep(action, args);
    if (action !== "screen_info") noteActivity(action, args);   // 读屏幕信息不算"操作"
  }
  try {
    guard(action);
    if (action === "abort") {
      setAborted("AI 主动请求停止");
      return { ok: true, aborted: true, note: "已停止。请在面板点「解除急停」后才能继续操作。" };
    }
    const fn = ACTIONS[action];
    if (!fn) {
      return { ok: false, error: `未知 action: ${action}（可用：${Object.keys(ACTIONS).join(", ")}, abort）` };
    }
    // 会用鼠标键盘的动作走串行锁：异步化之后并发调用会在 await 处交错
    // （一个的"按住"和另一个的"移动"搅在一起）。只读/自停/挪窗不需要。
    if (OPERATE_ACTIONS.has(action)) {
      return await withOpLock(describeStep(action, args), () => fn(args || {}));
    }
    return await fn(args || {});
  } catch (e) {
    if (e instanceof AbortError) {
      return { ok: false, aborted: true, error: `已急停（${abortReason}）。请在面板点「解除急停」后再试。` };
    }
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    currentAction = "";
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const route = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    });
    return res.end();
  }

  try {
    // AI 的工具调用（宿主转发）—— 固定契约 { tool, args, settings } → { ok, ... }
    if (route === "/__mcp" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      mergeSettings(body.settings);
      const args = body.args && typeof body.args === "object" ? body.args : {};
      if (body.tool !== "control") {
        return json(res, 200, { ok: false, error: `未知工具: ${body.tool}（本插件只提供 control）` });
      }
      // 指示窗：AI 开始操作时请宿主把它亮出来（用户要求"AI 操作时自动出现"）。
      // **已存在就不重复请求** —— open 是"关掉重建"，重复请求会让窗口闪。
      const host = [];
      if (settings.showIndicator !== false && !indicatorRect()) {
        host.push({
          kind: "open-indicator",
          payload: {
            src: "indicator.html",
            params: `port=${actualPort()}`,
            width: INDICATOR_W,
            height: INDICATOR_H,
          },
        });
      }
      // ── 输入锁定（AI 声明独占时）──
      // `lock` 是**整次调用**的属性：AI 在动手前声明"这个长操作别打扰我"。
      // 见"输入锁定"一节的完整说明（为什么是租约、为什么用钩子而不是 BlockInput）。
      const lockScope = normalizeLockScope(args.lock);
      let lockJustInstalled = false;
      if (lockScope !== "none") {
        if (lockState.active) {
          renewLock();                    // 已锁着 → 续期（AI 又发了一批，说明还在干）
        } else {
          const got = installLock(lockScope);
          lockJustInstalled = got !== "none";
          if (got === "none") {
            log(`警告：锁不上输入（钩子安装失败），本次操作不独占（lock=${lockScope}）`);
          }
        }
      }
      // 无论是否声明 lock，只要锁是活的就续期 —— 保证"已经在锁"的任务不会因
      // 某一批操作忘了带 lock 参数而被租约收走。**另外**指示窗轮询 /activity 也会续。
      renewLock();

      const out = await runAction(args.action, args);

      // 收集插件请求的宿主动作。**sequence 的每步也要看** —— 里面可能有
      // `move_indicator`（那一步的 host 挂在 results 里，不上抛的话永远不会执行）。
      const collect = (o) => {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o.host)) host.push(...o.host);
        if (Array.isArray(o.results)) for (const r of o.results) collect(r);
      };
      collect(out);

      // 锁定状态一并回给 AI（它要据此知道用户是否已接管、还剩多少租约）
      const extra = {};
      const snap = lockSnapshot();
      if (snap.locked || lockJustInstalled) {
        extra.lock = {
          scope: snap.lockScope,
          remainMs: snap.lockRemainMs,
          escapeKey: snap.escapeKey,
          note: "用户按住 Ctrl+Q 可强行接管（届时本操作会立即停下，且需用户重新下指令）。",
        };
      }
      return json(res, 200, { ...out, ...extra, ...(host.length ? { host } : {}) });
    }

    // 面板：急停
    if (route === "/abort" && req.method === "POST") {
      setAborted("用户在面板按下停止");
      return json(res, 200, { ok: true, aborted: true, reason: abortReason });
    }
    // 锁定租约续期（指示窗在 AI 活跃期间调）。
    //
    // ⚠️ **必须带"AI 真的活跃"这个门槛**，不能只因为有请求就续 —— 否则一个
    // 卡住的页面/别的本地程序就能让锁永不过期，"忘了解锁自动解开"的兜底就废了。
    // 判定用服务端自己的 lastActivityAt（进程在每次操作时更新），请求方无从伪造。
    if (route === "/lock/renew" && req.method === "POST") {
      const activeNow = !!currentAction
        || (lastActivityAt > 0 && Date.now() - lastActivityAt < ACTIVE_WINDOW_MS);
      if (!lockState.active || !activeNow) {
        return json(res, 200, { ok: true, renewed: false, reason: lockState.active ? "AI 已不活跃" : "未锁定" });
      }
      renewLock();
      return json(res, 200, { ok: true, renewed: true, remainMs: lockSnapshot().lockRemainMs });
    }
    // 面板：解除急停
    if (route === "/resume" && req.method === "POST") {
      clearAbort();
      return json(res, 200, { ok: true, aborted: false });
    }
    // 面板：释放全部按下的键与按钮
    if (route === "/release" && req.method === "POST") {
      releaseAll();
      return json(res, 200, { ok: true, heldKeys: [...heldKeys], heldButtons: [...heldButtons] });
    }
    // 指示窗轮询：既拿状态，也**借此证明自己还活着**（进程据此决定要不要
    // 重新请求开窗 —— 见 /__mcp 的处理）。
    if (route === "/activity" && (req.method === "GET" || req.method === "POST")) {
      // ⚠️ **这个接口绝不能续期**（曾经加过，是个真 bug）：它是**只读**的状态查询，
      // 而指示窗每 250ms 就轮询一次 —— 在这里 renew 会让租约**永远不过期**，
      // "忘了解锁自动解开"的兜底直接失效（实测：remaining 恒为 10000ms 不减少）。
      // 续期是**显式**行为，走独立的 /lock/renew（由指示窗在 AI 活跃时调）。
      const pos = mousePos();
      return json(res, 200, {
        ok: true,
        aborted,
        abortReason,
        currentAction,
        // **活跃** = 有操作正在进行，或刚操作过（见 ACTIVE_WINDOW_MS）。
        // 指示窗用它显示"操作中/空闲" —— 别让它自己看 currentAction 判断，
        // 那玩意在窗口出现时早就空了（原因见 ACTIVE_WINDOW_MS 注释）。
        active: !!currentAction || (lastActivityAt > 0 && Date.now() - lastActivityAt < ACTIVE_WINDOW_MS),
        log: activityLog.slice(-8).reverse(),      // 最近几条，新的在前
        count: actionCount,
        uptimeMs: Date.now() - sessionStart,
        lastActivityMs: lastActivityAt ? Date.now() - lastActivityAt : null,
        mouse: pos,
        ...lockSnapshot(),                          // locked / lockScope / lockRemainMs / escapeKey
      });
    }

    // 面板：状态
    if (route === "/status" && req.method === "GET") {
      const pos = mousePos();
      return json(res, 200, {
        ok: true,
        aborted,
        abortReason,
        currentAction,
        mouse: pos,
        heldKeys: [...heldKeys],
        heldButtons: [...heldButtons],
        ...lockSnapshot(),
        blockHostWindows: settings.blockHostWindows !== false,
        hostPidKnown: !!Number(process.env.CLAUDE_PLUGIN_HOST_PID),
        platform: process.platform,
      });
    }
    if (route === "/settings" && req.method === "PUT") {
      const body = JSON.parse((await readBody(req)) || "{}");
      mergeSettings(body.settings);
      return json(res, 200, { ok: true, settings });
    }

    return json(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    log("请求处理异常:", e && e.stack || e);
    return json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

// ── 启动 ─────────────────────────────────────────────────────────

const requestedPort = Number(process.env.PLUGIN_PORT) || 0;
/** 首次尝试的端口：宿主可以指定，缺省用 41000（好认）。 */
const DEFAULT_PORT = 41000;

/**
 * 进程实际监听的端口。
 *
 * 端口可能不是请求的那个（被占用时会换），所以别用 `requestedPort` ——
 * 指示窗页面要靠这个端口回来轮询，给错了它会一直连不上。
 */
function actualPort() {
  const a = server.address();
  return a && typeof a === "object" ? a.port : 0;
}

/**
 * 监听，**保证无论如何都能起来**。
 *
 * ## 为什么端口被占时必须退到 `0`（系统分配），而不是"在范围内重试"
 *
 * **多开 GUI 时每个实例都会起一份本插件进程**，它们默认都要同一个端口。
 * 范围重试会在第 3 个实例上耗尽然后启动失败（实测踩到，用户开了 3 个 GUI）：
 *   实例1 抢到 41000 ✓｜实例2 退到 42000 ✓｜实例3 两个都被占 → 失败退出 ✗
 * → 宿主报「后台进程未运行」，这个实例里工具整个用不了。
 *
 * 而插件端口**不需要固定**：契约是"stdout 第一行报 PLUGIN_PORT"，宿主读它就知道
 * 去哪找。所以 `listen(0)` 让系统随便给一个，是最稳的兜底。
 *
 * ## ⚠️ `started` 标志是必须的（不是防御性代码）
 *
 * Node 的行为：`server.listen()` 失败后再次 `listen()`，**第一次挂着的 'listening'
 * 回调仍然会执行** —— 于是两个回调都打印 `PLUGIN_PORT=`，**破坏"stdout 只一行"的
 * 宿主协议**（宿主读完第一行就停止读 stdout，第二行会 EPIPE）。实测踩到过：
 * 日志里整个启动序列打印了两遍。
 */
let started = false;
let retriedWithSystemPort = false;

server.on("error", (err) => {
  if (started) {
    // 运行期错误（非启动期）—— 记下来即可，不要退出
    log("运行期 server 错误:", err && err.message);
    return;
  }
  if (err.code === "EADDRINUSE" && !retriedWithSystemPort) {
    retriedWithSystemPort = true;
    log(`端口 ${requestedPort || DEFAULT_PORT} 被占用（多开 GUI 时正常）→ 改用系统分配端口`);
    server.listen(0, "127.0.0.1");
    return;
  }
  // 连系统分配都失败（极罕见：句柄/内存耗尽）→ 如实上报，宿主会显示"进程已停止"
  log("监听失败:", err && err.message);
  console.log("PLUGIN_PORT=0");
  process.exit(1);
});

server.listen(requestedPort || DEFAULT_PORT, "127.0.0.1", () => {
  if (started) return;   // 见上方注释：首次 listen 失败后它的回调仍挂着
  started = true;
  const actual = server.address().port;
  // ⚠️ stdout 只此一行（见文件头约束 1）
  console.log(`PLUGIN_PORT=${actual}`);
  log(`listening on 127.0.0.1:${actual}; platform=${process.platform}; ` +
      `hostPid=${process.env.CLAUDE_PLUGIN_HOST_PID || "(未注入)"}; ` +
      `escapeKey=Ctrl+Q`);
});

// ── 退出清理 ──────────────────────────────────────────────────────
//
// 无论怎么退出，都要做两件事：
//   ① 把按下的键/按钮抬起来 —— 否则系统层面它们一直是按下的（见 releaseAll 注释）
//   ② **解除输入锁定** —— 钩子虽然会随进程退出被系统自动卸载，但显式解开更明确
//      （且正常退出的路径上应该立刻让用户恢复对键鼠的控制）
// 硬杀（宿主 prockill）走不到这里：那种情况下钩子由系统自动清理，且租约到期也会
// 兜底（见 LOCK_LEASE_MS）—— 两道保险都不依赖本进程活着。
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    log(`收到 ${sig}，释放按键/解锁后退出`);
    try { uninstallLock(true); } catch { /* 退出路径尽力而为 */ }
    releaseAll();
    process.exit(0);
  });
}
process.on("exit", () => {
  try { uninstallLock(true); } catch { /* 退出路径尽力而为 */ }
  try { releaseAll(); } catch { /* 退出路径尽力而为 */ }
});
