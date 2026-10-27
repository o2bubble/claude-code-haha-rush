// ── 技能目录内容哈希 ──
//
// 与**服务端** `server/skill_hash.py` 必须算出**逐字节一致**的结果。
// 规范见 `docs/skill-content-hash.md`。
//
// 为什么要有这个（2026-10-26）：技能市场以前判断不出哪些技能需要更新 ——
// 本地装技能只复制文件、不记版本，上游 SKILL.md 也大多没有 version 字段。
// 改成内容哈希比对：服务端发布时算好，客户端对本地目录用同一算法算一遍。
//
// 🔴 最容易踩的坑是**遍历顺序**：
// Python 的 `os.walk` 把"当前目录的文件"和"子目录"分两批给出，
// 如果这边照着那个顺序写，两边哈希就永远对不上（表现为满屏"需要更新"）。
// 所以规定为：**同目录下文件与子目录混排，按名称的 UTF-8 字节序**。

use sha2::{Digest, Sha256};
use std::path::Path;

const SKIP_DIRS: &[&str] = &[".git", "__pycache__", "node_modules", ".venv"];
const SKIP_FILES: &[&str] = &[".DS_Store", "Thumbs.db"];

/// 算一个技能目录的内容哈希（小写 hex）。
pub fn skill_hash(root: &Path) -> std::io::Result<String> {
    skill_hash_excluding(root, &[])
}

/// 带**额外排除目录**的哈希。
///
/// 服务端对某些包排除了体积巨大且几乎不变的目录（ppt-master 的 `templates`
/// 有 12450 个文件）。名单随 API 的 `hash_exclude` 下发 —— 两边必须一致，
/// 否则哈希永远不同（满屏误报"可更新"）。
pub fn skill_hash_excluding(root: &Path, extra_dirs: &[String]) -> std::io::Result<String> {
    let mut h = Sha256::new();
    walk(root, root, &mut h, extra_dirs)?;
    Ok(format!("{:x}", h.finalize()))
}

fn walk(
    root: &Path,
    dir: &Path,
    h: &mut Sha256,
    extra: &[String],
) -> std::io::Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();

    // 按名称的 **UTF-8 字节序**排序 —— 与 Python 的 `sorted(key=name.encode('utf-8'))` 一致。
    // 不能用 `to_string_lossy()` 排序：非 UTF-8 名称会被替换字符打乱顺序。
    entries.sort_by(|a, b| {
        let an = a.file_name();
        let bn = b.file_name();
        an.as_encoded_bytes().cmp(bn.as_encoded_bytes())
    });

    for e in entries {
        let path = e.path();
        let name = e.file_name();
        let name = name.to_string_lossy();

        // `symlink_metadata` 而非 `metadata`：不跟随符号链接，
        // 避免链到外部目录把不该算的内容卷进来（也防止环）。
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue, // 读不到就跳过，不中断整个哈希
        };

        if meta.is_dir() {
            if SKIP_DIRS.contains(&name.as_ref()) || extra.iter().any(|x| x == name.as_ref()) {
                continue;
            }
            walk(root, &path, h, extra)?; // 目录本身不贡献哈希
        } else if meta.is_file() {
            if SKIP_FILES.contains(&name.as_ref()) {
                continue;
            }
            let rel = match path.strip_prefix(root) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let rel = rel.to_string_lossy().replace('\\', "/");
            h.update(rel.as_bytes());
            match std::fs::read(&path) {
                Ok(bytes) => h.update(&bytes),
                Err(_) => {} // 单个文件读失败：跳过内容（路径已 update，两边都会这样）
            }
        }
        // 符号链接等其它类型：忽略
    }
    Ok(())
}

/// 批量算一组技能目录的哈希：[(技能名, 路径)] → {技能名: hash}
pub fn skill_hashes(items: &[(String, std::path::PathBuf)]) -> Vec<(String, String)> {
    items
        .iter()
        .filter_map(|(name, path)| {
            skill_hash(path).ok().map(|h| (name.clone(), h))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "skh-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn empty_dir_has_stable_hash() {
        let d = tmp("empty");
        let a = skill_hash(&d).unwrap();
        let b = skill_hash(&d).unwrap();
        assert_eq!(a, b, "同一目录两次哈希必须相同");
        assert_eq!(a.len(), 64);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn content_change_changes_hash() {
        let d = tmp("content");
        fs::write(d.join("SKILL.md"), "v1").unwrap();
        let h1 = skill_hash(&d).unwrap();
        fs::write(d.join("SKILL.md"), "v2").unwrap();
        let h2 = skill_hash(&d).unwrap();
        assert_ne!(h1, h2, "内容变了哈希必须变");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn path_order_is_byte_order() {
        // 字节序：大写字母(65-90) < 小写(97-122) < 中文(0xE4...)
        let d = tmp("order");
        fs::write(d.join("b.txt"), "b").unwrap();
        fs::write(d.join("A.txt"), "a").unwrap();
        fs::write(d.join("中文.txt"), "z").unwrap();
        let h1 = skill_hash(&d).unwrap();

        // 换个创建顺序，哈希应不变（因为我们排序了）
        let d2 = tmp("order2");
        fs::write(d2.join("中文.txt"), "z").unwrap();
        fs::write(d2.join("b.txt"), "b").unwrap();
        fs::write(d2.join("A.txt"), "a").unwrap();
        let h2 = skill_hash(&d2).unwrap();

        assert_eq!(h1, h2, "创建顺序不该影响哈希（必须排序）");
        fs::remove_dir_all(&d).ok();
        fs::remove_dir_all(&d2).ok();
    }

    #[test]
    fn skipped_files_do_not_affect_hash() {
        let d = tmp("skip");
        fs::write(d.join("SKILL.md"), "x").unwrap();
        let h1 = skill_hash(&d).unwrap();

        // 加 .DS_Store 和 __pycache__ —— 都不该影响
        fs::write(d.join(".DS_Store"), "junk").unwrap();
        fs::create_dir_all(d.join("__pycache__")).unwrap();
        fs::write(d.join("__pycache__").join("x.pyc"), "junk").unwrap();

        let h2 = skill_hash(&d).unwrap();
        assert_eq!(h1, h2, ".DS_Store / __pycache__ 必须被排除");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn nested_dirs_are_hashed() {
        let d = tmp("nested");
        fs::write(d.join("SKILL.md"), "x").unwrap();
        let h1 = skill_hash(&d).unwrap();

        fs::create_dir_all(d.join("agents")).unwrap();
        fs::write(d.join("agents").join("openai.yaml"), "y").unwrap();
        let h2 = skill_hash(&d).unwrap();
        assert_ne!(h1, h2, "新增子目录里的文件必须影响哈希");
        fs::remove_dir_all(&d).ok();
    }
}
