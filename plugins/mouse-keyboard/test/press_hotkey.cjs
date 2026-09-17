/**
 * 测试辅助：模拟"用户按住急停组合键"（用 koffi SendInput 发键盘事件）。
 *
 * 用法：node press_hotkey.cjs <down|up> [ms]
 *   down  → 按下 ctrl+alt+shift+f12 并保持
 *   up    → 全部抬起
 */
// koffi 从插件的 vendor 里取（插件自带的那个二进制，免 npm 依赖）
const path = require("node:path");
const koffi = require(path.join(__dirname, "..", "vendor", "win32-x64", "koffi.node"));

const KEYBDINPUT = koffi.struct("KEYBDINPUT", {
  wVk: "uint16", wScan: "uint16", dwFlags: "uint32",
  time: "uint32", dwExtraInfo: "uintptr_t",
});
const MOUSEINPUT = koffi.struct("MOUSEINPUT", {
  dx: "int32", dy: "int32", mouseData: "uint32",
  dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr_t",
});
const HARDWAREINPUT = koffi.struct("HARDWAREINPUT", {
  uMsg: "uint32", wParamL: "uint16", wParamH: "uint16",
});
const UNION = koffi.union("INPUTUNION", {
  mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT,
});
const INPUT = koffi.struct("INPUT", { type: "uint32", u: UNION });

const user32 = koffi.load("user32.dll");
const SendInput = user32.func("uint32 SendInput(uint32 nInputs, INPUT* pInputs, int cbSize)");

const KEYEVENTF_KEYUP = 0x0002;
const VKS = [0x11, 0x12, 0x10, 0x7B];   // ctrl, alt, shift, f12

function key(vk, up) {
  return { type: 1, u: { ki: { wVk: vk, wScan: 0, dwFlags: up ? KEYEVENTF_KEYUP : 0, time: 0, dwExtraInfo: 0 } } };
}

const mode = process.argv[2] || "down";

if (mode === "down") {
  const inputs = VKS.map((vk) => key(vk, false));
  const n = SendInput(inputs.length, inputs, INPUT.size);
  console.log(`已按住 ctrl+alt+shift+f12（SendInput 返回 ${n}，INPUT.size=${INPUT.size}）`);
  // 保持按住，直到被 kill 或收到信号
  const hold = Number(process.argv[3]) || 4000;
  setTimeout(() => {
    const ups = VKS.map((vk) => key(vk, true));
    SendInput(ups.length, ups, INPUT.size);
    console.log(`已抬起（保持 ${hold}ms）`);
    process.exit(0);
  }, hold);
} else {
  const ups = VKS.map((vk) => key(vk, true));
  SendInput(ups.length, ups, INPUT.size);
  console.log("已抬起全部");
}
