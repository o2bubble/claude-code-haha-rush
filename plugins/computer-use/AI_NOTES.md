# AI_NOTES — computer-use（组合技能包）

给 AI 的排障文档。**这个插件本身没有代码**，出问题几乎总是三处之一：
技能链接没建立 / 依赖插件没装好 / 技能内容本身要改。

## 概览

- **贡献**：一个技能 `computer-use`（**链接**到 `~/.claude/skills/`）
- **依赖**：`mouse-keyboard`（操作）+ `screenshot`（看屏幕）
- **无进程、无面板、无 MCP 工具** —— 它是"组合 + 文档"型插件

## 结构

```
<插件目录>/computer-use/
  plugin.json            ← contributes.skills: [{ name: "computer-use", path: "skill" }]
  skill/
    SKILL.md             ← 技能主体（心法 + 常见失败表）
    references/
      coordinates.md     ← 坐标换算细节
      tool-reference.md  ← 工具参数速查
```

## 故障模式

### 1. 「AI 的技能列表里没有 computer-use」

按顺序查：

1. **插件装了吗、启用了吗** → `plugin_list` 看 `computer-use` 在列且 `enabled: true`
2. **两个依赖装了吗** → `plugin_list` 看 `mouse-keyboard` / `screenshot`
   （依赖没装的话本插件会被拒绝安装，见下）
3. **链接建了吗** →
   - Windows：`dir %USERPROFILE%\.claude\skills` 看有没有 `computer-use`
   - 应该是一个 `<JUNCTION>` 类型的条目，指向 `<插件目录>\skill`
4. **链接是悬空的吗**（目标不存在）→ 插件目录被删/改名了。重装本插件即可
5. **AI 会话是新的吗** → 技能在**会话启动时**扫描，刚安装后需要**新会话**才看到
   （这与"插件面板立刻可见"不同 —— skill 走的是 claude.exe 的扫描时机）

### 2. 「链接建不起来」

宿主在**每次插件重扫**时同步链接（`sync_plugin_skill_links`）。
失败时不会阻断插件安装 —— 所以"插件装了但链接没有"是可能的。查：

- **目标目录/名字非法**：skill 名只允许字母数字 `-_.`；`skill.path` 必须是插件内相对路径
- **目标缺 SKILL.md**：Rust 侧会跳过并记 error（宿主控制台里能看到）
- **手工验证**：`New-Item -ItemType Junction -Path <skills目录>\computer-use -Target <插件目录>\skill`
  能成功的话，说明是宿主的同步逻辑问题而不是权限问题

### 3. 「技能内容要改」（最常见的实际需求）

**直接改 `<插件目录>/computer-use/skill/SKILL.md` 即可，不用重装** ——
链接指向插件目录，改完立刻生效（AI 下次会话加载到新内容）。

改完记得：
- 保持在 `skill/` 里的相对结构（`references/` 里加文件要确认 SKILL.md 里有引用）
- **`plugin.json` 升版本**并把 `computer-use.zip` 重打（源目录留档的包也要同步，
  否则下次谁拿它发布就发出旧内容）

### 4. 「卸载了但技能还在」

链接的清理发生在**插件重扫**时。若卸载后没触发重扫（少见），手工删：

```
rmdir %USERPROFILE%\.claude\skills\computer-use    ← rmdir 只摘链接，不删目标
```

⚠️ **绝不要用 `rd /s` 或资源管理器删除** —— junction 在资源管理器里看起来像普通文件夹，
删它会连带删掉插件目录里的真实文件。

### 5. 「安装被拒绝：Missing dependencies」

按设计如此 —— 本插件依赖 `mouse-keyboard` 与 `screenshot`。
宿主会提示**是否一并安装**（市场一键安装路径），或让 AI 先装（AI 代装路径）。
若依赖装了但**未就绪**（如 ai-guided 插件没完成环境安装），也会被提示。

## 设计要点（改之前先理解）

### 为什么用链接而不是复制

**单一来源**：改插件里的技能文件立刻生效，不会出现"技能目录里是旧副本"。
代价是要处理链接的建立/清理/悬空 —— 都由宿主的**幂等同步**兜住。

### 为什么同步放在"每次插件重扫"而不是"安装时一次"

链接是**外部状态**，会漂：用户手删了、插件被手工挪走、卸载后留下悬空链接。
幂等同步让这些情况在下次重扫时自愈；一次性动作漂了就没人管。

### 为什么 Windows 用 junction 而不是 symlink

**真 symlink 需要管理员权限或开发者模式**，而 junction 不需要 —— 用户装个插件
不该要求他开开发者模式。（junction 也是 reparse point，Node 的
`Dirent.isSymbolicLink()` 返回 true，技能加载器显式接受它，所以能被识别。）

### 技能内容的边界

SKILL.md 里写的都是**实测过的**事实（如"锁 10 秒自动续期"、"预算 8 秒"、
"`meta.monitorOrigin` 是图左上角的绝对坐标"）。改内容时：
**先核实工具的实际行为再写** —— 写错的指引比没有指引更糟（AI 会照做然后失败）。

## 相关

- 操作能力本体：`plugin_docs name=mouse-keyboard`
- 看屏能力本体：`plugin_docs name=screenshot`
- 技能链接机制：宿主侧 `sync_plugin_skill_links`（Rust）+ `syncPluginSkillLinks`（前端）
