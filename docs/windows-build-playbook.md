# Windows 构建发布手册（Playbook）

> **操作手册**：照做即可发一次 Windows 版本。架构/决策细节见 `docs/macos-port.md`（平台化后 Windows/mac 共享更新服务）。写于 2026-08-26（.26.4 验证通过）。

## 0. 架构速查

- **平台化更新服务**：`updates.py` 按平台分 manifest + `?platform=windows|macos`。Windows 组件集 `{gui,claude,bun,updater,tools,python,git,extensions}`。
- **目录**：`updates-store/{version}/`（windows，base）+ `updates-store/{version}/macos/`（macos）。`_platform_dir` 里 `platform=="windows"` → base，否则 `base/platform`。
- **96**（内网 `192.168.186.96:8765`）与**云**（`123.56.66.84:8765`）跑同一套 `claude-code-gui-release-platform`（云端目录名 `claude-code-gui-release-platform`；96 是 `claude-release-platform`，updates-store 挂 `/root/claude-release-data/updates-store/`）。

## 1. 构建（生成 zip + manifest）

```bash
cd C:\Storage\claude-code-haha-dev
bun run scripts/build.ts --release 2026.XX.XX.N --note "..." --components gui,claude
# --note: 累积中文描述（见 §2），新版本写全，历史往下堆
# --components: 本次只重建/重打这些组件，其余复用上一版本 zip（server 端也按 sha 复制）
```

**产物**：`dist/release/2026.XX.XX.N/` 下 `gui.zip` + `claude.zip` + `manifest.json`（build.ts 写 version + release_notes + 各组件 sha/size）。

## 2. release_notes 累积风格（重要）

历史 manifest 的 `release_notes` 是**累积**的：新版本首条放最前，往下一段段堆历史。格式：

```
v2026.XX.XX.N
· 新增:xxx — 一句解释(为什么/解决什么)
· 修复:xxx — ...

v2026.XX.XX.N-1
· 修复:xxx — ...
...（.N-2 及以下，接上一版完整 notes）
```

- 前缀：`· 新增: / 修复: / 优化: / 通用:`
- **中文**、` — ` 后跟原因/效果。
- **不要**写英文 commit 风格（`feat(...):`）——用户会立刻看出来。
- 拼接：新版本段 + `\n\n` + `上一版 manifest 的 release_notes`（上一版已含全部历史）。

## 3. 上传到 96（requests POST）

```python
requests.post(f"{SERVER_96}/api/updates/{VERSION}/upload",
    data={"manifest": json.dumps(mf, ensure_ascii=False), "platform": "windows"},
    files=[("components", (z, open(f, "rb"), "application/zip")) for z in ZIPS],
    headers={"X-API-Key": API_KEY}, timeout=180)
```

- 端点 `POST /api/updates/{version}/upload`；Form：`manifest`(JSON 字符串)、`platform`、`components`(list[File])。
- header `X-API-Key: sk-mattpocock-skills-2026`。
- server 端 `shutil.rmtree(version_dir)` 重建 → **重传即覆盖**（改 notes 后重传即可）。
- 只传本次改的组件 zip；其他组件 server 从同平台上一版本按 sha 复制（`updates.py` 末尾逻辑）。

## 4. 上传到云（workbench，云直连 HTTP 502 不可达）

云 `123.56.66.84:8765` **不能 HTTP 直连**（502）→ 走 workbench 内网通道：

```
workbench upload <local> /tmp/ -i i-2ze2rouoikcqrlbseu8a -r cn-beijing -f
workbench exec   -i i-2ze2rouoikcqrlbseu8a -r cn-beijing -c "bash /tmp/cloud_upload.sh"
```

`cloud_upload.sh` 在云端容器 `localhost:8765` curl POST 上传（`manifest=@/tmp/manifest.json`、`components=@/tmp/gui.zip` 等）。**引号/转义放在 .sh 文件里**避免命令地狱。

**⚠️ workbench exec 踩坑（2026-08-26 实战）**：
- **`missing port in address`（`\\.\pipe\workbench-exec-...`）是 v1.0.0 的 bug**：`net.Dial("tcp", "\\.\pipe\...")` 不识别 Windows named pipe。daemon 在跑（`daemon status` = running）也没用。**修复：`workbench upgrade` 到 ≥v1.0.1**（`workbench version` 会提示新版本）。升级后 exec 立即可用。↔ `daemon start` 报 `Access is denied` 是另一回事（本机 pipe 权限）。
- Git Bash 直接调报 `missing port in address` → 必须 **Python subprocess** 调（`docs/macos-build-playbook.md` 记录过）。
- **`-F "manifest=@file"` 会把 field 当 UploadFile** → FastAPI `manifest: str = Form(...)` 报 "should be a valid string"。必须用 **`-F "manifest=<file"`**（`<` = 文件内容作普通字符串字段）；`components` 类文件字段才用 `@`。
- **`.sh` 传 Linux 必须 LF**：Windows 上用 Python `open(sh,"w",newline="\n")`，否则 bash 报 `$'/tmp\r': No such file`（CRLF 的 `\r`）。bash rc=26 即此。
- **subprocess 调 workbench 用 `encoding="utf-8", errors="replace"`**：Windows 默认 GBK 解码 workbench 输出会抛 `UnicodeDecodeError: 'gbk' codec can't decode byte 0x8b`（乱码/二进制），吞掉真实 rc/输出。
- 若 exec 报可读的错误（非 missing port），`workbench exec -i i-xxx -r cn-beijing -c "curl -s http://localhost:8765/api/updates/latest?platform=windows"` 可直接在服务器内验证容器当前 latest。

