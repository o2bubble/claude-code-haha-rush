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
  abortHotkey: "ctrl+alt+shift+f12",
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

// ── 急停轮询 ──────────────────────────────────────────────────────
//
// **只在有操作进行时**轮询（空闲时不占 CPU）。默认 ctrl+alt+shift+f12 —— 三修饰键
// + F12 极少被别的软件占用，且用户单手可及。
//
// 为什么不用"注册全局热键"：那是 OS 进程级独占的，多开 GUI 时只有先注册的实例
// 能用（用户正是因为这个把截屏热键改成了窗口内）。而**急停必须任何情况都能用**。

/** 键名 → VK 码（只列急停可能用到的）。 */
const VK = {
  ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10,
  win: 0x5b,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
  escape: 0x1b, esc: 0x1b,
};

function parseHotkey(spec) {
  const parts = String(spec || "").toLowerCase().split("+").map((s) => s.trim()).filter(Boolean);
  const codes = [];
  for (const p of parts) {
    const vk = VK[p] ?? (/^[a-z]$/.test(p) ? p.toUpperCase().charCodeAt(0) : undefined);
    if (vk === undefined) return null;   // 无法解析 → 急停禁用（面板会显示）
    codes.push(vk);
  }
  return codes.length ? codes : null;
}

/** 急停组合当前是否被按住。 */
function abortHotkeyDown() {
  if (!w32) return false;
  const codes = parseHotkey(settings.abortHotkey);
  if (!codes) return false;
  for (const vk of codes) {
    // GetAsyncKeyState 高字节 = 当前是否按下。返回类型声明为 uint16，故直接比 0x8000。
    if (!(w32.getAsyncKeyState(vk) & 0x8000)) return false;
  }
  return true;
}

/**
 * 在长操作期间轮询急停；被按下则抛错中断。
 *
 * 只在操作循环里调用（`drag` 的每一步、`type` 的每个字符）—— 短操作（一次点击）
 * 不需要，也来不及按。
 */
function checkAbort() {
  if (aborted) throw new AbortError();
  if (abortHotkeyDown()) {
    setAborted("用户按下急停键");
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

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
  if (t) robot.moveMouse(t.x, t.y);
  const before = mousePos();
  robot.mouseClick(btn, !!args.double);
  return { ok: true, clicked: btn, double: !!args.double, at: before };
}

function actDrag(args) {
  const fx = Math.round(Number(args.fromX)), fy = Math.round(Number(args.fromY));
  const tx = Math.round(Number(args.toX)), ty = Math.round(Number(args.toY));
  if (![fx, fy, tx, ty].every(Number.isFinite)) {
    throw new Error("drag 需要数字 fromX / fromY / toX / toY");
  }
  const btn = (args.button === "right" || args.button === "middle") ? args.button : "left";
  const dur = Math.max(50, Math.min(5000, Number(args.duration) || settings.smoothMoveMs || 400));

  robot.moveMouse(fx, fy);
  robot.mouseToggle("down", btn);
  heldButtons.add(btn);
  try {
    sleepSync(50);   // 按下后停一下再动 —— 有些应用需要时间进入拖拽态
    const steps = Math.max(8, Math.min(150, Math.round(dur / 12)));
    const stepMs = Math.round(dur / steps);
    for (let i = 1; i <= steps; i++) {
      checkAbort();   // 每一步都可中断
      const t = i / steps;
      robot.moveMouse(
        Math.round(fx + (tx - fx) * t),
        Math.round(fy + (ty - fy) * t),
      );
      sleepSync(stepMs);
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
function actType(args) {
  const text = String(args.text ?? "");
  if (!text) throw new Error("type 需要非空 text");
  const delay = Math.max(0, Math.min(100, Number(args.delayMs ?? settings.typeDelayMs ?? 4)));
  let typed = 0;

  for (let i = 0; i < text.length; i++) {
    checkAbort();   // 长文本可中断
    const code = text.charCodeAt(i);
    if (code === 0) continue;                  // U+0000 会让 unicodeTap 抛异常
    if (code === 13) continue;                 // \r —— 与 \n 重复，跳过
    if (code === 10) { robot.keyTap("enter"); typed++; sleepSync(delay); continue; }
    if (code === 9) { robot.keyTap("tab"); typed++; sleepSync(delay); continue; }
    robot.unicodeTap(code);
    typed++;
    sleepSync(delay);
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
function actSequence(args) {
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
      currentAction = `sequence ${i + 1}/${steps.length}${repeat > 1 ? ` ×${r + 1}/${repeat}` : ""}: ${step.action}`;
      try {
        guard(step.action);
        const out = ACTIONS[step.action](step);
        results.push({ step: i + 1, action: step.action, ...(repeat > 1 ? { round: r + 1 } : {}), ...out });
      } catch (e) {
        if (e instanceof AbortError) throw e;   // 急停：抛给外层统一成"已急停"
        return seqStop("step_failed", results, steps.slice(i), String((e && e.message) || e), started);
      }
      if (gapMs) sleepSync(gapMs);
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
function runAction(action, args) {
  currentAction = action;
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
    return fn(args || {});
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
      return json(res, 200, runAction(args.action, args));
    }

    // 面板：急停
    if (route === "/abort" && req.method === "POST") {
      setAborted("用户在面板按下停止");
      return json(res, 200, { ok: true, aborted: true, reason: abortReason });
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
        abortHotkey: settings.abortHotkey,
        abortHotkeyValid: !!parseHotkey(settings.abortHotkey),
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
const PORT_RANGE = [0, 41000, 42000];   // 0 = 由系统分配，再在范围内重试

function listen(port, attempt = 0) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && attempt < 2) {
      log(`端口 ${port} 被占用，换一个再试`);
      listen(PORT_RANGE[attempt + 1] || 0, attempt + 1);
      return;
    }
    log("监听失败:", err && err.message);
    console.log("PLUGIN_PORT=0");
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    const actual = server.address().port;
    // ⚠️ stdout 只此一行（见文件头约束 1）
    console.log(`PLUGIN_PORT=${actual}`);
    log(`listening on 127.0.0.1:${actual}; platform=${process.platform}; ` +
        `hostPid=${process.env.CLAUDE_PLUGIN_HOST_PID || "(未注入)"}; ` +
        `abortHotkey=${settings.abortHotkey}`);
  });
}

listen(requestedPort || PORT_RANGE[1]);

// ── 退出清理 ──────────────────────────────────────────────────────
//
// 无论怎么退出，都要把按下的键/按钮抬起来 —— 否则系统层面它们一直是按下的
// （见 releaseAll 注释）。硬杀（宿主 prockill）走不到这里，由面板的「释放」兜底。
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    log(`收到 ${sig}，释放按键后退出`);
    releaseAll();
    process.exit(0);
  });
}
process.on("exit", () => {
  try { releaseAll(); } catch { /* 退出路径上尽力而为 */ }
});
