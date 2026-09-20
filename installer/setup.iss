; Claude Code Haha 安装程序脚本
; 需要 Inno Setup 6+ (https://jrsoftware.org/isdl.php)
;
; 用法（**推荐**经 installer\build.ps1 调用，它会从 dist\manifest.json 读版本）：
;   ISCC.exe installer\setup.iss /DMyAppVersion=2026.09.20.6

#define MyAppName "Claude Code Haha"
#define MyAppPublisher "Claude Code Local"
#define MyAppURL "https://gitee.com/randomlife/claude-code-haha-dev"
#define MyAppExeName "claude-code-gui.exe"

; 安装包版本 = **项目发布版本**（日期式，如 2026.09.20.6），由 build.ps1 从
; dist\manifest.json 读出后经 /D 传入。
;
; ⚠️ 这里曾硬编码 "2.1.89"（那是 claude.exe 的**上游**版本）→ 安装包文件名
; 与卸载列表里显示的都是一个跟项目发布无关的号，用户拿到包无法判断对应哪次发布。
; 同时曾用 BuildTag（周数 2026W38）也与此版本体系脱节，一并去掉 ——
; 版本号本身已含日期 + 当日序号（.6 → .7），无需第二个标识。
#ifndef MyAppVersion
  #error MyAppVersion is required: pass /DMyAppVersion=<version> (see build.ps1)
#endif

[Setup]
AppId={{E8A7B3C2-D5F1-4A9E-BC60-28F94D731E5D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppSupportURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
Compression=lzma2/ultra64
SolidCompression=yes
OutputDir=..\dist
OutputBaseFilename=ClaudeCodeHaha_Setup_v{#MyAppVersion}
; 让 exe 的「文件版本」也有值 —— 不写的话 Windows 属性对话框里那一栏是空的
; （Inno 只从 AppVersion 写 ProductVersion，不自动填 FileVersion）。
; 需要四段数字，而我们的版本号恰好是（2026.09.20.6）→ 可直接用。
VersionInfoVersion={#MyAppVersion}
VersionInfoDescription={#MyAppName} Setup
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}
WizardStyle=modern
; All-users install → Program Files + system env (elevated); current-user install
; → {localappdata}\Programs + user env (no UAC). {autopf} resolves to the right
; Program Files for each mode, so {app} adapts automatically.
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=commandline dialog
UninstallDisplayIcon={app}\{#MyAppExeName}
DisableProgramGroupPage=yes
; 覆盖安装前自动关闭占用的 GUI 应用（文件锁 → MoveFile failed/拒绝访问）。
; git-credential-manager.exe 无主窗口，CloseApplications 关不掉 → 由 ssInstall 的 taskkill 兜底。
CloseApplications=yes
CloseApplicationsFilter=claude-code-gui.exe
RestartApplications=yes

[Languages]
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Components]
Name: "core"; Description: "核心文件 (claude.exe + CLI 工具 + IDE 插件)"; Types: full compact custom; Flags: fixed
Name: "gui"; Description: "桌面应用 (Claude Code GUI + 自动更新)"; Types: full
Name: "gitbash"; Description: "Git Bash 环境 — shell + Unix 命令行工具"; Types: full
Name: "git"; Description: "Git 仓库操作 — git push/pull/fetch 等（需 Git Bash）"; Types: full
Name: "python"; Description: "Python 3.12 (完整版) + pywin32"; Types: full

[Tasks]
Name: "addpath"; Description: "将 Claude Code 添加到系统 PATH（推荐）"; GroupDescription: "系统配置："; Flags: checkedonce

[Files]
; Core executables at root (always installed)
Source: "..\dist\claude-code-gui.exe"; DestDir: "{app}"; Flags: ignoreversion; Components: gui
Source: "..\dist\claude-gui-server.exe"; DestDir: "{app}"; Flags: ignoreversion; Components: gui
Source: "..\dist\Update.exe";          DestDir: "{app}"; Flags: ignoreversion; Components: gui
Source: "..\dist\claude.exe";          DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\bun.exe";             DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\manifest.json";        DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\*.cmd";               DestDir: "{app}"; Flags: ignoreversion
; CLI tools in bin/
Source: "..\dist\bin\*";      DestDir: "{app}\bin";         Flags: ignoreversion
Source: "..\dist\scripts\*";  DestDir: "{app}\scripts";     Flags: ignoreversion
Source: "..\dist\extensions\*"; DestDir: "{app}\extensions"; Flags: ignoreversion recursesubdirs createallsubdirs
; Optional: Git Bash + Git repo tools (both go to {app}\git, merged at install time)
Source: "..\dist\git\*";      DestDir: "{app}\git";    Flags: ignoreversion recursesubdirs createallsubdirs; Components: gitbash git
; Optional: Python 3.12
Source: "..\dist\python\*";   DestDir: "{app}\python"; Flags: ignoreversion recursesubdirs createallsubdirs; Components: python

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Components: gui
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\python\pythonw.exe"; Parameters: """{app}\scripts\gui-profile.py"" ""{app}"""; \
    Description: "配置 API Profile (DeepSeek v4 Pro)"; Flags: postinstall skipifsilent nowait skipifdoesntexist; \
    Components: python and not gui

[Code]
const
  SystemEnvKey = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment';
  HomeVarName = 'CLAUDE_CODE_HAHA_HOME';
  WM_SETTINGCHANGE = $001A;
  SMTO_ABORTIFHUNG = $0002;

function SendMessageTimeout(hWnd: HWND; Msg, wParam, lParam, fuFlags, uTimeout: Cardinal;
  var lpdwResult: Cardinal): Cardinal; external 'SendMessageTimeoutW@user32.dll stdcall';

// WM_SETTINGCHANGE broadcast — makes newly-written env vars visible to already
// running processes (Explorer, IDE, terminal) without a logout/reboot.
procedure BroadcastEnvironmentChange;
var
  Dummy: Cardinal;
begin
  // lParam = 0 broadcasts to all windows; Explorer and freshly spawned
  // processes pick up the new environment without a logout/reboot.
  SendMessageTimeout(HWND_BROADCAST, WM_SETTINGCHANGE, 0, 0,
    SMTO_ABORTIFHUNG, 5000, Dummy);
end;

// ── PATH helpers ──────────────────────────────────────────────────────
//
// PATH entries can exist in two equivalent forms:
//   - literal token   e.g. %CLAUDE_CODE_HAHA_HOME%\bin   (what the installer writes)
//   - expanded path   e.g. C:\Program Files\Claude Code Haha\bin
// Older installs wrote expanded paths; newer ones write %VAR% tokens. Both must
// be recognized when de-duplicating, so reinstall/upgrade never accumulates
// duplicate entries.

// True if a PATH entry (by itself, not as a substring of another entry) matches
// any of the given equivalent forms. `Paths` is the raw ';'-joined value.
function PathHasEntry(Paths: string; MatchA, MatchB: string): Boolean;
var
  Part: string;
  P: Integer;
begin
  Result := False;
  while Paths <> '' do
  begin
    P := Pos(';', Paths);
    if P > 0 then begin
      Part := Copy(Paths, 1, P - 1);
      Delete(Paths, 1, P);
    end else begin
      Part := Paths;
      Paths := '';
    end;

    Part := Trim(Part);
    if Part = '' then Continue;

    if (CompareText(Part, MatchA) = 0) or
       ((MatchB <> '') and (CompareText(Part, MatchB) = 0)) then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

// Append an entry to PATH unless an equivalent form already exists. Returns
// True when a write happened (i.e. caller may want to re-add after removing).
procedure EnvAddPathTo(RootKey: Integer; SubKeyName, PathToken, PathExpanded: string);
var
  Paths: string;
begin
  if not RegQueryStringValue(RootKey, SubKeyName, 'Path', Paths) then
    Paths := '';

  if PathHasEntry(Paths, PathToken, PathExpanded) then
  begin
    Log('PATH already contains: ' + PathToken);
    Exit;
  end;

  if Paths <> '' then
    Paths := Paths + ';' + PathToken
  else
    Paths := PathToken;

  // RegWriteExpandStringValue (REG_EXPAND_SZ) — PATH holds %VAR% entries (e.g.
  // %SystemRoot%); writing REG_SZ would stop them expanding.
  if RegWriteExpandStringValue(RootKey, SubKeyName, 'Path', Paths) then
    Log('Appended to PATH: ' + PathToken)
  else
    Log('Failed to add to PATH: ' + PathToken);
end;

// Prepend an entry to the FRONT of PATH unless an equivalent form already
// exists. Used for git\usr\bin so a bare `bash` resolves to git-bash instead
// of WSL/System32's bash (matches the diagnostics tool's arrange_install_path,
// which puts git\usr\bin first).
procedure EnvPrependPathTo(RootKey: Integer; SubKeyName, PathToken, PathExpanded: string);
var
  Paths, NewPaths: string;
begin
  if not RegQueryStringValue(RootKey, SubKeyName, 'Path', Paths) then
    Paths := '';

  if PathHasEntry(Paths, PathToken, PathExpanded) then
  begin
    Log('PATH already contains: ' + PathToken);
    Exit;
  end;

  if Paths <> '' then
    NewPaths := PathToken + ';' + Paths
  else
    NewPaths := PathToken;

  if RegWriteExpandStringValue(RootKey, SubKeyName, 'Path', NewPaths) then
    Log('Prepended to PATH: ' + PathToken)
  else
    Log('Failed to prepend to PATH: ' + PathToken);
end;

// Remove every entry matching either form (token or expanded) from PATH.
procedure EnvRemovePathFrom(RootKey: Integer; SubKeyName, PathToken, PathExpanded: string);
var
  Paths, NewPaths, Part: string;
  P: Integer;
begin
  if not RegQueryStringValue(RootKey, SubKeyName, 'Path', Paths) then
    Exit;

  NewPaths := '';
  while Paths <> '' do
  begin
    P := Pos(';', Paths);
    if P > 0 then begin
      Part := Copy(Paths, 1, P - 1);
      Delete(Paths, 1, P);
    end else begin
      Part := Paths;
      Paths := '';
    end;

    Part := Trim(Part);
    if (Part = '') or (CompareText(Part, PathToken) = 0) or
       ((PathExpanded <> '') and (CompareText(Part, PathExpanded) = 0)) then
      Continue;

    if NewPaths <> '' then
      NewPaths := NewPaths + ';' + Part
    else
      NewPaths := Part;
  end;

  // Keep REG_EXPAND_SZ so remaining %VAR% entries still expand.
  RegWriteExpandStringValue(RootKey, SubKeyName, 'Path', NewPaths);
  Log('Removed from PATH (' + SubKeyName + '): ' + PathToken);
end;

// Remove all Claude entries (both forms) from system + user PATH. Older
// installs wrote to the user PATH; newer ones use system PATH (visible to
// IDE/plugin processes), so uninstall cleans both scopes.
procedure EnvRemovePath(PathToken, PathExpanded: string);
begin
  EnvRemovePathFrom(HKEY_LOCAL_MACHINE, SystemEnvKey, PathToken, PathExpanded);
  EnvRemovePathFrom(HKEY_CURRENT_USER, 'Environment', PathToken, PathExpanded);
end;

// ── Install / Uninstall hooks ─────────────────────────────────────────

// ── Install / Uninstall hooks ─────────────────────────────────────────

/// 覆盖安装前杀掉可能锁定文件的进程。git-credential-manager.exe 是后台进程
/// （无主窗口），CloseApplications 管不到它，但它运行时会锁住
/// git\mingw64\bin\git-credential-manager.exe.config → 覆盖报 MoveFile failed/拒绝访问。
procedure KillLockingProcesses;
var
  ResultCode: Integer;
begin
  Exec('taskkill.exe', '/F /IM git-credential-manager.exe /T', '', SW_HIDE,
       ewWaitUntilTerminated, ResultCode);
  // claude-code-gui.exe 兜底（CloseApplications 之外的手动 setup 覆盖场景）
  Exec('taskkill.exe', '/F /IM claude-code-gui.exe /T', '', SW_HIDE,
       ewWaitUntilTerminated, ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  HomePath, HomeVar: string;
  EnvRoot: Integer;
  EnvSub: string;
begin
  if CurStep = ssInstall then begin
    Log('ssInstall: killing file-locking processes');
    KillLockingProcesses;
  end;
  if CurStep = ssPostInstall then begin
    Log('ssPostInstall: starting');

    // All-users install runs elevated → system env (HKLM). Current-user install
    // runs unprivileged → user env (HKCU). The mode comes from the privilege
    // override dialog shown at startup.
    if IsAdminInstallMode then begin
      EnvRoot := HKEY_LOCAL_MACHINE;
      EnvSub := SystemEnvKey;
    end else begin
      EnvRoot := HKEY_CURRENT_USER;
      EnvSub := 'Environment';
    end;

    // ── Set CLAUDE_CODE_HAHA_HOME env var ──
    HomePath := ExpandConstant('{app}');
    HomeVar := '%' + HomeVarName + '%';
    Log('set: ' + HomeVarName + ' = ' + HomePath + ' (' + EnvSub + ')');
    // Path is absolute (no %VAR% inside), but REG_EXPAND_SZ is safer if the
    // install dir is later referenced from another variable.
    RegWriteExpandStringValue(EnvRoot, EnvSub, HomeVarName, HomePath);

    // Admin install → system (HKLM) is the single authority (matches the
    // diagnostics tool's fix_environment_vars). Clear any HKCU leftover so the
    // user-level value doesn't shadow the correct system value — otherwise the
    // diagnostics tool flags "用户级残留旧值覆盖系统级正确值" right after install.
    if IsAdminInstallMode then begin
      Log('clean: HKCU leftover ' + HomeVarName);
      RegDeleteValue(HKEY_CURRENT_USER, 'Environment', HomeVarName);
    end;

    // Point Claude at the bundled git-bash regardless of PATH choice,
    // so it can find bash.exe even when "add to PATH" is unchecked.
    if WizardIsComponentSelected('gitbash') then begin
      Log('set: CLAUDE_CODE_GIT_BASH_PATH (' + EnvSub + ')');
      // Contains %CLAUDE_CODE_HAHA_HOME% — must be REG_EXPAND_SZ or the
      // consumer (src/utils/windowsPaths.ts) gets a literal %VAR% path.
      RegWriteExpandStringValue(EnvRoot, EnvSub,
        'CLAUDE_CODE_GIT_BASH_PATH',
        HomeVar + '\git\usr\bin\bash.exe');
    end else begin
      // gitbash not installed → GIT_BASH_PATH is obsolete (bash.exe absent);
      // remove from both scopes, matching the diagnostics' Remove plan.
      Log('clean: stale GIT_BASH_PATH (gitbash not selected)');
      RegDeleteValue(HKEY_LOCAL_MACHINE, SystemEnvKey, 'CLAUDE_CODE_GIT_BASH_PATH');
      RegDeleteValue(HKEY_CURRENT_USER, 'Environment', 'CLAUDE_CODE_GIT_BASH_PATH');
    end;
    if IsAdminInstallMode then begin
      Log('clean: HKCU leftover CLAUDE_CODE_GIT_BASH_PATH');
      RegDeleteValue(HKEY_CURRENT_USER, 'Environment', 'CLAUDE_CODE_GIT_BASH_PATH');
    end;

    // Scrub previous install PATH entries from BOTH scopes (expanded path OR
    // %VAR% token) so reinstall/upgrade never accumulates duplicates and no
    // user-level leftover survives to be flagged by the diagnostics tool.
    EnvRemovePathFrom(HKEY_LOCAL_MACHINE, SystemEnvKey, HomeVar, HomePath);
    EnvRemovePathFrom(HKEY_CURRENT_USER, 'Environment', HomeVar, HomePath);

    if WizardIsTaskSelected('addpath') then begin
      // Root — claude.exe, claude-code-gui.exe, bun.exe, *.cmd
      Log('addpath: root');
      EnvAddPathTo(EnvRoot, EnvSub, HomeVar, HomePath);

      // bin — CLI tools (rg, fd, jq, yq, shellcheck)
      Log('addpath: bin');
      EnvAddPathTo(EnvRoot, EnvSub, HomeVar + '\bin', HomePath + '\bin');

      if WizardIsComponentSelected('gitbash') then begin
        Log('addpath: git\bin');
        EnvAddPathTo(EnvRoot, EnvSub, HomeVar + '\git\bin', HomePath + '\git\bin');
      end;
      if WizardIsComponentSelected('git') then begin
        Log('addpath: git\mingw64\bin');
        EnvAddPathTo(EnvRoot, EnvSub, HomeVar + '\git\mingw64\bin', HomePath + '\git\mingw64\bin');
      end;
      if WizardIsComponentSelected('python') then begin
        Log('addpath: python');
        EnvAddPathTo(EnvRoot, EnvSub, HomeVar + '\python', HomePath + '\python');
        Log('addpath: python\Scripts');
        EnvAddPathTo(EnvRoot, EnvSub, HomeVar + '\python\Scripts', HomePath + '\python\Scripts');
        // @python-env.md 注入已移交 GUI 启动 sync_python_env()（mac/win 统一、幂等、内容平台化），
        // setup 不再处理——避免 setup 装静态 %CLAUDE_CODE_HAHA_HOME% 路径与 GUI 动态生成冲突。
      end;

      // Prepending LAST puts git\usr\bin at the very front of PATH, so a bare
      // `bash` resolves to git-bash, not WSL/System32 (matches the diagnostics
      // tool's arrange_install_path which prepends git\usr\bin).
      if WizardIsComponentSelected('gitbash') then begin
        Log('addpath: git\usr\bin (prepend)');
        EnvPrependPathTo(EnvRoot, EnvSub, HomeVar + '\git\usr\bin', HomePath + '\git\usr\bin');
      end;
      Log('addpath: done');
    end;

    // Tell the shell / running apps to pick up the new env vars now, so a
    // reinstall doesn't force a logout/reboot before they take effect.
    BroadcastEnvironmentChange;
    Log('ssPostInstall: done');
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  HomePath, HomeVar: string;
begin
  if CurUninstallStep = usPostUninstall then begin
    HomeVar := '%' + HomeVarName + '%';
    // {app} in the uninstaller resolves to the install dir, so both the %VAR%
    // token and its expanded form are cleaned from system + user PATH.
    HomePath := ExpandConstant('{app}');

    EnvRemovePath(HomeVar, HomePath);
    EnvRemovePath(HomeVar + '\bin', HomePath + '\bin');
    EnvRemovePath(HomeVar + '\git\usr\bin', HomePath + '\git\usr\bin');
    EnvRemovePath(HomeVar + '\git\bin', HomePath + '\git\bin');
    EnvRemovePath(HomeVar + '\git\mingw64\bin', HomePath + '\git\mingw64\bin');
    EnvRemovePath(HomeVar + '\python', HomePath + '\python');

    // Clean env vars from both scopes — the install wrote to whichever one
    // matched its mode (system for all-users, user for current-user). Deletes
    // from the other scope fail harmlessly for a non-admin uninstaller.
    RegDeleteValue(HKEY_LOCAL_MACHINE, SystemEnvKey, 'CLAUDE_CODE_GIT_BASH_PATH');
    RegDeleteValue(HKEY_LOCAL_MACHINE, SystemEnvKey, HomeVarName);
    RegDeleteValue(HKEY_CURRENT_USER, 'Environment', 'CLAUDE_CODE_GIT_BASH_PATH');
    RegDeleteValue(HKEY_CURRENT_USER, 'Environment', HomeVarName);

    BroadcastEnvironmentChange;
  end;
end;