## 5. verify

```python
requests.get(f"{SERVER}/api/updates/latest?platform=windows").json()["data"]["version"]  # 应为 VERSION
```
96 + 云各验一次，并抽查 `release_notes` 前几行是否累积正确。

## 6. 完整发布脚本

`temp/release_windows_<ver>.py`（对齐 `release_0824b` 形态）：改 `VERSION/NOTES/ZIPS`，`python ... 96|cloud|verify`，`96` 走 requests、`cloud` 走 workbench、`verify` GET latest。

## 7. 本次功能背景（.26.4）

- **思考模式 + Effort 切换**（工具栏）：3P/DeepSeek 模型免重配开关扩展思考、调档位。后端通用透传（`output_config.effort` + `reasoning:{effort}`），GUI 决定档位，新模型只更新 GUI。
- **Profile 能力自动迁移**：GUI 启动/切换时，旧 DeepSeek/Qwen profile 缺 `*_SUPPORTED_CAPABILITIES` 自动补（Rust `ensure_profile_capability_env`），免重建。

## 8. 发布平台（updates.py）运维 + 踩坑（重要）

**代码**：`claude-code-gui-release-platform/server/updates.py`（96 部署目录 `/root/claude-release-platform`，云 `/root/claude-code-gui-release-platform`；容器名 96=`claude-release-platform`、云=`release-platform`）。

### 平台目录（`_platform_dir`）
```python
def _platform_dir(version, platform):
    base = UPDATES_STORE / version
    return base if platform == "windows" else base / platform   # macos → {ver}/macos/
```
- windows 组件直接放 `{version}/`，macos 组件放 `{version}/macos/`。**旧 image 曾把 mac 写到根 → `latest?platform=macos` 找不到**（报 No updates）。修复后上传自动写对位置。

### 版本回收（必须）
`upload` 成功后 `_prune_old_versions(version)`：**只保留最近 N 版**（默认 3），删更旧。**用户永远拉最新，别每版囤一个副本**——否则 `updates-store` 把磁盘撑满（亲历云 98 版/96 98 版，40G 根 100%，容器写不进 → 上传假成功/卡死）。

### ⚠️ 磁盘满 = 发布"假成功/卡死"真因
容器写 updates-store（挂根分区），磁盘 100% 时写不进 430MB → `bash cloud_upload.sh` 卡几十分钟/返回 ok 但 `latest` 仍 No updates。**排障第一步 `df -h /`**，别归因 workbench/CPU/SSH。清 updates-store 旧版即刻释放。

### 改容器内 updates.py（秒级，不用 compose build）
```bash
docker cp /root/claude-code-gui-release-platform/server/updates.py release-platform:/app/server/updates.py
docker restart release-platform
```
容器源码是 image `COPY` 的（非挂载），`docker cp` 覆盖容器可写层 + `restart` 生效；`docker compose up -d --build` 每次重装依赖慢，且 **build context 含 bind 大目录（updates-store）会 `short read EOF`**——加 `.dockerignore` 排除 bind 大目录（updates-store），但**别排除被 Dockerfile `COPY` 的**（如 skills-store，否则报 not found）。

### workbench（云实例，SSH/SSM 两种连接）
- **SSH 模式**：`exec` 可用（`--timeout` 默认 30s，跑长命令要加大）；`upload`/`download` 都可用。
- **SSM 模式**：`exec` 报 `not supported in SSM mode`、`download` 不支持；`upload` 走 OSS 可用。
- **磁盘满会让实例被判成 SSM → exec 看似不可用**：先 `df -h` 清磁盘 + 重启实例，SSH 恢复后 exec 可用（别急着下"此路不通"结论）。
- workbench `upload` 到 `/tmp`（tmpfs）**重启实例会被清空** → 下次发布需重传组件。

### 验证
```bash
curl -s http://localhost:8765/api/updates/latest?platform=windows|macos   # 看 version + gui sha
# mac gui.sha=dir_content_hash(99f86df8…)，win gui=44ef712a…（本次 .26.4 实测）
```
mac 的 gui.sha 须用 `dir_content_hash`（.app 内容聚合），防 size-only 变化漏更新。
