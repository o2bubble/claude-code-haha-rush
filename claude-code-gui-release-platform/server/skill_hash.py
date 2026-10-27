"""技能目录的内容哈希 —— 与客户端 Rust 实现**必须逐字节一致**。

规范见 docs/skill-content-hash.md。要点：
  · 深度优先，同目录下文件与子目录**混排**按名称 UTF-8 字节序
  · 每个文件 update(相对路径) + update(内容)，相对路径统一 `/`
  · 目录本身不贡献哈希

⚠️ **不要用 os.walk** —— 它把文件与子目录分两批给出，顺序与本规范不同。
"""

import hashlib
import os

SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv"}
SKIP_FILES = {".DS_Store", "Thumbs.db"}


def skill_hash(root: str, exclude_dirs: set[str] | None = None) -> str:
    """返回技能目录的内容哈希（小写 hex，64 字符）。

    `exclude_dirs`：**该包额外排除**的子目录名（如 ppt-master 的 `templates`）。
    那类目录动辄上万文件且几乎不变，排除后哈希从 ~1s 降到几十 ms。

    ⚠️ 排除名单**必须也下发给客户端**，否则两边算出的哈希永远不同
    → 表现为满屏"可更新"。所以它随 API 走 `hash_exclude` 字段。
    """
    extra = exclude_dirs or set()
    h = hashlib.sha256()

    def walk(d: str) -> None:
        try:
            entries = sorted(os.scandir(d), key=lambda e: e.name.encode("utf-8"))
        except OSError:
            return
        for e in entries:
            try:
                is_dir = e.is_dir()
            except OSError:
                continue
            if is_dir:
                if e.name in SKIP_DIRS or e.name in extra:
                    continue
                walk(e.path)
            else:
                if e.name in SKIP_FILES:
                    continue
                rel = os.path.relpath(e.path, root).replace(os.sep, "/")
                h.update(rel.encode("utf-8"))
                try:
                    with open(e.path, "rb") as f:
                        h.update(f.read())
                except OSError:
                    pass

    walk(root)
    return h.hexdigest()


def find_skill_dirs(pkg_dir: str) -> dict[str, str]:
    """找出包内所有技能目录，返回 {技能名: 绝对路径}。

    技能 = 含 SKILL.md 的目录。包内可能两种布局：
      · 平铺：skills-store/<pkg>/<skill>/SKILL.md          （nature-skills）
      · 套一层：skills-store/<pkg>/<inner>/SKILL.md        （single-skill 包）
      · 再深一层：skills-store/<pkg>/<inner>/skills/<skill>/SKILL.md（patent）

    这里按"任意深度找 SKILL.md，取它所在目录"处理，天然覆盖全部布局。
    """
    found = {}
    for dirpath, dirnames, filenames in os.walk(pkg_dir):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        if "SKILL.md" not in filenames:
            continue
        name = os.path.basename(dirpath)
        found.setdefault(name, dirpath)
        # ⚠️ 找到 SKILL.md 后**不能无条件停止下探**（2026-10-26）。
        #
        # patent-disclosure-skill 的布局：
        #   <pkg>/patent-disclosure-skill/SKILL.md          ← 兼容用的总入口
        #   <pkg>/patent-disclosure-skill/skills/<skill>/SKILL.md   ← 9 个真技能
        # 若在此处 `dirnames[:] = []`，那 9 个就永远扫不到，包只显示 1 个技能。
        #
        # 判据不能只看**直接子目录**（skills/ 本身没有 SKILL.md，是"容器"），
        # 要往下探两层：**子目录里（含再下一层）是否还有 SKILL.md**。
        # 有 → 当前目录是"容器"，继续挖；没有 → 叶子技能，到此为止。
        def _has_skill_below(path: str, depth: int = 2) -> bool:
            if depth <= 0:
                return False
            try:
                subs = [d for d in os.listdir(path)
                        if os.path.isdir(os.path.join(path, d)) and d not in SKIP_DIRS]
            except OSError:
                return False
            for d in subs:
                child = os.path.join(path, d)
                if os.path.exists(os.path.join(child, "SKILL.md")):
                    return True
                if _has_skill_below(child, depth - 1):
                    return True
            return False

        if not _has_skill_below(dirpath):
            dirnames[:] = []
    return found


# ── 每包的额外排除目录 ──
#
# 这些目录**不参与内容哈希**：它们体积巨大、内容几乎不变，
# 参与计算会把哈希拖到秒级（ppt-master 的 templates 有 12450 个文件）。
#
# 客户端必须拿到同一份名单（随 API 的 `hash_exclude` 下发），
# 否则两边算出的哈希不同 → 满屏误报"可更新"。
HASH_EXCLUDE_BY_PKG: dict[str, list[str]] = {
    "ppt-master": ["templates"],
}

# 全局排除：这些名字出现在任何包里都不算
HASH_EXCLUDE_GLOBAL: list[str] = []


def hash_exclude_for(slug: str) -> list[str]:
    """该包要额外排除的目录名（下发给客户端用）。"""
    return HASH_EXCLUDE_BY_PKG.get(slug, [])


def package_hashes(pkg_dir: str, slug: str = "") -> dict[str, str]:
    """包内每个技能的内容哈希：{技能名: hash}"""
    extra = set(hash_exclude_for(slug))
    return {
        name: skill_hash(path, extra)
        for name, path in find_skill_dirs(pkg_dir).items()
    }
