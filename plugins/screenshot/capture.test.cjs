// ── 截图链路的静态约束 ──
//
// 2026-10-27 用户反馈「点截图到 overlay 弹出要 1.x 秒」。
// 根因有两个，都在这里锁住，防止以后改回去：
//
//   ① **两次 PowerShell 进程**（hideHost 一次 + captureWindows 一次），
//      每次空进程就要 227ms，白烧 200ms+
//   ② 用 `SW_MINIMIZE` 会产生最小化动画，代码里只能**固定 sleep 380ms**
//      等动画播完。实测 `SW_HIDE` 是瞬间生效的（4ms、无动画），
//      窗口直接从画面消失 —— 那 380ms 完全可以省掉。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "server.cjs"), "utf8");

test("让位与抓屏合并成一个 PowerShell 进程（别退回两次进程）", () => {
  // hideAndCapture 必须存在，且脚本里同时做 Hide + CopyFromScreen
  assert.ok(/async function hideAndCapture/.test(SRC), "应存在 hideAndCapture");

  const fn = SRC.slice(
    SRC.indexOf("async function hideAndCapture"),
    SRC.indexOf("async function captureWindows"),
  );
  // 隐藏动作在模板字符串里（[SnipWin]::Hide 的调用点是 HIDE_SCRIPT_BODY）
  assert.ok(/HIDE_SCRIPT_BODY\(pid\)/.test(fn), "hideAndCapture 应调 HIDE_SCRIPT_BODY 隐藏宿主");
  assert.ok(/CopyFromScreen/.test(fn), "hideAndCapture 内部应抓屏");
  // 只允许一次 powershell 调用
  const calls = (fn.match(/run\(\s*"powershell"/g) || []).length;
  assert.strictEqual(calls, 1, `hideAndCapture 应只起 1 个 powershell 进程，实际 ${calls}`);

  const hideFn = SRC.slice(
    SRC.indexOf("function HIDE_SCRIPT_BODY"),
    SRC.indexOf("const SNIP_CSHARP"),
  );
  assert.ok(/\[SnipWin\]::Hide/.test(hideFn), "HIDE_SCRIPT_BODY 应调用 [SnipWin]::Hide");
});

test("区域/窗口命令不再额外调 hideHost（会变成两次进程）", () => {
  // 找 /__command 分支里 region/window 那段
  const idx = SRC.indexOf('if ((cmd === "region" || cmd === "window") && IS_WIN)');
  assert.ok(idx > 0, "找不到 region/window 分支");
  const block = SRC.slice(idx, idx + 600);
  assert.ok(
    !/await hideHost\(\)/.test(block),
    "这里不能再调 hideHost —— prepareRegion 内部已经隐藏过了",
  );
  assert.ok(/prepareRegion/.test(block), "应调用 prepareRegion");
});

test("用 SW_HIDE(0) 而不是 SW_MINIMIZE(6) —— 瞬间生效，无动画可等", () => {
  const fn = SRC.slice(
    SRC.indexOf("const SNIP_CSHARP"),
    SRC.indexOf("async function hideAndCapture"),
  );
  assert.ok(/ShowWindow\(h, 0\)/.test(fn), "应使用 SW_HIDE(0)");
  assert.ok(
    !/ShowWindow\(h, 6\)/.test(fn),
    "不该再用 SW_MINIMIZE(6) —— 它会产生动画，逼着我们固定 sleep",
  );
});

test("恢复用 SW_SHOW + SW_RESTORE（SW_HIDE 的对偶）", () => {
  const idx = SRC.indexOf("function RESTORE_HOST_SCRIPT");
  const end = SRC.indexOf("// ── 抓屏", idx);
  const fn = SRC.slice(idx, end > idx ? end : idx + 1600);
  assert.ok(/SW_SHOW = 5/.test(fn), "恢复脚本应定义 SW_SHOW");
  assert.ok(/ShowWindow\(h, SW_SHOW\)/.test(fn), "应先 SW_SHOW 撤销隐藏");
  assert.ok(/ShowWindow\(h, SW_RESTORE\)/.test(fn), "再 SW_RESTORE 兜底最小化态");
});

test("屏幕尺寸在抓屏前读取（DPI 生效后），不在脚本开头", () => {
  // 顺序错了会拿到逻辑尺寸 —— 150% 缩放下图变小、坐标全偏。
  const fn = SRC.slice(
    SRC.indexOf("async function hideAndCapture"),
    SRC.indexOf("async function captureWindows"),
  );
  const dpiPos = fn.indexOf("[SnipWin]::EnableDpi()");
  const boundsPos = fn.indexOf("$b = $scr.Bounds");
  assert.ok(dpiPos > 0 && boundsPos > 0, "应在脚本里找到 DPI 与 Bounds");
  assert.ok(dpiPos < boundsPos, "必须**先**设 DPI aware、**再**读 Screen.Bounds");
});

test("内嵌 C# 用单引号 here-string（避免 PS 5.1 按 GBK 转码）", () => {
  // 历史上踩过：把 C# 直接拼进双引号字符串 / 用 -File 跑含中文的 .ps1，
  // PowerShell 5.1 会按系统代码页（GBK）解码，导致内嵌 C# 编译失败且报错
  // 极具误导（"名称不存在"、行号指向空行）。
  //
  // 现在的写法是单引号 here-string `@'...'@` —— **不做变量展开、不改编码**，
  // C# 拿到原始字节，所以中英文注释都安全（已实测编译通过）。
  // 这条测试锁住"必须用单引号 here-string"这个前提。
  const csIdx = SRC.indexOf("Add-Type -TypeDefinition @'");
  assert.ok(csIdx > 0, "内嵌 C# 必须接在单引号 here-string `@'` 之后");

  // 不能改成双引号 here-string（`@"`）：那会展开 `$` 且按代码页转码
  const fn = SRC.slice(
    SRC.indexOf("async function hideAndCapture"),
    SRC.indexOf("async function captureWindows"),
  );
  assert.ok(
    !/Add-Type -TypeDefinition @"[\s\S]*SNIP_CSHARP/.test(fn),
    "不能用双引号 here-string 包 SNIP_CSHARP",
  );
});

// ── 让位必须能恢复（2026-10-27 事故）──
//
// 用户实测：「截图自动隐藏了 GUI 后居然没有重新恢复，导致我找不到 GUI 了」
//
// 根因：prepareRegion 改成**总是**隐藏宿主窗口后，`/capture` 那条路径
// 仍然用 `overlayHostActions(prep, mode)`（第三个参数默认 false）→
// 不带 `hostPort` → 宿主不知道要恢复 → overlay 关掉后窗口一直藏着。

test("所有 open-overlay 路径都必须传 restoreOnClose", () => {
  const calls = SRC.match(/overlayHostActions\(prep, [^)]*\)/g) || [];
  assert.ok(calls.length >= 2, `应至少有两处调用，实际 ${calls.length}`);

  for (const c of calls) {
    // 传 3 个参数的才算正确（第三参 restoreOnClose）
    assert.ok(
      /overlayHostActions\(prep, \w+, [\s\S]*\)/.test(c),
      `调用缺少 restoreOnClose 参数：${c} —— 会让窗口永久隐藏`,
    );
  }
});

