# 技能内容哈希 —— 两端必须逐字节一致的算法

> 2026-10-26 · 服务端（Python）与客户端（Rust）共用这份规范

## 为什么需要

技能市场以前**判断不出哪些技能需要更新**：
- 本地 `~/.claude/skills/<name>/` 只复制了文件，**没记版本**
- 上游大部分 `SKILL.md` 也没有 `version` 字段

改成**内容哈希比对**：服务端发布时算出每个技能目录的内容哈希，客户端对本地
目录用**同一算法**算一遍 —— 相同即最新，不同即可更新。改一个字节就能发现。

## 算法

```
hash = SHA256( 依次 update(每个文件的相对路径 + 文件内容) )
```

### 遍历顺序（最容易出错的地方）

**深度优先，同一目录下的文件和子目录混在一起按名称排序。**

```
process(dir):
    entries = 该目录下所有条目（文件 + 子目录）
    剔除 SKIP_DIRS 中的子目录、SKIP_FILES 中的文件
    entries.sort(按名称的 UTF-8 字节序)      ← 不是 locale 排序
    for e in entries:
        if e 是目录:  process(e)              ← 目录本身不贡献哈希
        else:        update(relpath)；update(content)
```

> ⚠️ **不能用 Python 的 `os.walk`** —— 它把"当前目录的文件"和"子目录"分两批给出，
> 顺序与上面的定义不同，会算出不同的哈希。必须用 `os.scandir` 自己排。

### 相对路径

- 相对**技能根目录**（含 `SKILL.md` 的那个目录）
- 分隔符统一 `/`（Windows 的 `\` 要替换）
- 不带 `./` 前缀
- 编码 UTF-8

### 排除项

目录：`.git`、`__pycache__`、`node_modules`、`.venv`
文件：`.DS_Store`、`Thumbs.db`

### 输出

小写十六进制，64 字符。

## 参考实现

### Python

```python
import hashlib, os

SKIP_DIRS = {'.git', '__pycache__', 'node_modules', '.venv'}
SKIP_FILES = {'.DS_Store', 'Thumbs.db'}

def skill_hash(root: str) -> str:
    h = hashlib.sha256()

    def walk(d: str) -> None:
        entries = sorted(os.scandir(d), key=lambda e: e.name.encode('utf-8'))
        for e in entries:
            if e.is_dir():
                if e.name in SKIP_DIRS:
                    continue
                walk(e.path)
            else:
                if e.name in SKIP_FILES:
                    continue
                rel = os.path.relpath(e.path, root).replace(os.sep, '/')
                h.update(rel.encode('utf-8'))
                with open(e.path, 'rb') as f:
                    h.update(f.read())

    walk(root)
    return h.hexdigest()
```

### Rust

```rust
use sha2::{Digest, Sha256};
use std::path::Path;

const SKIP_DIRS: &[&str] = &[".git", "__pycache__", "node_modules", ".venv"];
const SKIP_FILES: &[&str] = &[".DS_Store", "Thumbs.db"];

pub fn skill_hash(root: &Path) -> std::io::Result<String> {
    let mut h = Sha256::new();
    walk(root, root, &mut h)?;
    Ok(format!("{:x}", h.finalize()))
}

fn walk(root: &Path, dir: &Path, h: &mut Sha256) -> std::io::Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .collect();
    // 按名称的字节序（与 Python 的 .encode('utf-8') 排序一致）
    entries.sort_by(|a, b| {
        a.file_name().as_encoded_bytes().cmp(b.file_name().as_encoded_bytes())
    });

    for e in entries {
        let path = e.path();
        let name = e.file_name();
        let name = name.to_string_lossy();

        if path.is_dir() {
            if SKIP_DIRS.contains(&name.as_ref()) {
                continue;
            }
            walk(root, &path, h)?;
        } else {
            if SKIP_FILES.contains(&name.as_ref()) {
                continue;
            }
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            h.update(rel.as_bytes());
            h.update(std::fs::read(&path)?);
        }
    }
    Ok(())
}
```

## 交叉验证

改算法后**必须**跑一次两端对比，拿同一个真实目录验：

```bash
# Python 侧
python scripts/skill-hash.py ~/.claude/skills/code-review
# Rust 侧（测试里）
```

两端结果不同 = 算法没对齐，界面上会满屏"需要更新"。