test("进程退出时兜底恢复窗口", () => {
  // overlay 没开起来 / 宿主漏调时，不能让窗口一直藏着
  assert.ok(/function restoreOnExit/.test(SRC), "应有 restoreOnExit 兜底");
  assert.ok(
    /process\.on\("exit", \(\) => { restoreOnExit\(\)/.test(SRC),
    "应在 process exit 时调用 restoreOnExit",
  );
  // 退出路径必须用同步调用（异步回调在 exit 阶段不会跑）
  const fn = SRC.slice(SRC.indexOf("function restoreOnExit"), SRC.indexOf("for (const sig of"));
  assert.ok(/spawnSync/.test(fn), "退出路径必须用 spawnSync（异步回调不会执行）");
});

// ── 隐藏必须禁用 DWM 过渡（2026-10-27 事故）──
//
// 用户实测：合并成一个 PowerShell 后，「ui 还没彻底隐藏你就截图了，然后截图半透明了」。
//
// 根因：`SW_HIDE` 会触发 DWM **淡出动画**（实测约 150ms）。动画期间抓屏会
// 拍到**半透明**的窗口残影。原方案固定 sleep 380ms 就是在等这个。
//
// 解法：`DWMWA_TRANSITIONS_FORCEDISABLED=1` 让 DWM 跳过过渡，
// 窗口**立即**从合成画面消失（实测亮度立刻到位），抓屏可以零等待。
// 恢复时必须把它设回 0，否则用户此后最小化窗口会没有动画（可察觉的副作用）。

test("隐藏前必须禁用 DWM 过渡（否则截图半透明）", () => {
  const cs = SRC.match(/const SNIP_CSHARP = `([\s\S]*?)`;/)[1];

  assert.ok(/DwmSetWindowAttribute/.test(cs), "SNIP_CSHARP 应调用 DwmSetWindowAttribute");
  assert.ok(
    /DWMWA_TRANSITIONS_FORCEDISABLED\s*=\s*3/.test(cs),
    "应定义 DWMWA_TRANSITIONS_FORCEDISABLED = 3",
  );

  // 关键：禁用过渡必须在 ShowWindow(h, 0) **之前**
  const hideFn = cs.slice(cs.indexOf("public static IntPtr[] Hide"), cs.indexOf("static bool Cb"));
  const dwmPos = hideFn.indexOf("DwmSetWindowAttribute");
  const hidePos = hideFn.indexOf("ShowWindow(h, 0)");
  assert.ok(dwmPos > 0 && hidePos > 0, "Hide 里应同时有 DWM 调用和 SW_HIDE");
  assert.ok(
    dwmPos < hidePos,
    "必须**先**禁用 DWM 过渡、**再** SW_HIDE —— 顺序反了照样会淡出",
  );
});

test("恢复时要把 DWM 过渡还原（否则用户窗口以后没有动画）", () => {
  const fn = SRC.slice(
    SRC.indexOf("function RESTORE_HOST_SCRIPT"),
    SRC.indexOf("// ── 抓屏"),
  );
  assert.ok(/DWMWA_TRANSITIONS_FORCEDISABLED/.test(fn), "恢复脚本应处理该属性");
  assert.ok(
    /int zero = 0/.test(fn) || /,\s*0,\s*sizeof/.test(fn),
    "恢复时应把值设回 0（启用过渡）",
  );
});

// ── koffi 原生路径（2026-10-27）──
//
// 背景：为了把截图从 570ms 降到 ~110ms，抓屏改成 koffi 直调 GDI（插件进程内），
// 不再起 powershell.exe。这里锁住几个"改回去就会出事"的点。

const WIN32_SRC = fs.readFileSync(path.join(__dirname, "win32.cjs"), "utf8");

test("koffi 指针转换必须用 koffi.as，不能用 koffi.decode", () => {
  // 🔴 事故：`koffi.decode(整数, "void*")` 会让**整个进程静默崩溃**
  // （不是抛异常，try/catch 接不住、也没日志）。
  // 后果是"恢复窗口"那步根本没跑 → 用户 GUI 一直藏着、找不到窗口。
  const codeLines = WIN32_SRC.split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))   // 排除注释
    .join("\n");
  assert.ok(
    !/koffi\.decode\s*\(/.test(codeLines),
    "不能用 koffi.decode 转指针 —— 会静默崩溃整个进程，请用 koffi.as",
  );
  assert.ok(/koffi\.as\(/.test(codeLines), "应在 showWindows 里用 koffi.as 还原句柄");
});

test("恢复窗口失败时不能丢掉句柄（否则无法回退 PowerShell）", () => {
  // restoreHost / restoreOnExit 都要先把句柄存到局部变量，
  // koffi 成功后才清空 hiddenHostWindows。先清空 + 再回退 = 回退拿不到句柄。
  for (const fnName of ["async function restoreHost", "function restoreOnExit"]) {
    const start = SRC.indexOf(fnName);
    assert.ok(start > 0, `找不到 ${fnName}`);
    const body = SRC.slice(start, start + 1200);
    const slicePos = body.indexOf(".slice()");
    const clearPos = body.indexOf("hiddenHostWindows = []");
    assert.ok(slicePos > 0, `${fnName} 应先复制一份句柄（.slice()）`);
    assert.ok(
      slicePos < clearPos,
      `${fnName} 不能先清空 hiddenHostWindows —— 回退路径还要用`,
    );
  }
});

test("隐藏窗口不能用 WS_EX_TOOLWINDOW 过滤（Tauri 主窗带这个样式）", () => {
  // 实测宿主主窗 exstyle=0x080800A0，含 WS_EX_TOOLWINDOW(0x80)。
  // 按它过滤就等于永远隐藏 0 个窗口 → 截图里全是 GUI。
  const fn = WIN32_SRC.slice(
    WIN32_SRC.indexOf("function hideProcessWindows"),
    WIN32_SRC.indexOf("function showWindows"),
  );
  assert.ok(/GetWindowRect/.test(fn), "应按尺寸过滤");
  assert.ok(
    !/WS_EX_TOOLWINDOW\s*\)\s*!==\s*0\)\s*return\s+true/.test(fn),
    "不该再用 WS_EX_TOOLWINDOW 过滤",
  );
});

test("koffi 不可用时回退到 PowerShell 路径（不能直接失败）", () => {
  assert.ok(/hideAndCaptureNative/.test(SRC), "应有 koffi 实现");
  assert.ok(/if \(!shot\) shot = await hideAndCapture/.test(SRC), "koffi 返回 null 时应回退");
  assert.ok(/win32\.available\(\)/.test(SRC), "应检查 koffi 可用性");
});

test("PNG 编码用低压缩级别（抓屏要的是快，不是最小体积）", () => {
  assert.ok(
    /deflateSync\(raw,\s*\{\s*level\s*\}\s*\)/.test(WIN32_SRC)
      || /deflateSync\(raw,\s*\{\s*level:\s*1\s*\}\)/.test(WIN32_SRC),
    "应使用可配置/低级别的 deflate（level 1）",
  );
  assert.ok(/encodePNG[\s\S]{0,200}level\s*=\s*1/.test(WIN32_SRC), "默认 level 应为 1");
});

// ── 恢复必须保持窗口原状态（2026-10-27 用户反馈）──
//
// 「截图后恢复窗口总是回到一个固定的窗口状态，但是我当前如果是全屏，
//   你应该恢复到全屏啊」
//
// 根因：只用 SW_SHOW + SW_RESTORE 恢复，这两个都只还原到「还原态」。
// 实测最大化窗口：showCmd 3→1，rect 从 -11,-11 2582x1562 变成小窗。

test("隐藏前必须保存窗口放置状态（GetWindowPlacement）", () => {
  assert.ok(
    /GetWindowPlacement:\s*bind/.test(WIN32_SRC),
    "应绑定 GetWindowPlacement",
  );
  const fn = WIN32_SRC.slice(
    WIN32_SRC.indexOf("function hideProcessWindows"),
    WIN32_SRC.indexOf("function showWindows"),
  );
  assert.ok(/GetWindowPlacement\(hwnd, wp\)/.test(fn), "隐藏前应保存放置状态");

  // 保存必须在 SW_HIDE 之前（隐藏后就拿不到原始状态了）
  const savePos = fn.indexOf("GetWindowPlacement(hwnd, wp)");
  const hidePos = fn.indexOf("SW_HIDE");
  assert.ok(savePos > 0 && hidePos > 0 && savePos < hidePos, "必须先保存状态、再隐藏");
});

test("恢复时必须用 SetWindowPlacement 还原（不能只靠 SW_SHOW）", () => {
  assert.ok(/SetWindowPlacement:\s*bind/.test(WIN32_SRC), "应绑定 SetWindowPlacement");

  const fn = WIN32_SRC.slice(
    WIN32_SRC.indexOf("function showWindows"),
    WIN32_SRC.indexOf("module.exports"),
  );
  assert.ok(/SetWindowPlacement\(hwnd, wp\)/.test(fn), "恢复时应按保存的状态还原");

  // SetWindowPlacement 优先于通用的 SW_SHOW 兜底
  const setPos = fn.indexOf("SetWindowPlacement(hwnd, wp)");
  const showPos = fn.indexOf("ShowWindow(hwnd, SW_SHOW)");
  assert.ok(setPos > 0 && showPos > 0, "两条路径都应存在");
  assert.ok(setPos < showPos, "有保存状态时应优先 SetWindowPlacement，SW_SHOW 只做兜底");
});

test("隐藏状态要随句柄一起存下来（否则恢复时找不到）", () => {
  const fn = WIN32_SRC.slice(
    WIN32_SRC.indexOf("function hideProcessWindows"),
    WIN32_SRC.indexOf("function showWindows"),
  );
  assert.ok(/hiddenPlacements\s*=/.test(fn), "hideProcessWindows 应填充 hiddenPlacements");

  const showFn = WIN32_SRC.slice(
    WIN32_SRC.indexOf("function showWindows"),
    WIN32_SRC.indexOf("module.exports"),
  );
  assert.ok(/savedById/.test(showFn), "showWindows 应按 id 取回保存的状态");
});
