# Memory MCP 部署手册（Playbook）

> **操作手册**：照做即可发一次 memory 服务。**构建一律在本地做，线上永不构建**（线上资源有限）。
> 写于 2026-09-12（首次本地构建→云端切换验证通过）。
> 端口/挂载分布、检索层设计见 `docs/ARCHITECTURE.md` §6.3；HANDOFF 有决策留痕。

## 0. 架构速查

| | 云（123.56.66.84） | 96（内网 192.168.186.96） |
|---|---|---|
| 部署目录 | `/root/claude-memory/` | `/root/claude-memory/` |
| 容器名 | `claude-memory` | `claude-memory` |
| MCP 端口 | `8080:8080` | `14020:8080` |
| Web/REST 端口 | `40021:40021` | `40021:40021` |
| 宿主库 | `/data/memory/claude-memory.db` | `/data/claude-memory/claude-memory.db` |
| compose | `image: claude-memory:<版本>` | 同 |

**容器内跑两个进程**（`CMD` 一行起）：`server.py --transport sse`（8080，MCP）+ `api.py`（40021，Web/REST）。
两者**同时打开同一个 SQLite 文件**——所有并发相关的坑都源于此。

## 1. 本地构建

```bash
cd extensions/memory
docker build --platform linux/amd64 \
  --build-arg HTTP_PROXY= --build-arg HTTPS_PROXY= \
  --build-arg http_proxy= --build-arg https_proxy= \
  -t claude-memory:YYYYMMDD .
```

**⚠️ 构建踩坑（2026-09-12 实战）**：

- **必须清空 proxy build-arg**。Windows 系统代理（`127.0.0.1:17891`）会被 Docker 注入容器，pip 收到 SOCKS 代理但容器内没 `PySocks` → `ERROR: Could not install packages due to an OSError: Missing dependencies for SOCKS support`。清空后 pip 直接走阿里云镜像源（Dockerfile 里已配）。
- **Docker Desktop 的代理配置有两套**，改错地方无效：
  - `%APPDATA%\Docker\settings-store.json` —— 键名是 **`ProxyHTTPMode`**（HTTP 全大写！写成 `ProxyHttpMode` 会被静默忽略），`ProxyHttp` / `ProxyHttps` / `ProxyHttpsMode` / `ProxyExclude`。
  - `~/.docker/config.json` 的 `proxies` —— 只影响 `docker run`，**不影响 buildkit 拉基础镜像**。
  - **最省事的做法：两处都留空，让 Docker Desktop 回落到 Windows 系统代理**（系统代理已指向 17891 时可直接拉到 Docker Hub）。
- **基础镜像拉不下来先查 DNS**：报错里出现 `2a03:2880:f1xx:...` 这类 IPv6 地址是 DNS 污染，不是网络不通。配好代理即可。
- 前端 `web/dist/` 是**预构建产物**，Dockerfile 只 `COPY` 不构建。若要改 Web UI 需另行构建（见 §6 密码注入）。

## 2. 本地冒烟测试（必做，别跳过）

```bash
docker run -d --name mem-smoke -p 18080:8080 -p 14021:40021 claude-memory:YYYYMMDD
sleep 10 && docker ps --filter name=mem-smoke --format "{{.Status}}"
docker logs mem-smoke 2>&1 | grep -v "^INFO:" | tail -12
```

**期望日志**（`fts=on` + `tokenizer=jieba` 是核心）：

```
[memory-mcp] Database ready (0 memories, fts=on, tokenizer=jieba).
[memory-mcp] Streamable HTTP server listening on 0.0.0.0:8080
[memory-api] REST API listening on 0.0.0.0:40021
```

冒烟测出过真 bug（`_ensure_meta` 双进程竞态，容器启动即崩），**这一步能省掉一次线上事故**。

Web 端验证（MCP JSON-RPC，改 `initialize` → `tools/list` → `tools/call`）：

```python
import json, urllib.request
def call(method, params=None, rid=[0]):
    rid[0] += 1
    body = {"jsonrpc":"2.0","id":rid[0],"method":method}
    if params is not None: body["params"] = params
    req = urllib.request.Request("http://127.0.0.1:18080/mcp", data=json.dumps(body).encode(),
        headers={"Content-Type":"application/json","Accept":"application/json, text/event-stream"})
    with urllib.request.urlopen(req, timeout=30) as r: raw = r.read().decode()
    for line in raw.splitlines():
        if line.startswith("data: "): raw = line[6:]
    return json.loads(raw)
call("initialize", {"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"x","version":"1"}})
print(len(call("tools/list", rid=[9])["result"]["tools"]), "tools")   # 应为 10
```

## 3. 上传到云

云 `123.56.66.84` 不能 HTTP 直连做文件传输 → **走 workbench**（`workbench upload` 经 OSS 中转）。

```bash
docker save claude-memory:YYYYMMDD -o /tmp/cm.tar && gzip -f /tmp/cm.tar   # ~81MB
```

```python
import subprocess
wb = r'C:\Program Files\workbench\workbench.exe'
r = subprocess.run([wb, 'upload', 'cm.tar.gz', '/root/',
                    '--instance-id', 'i-2ze2rouoikcqrlbseu8a', '--region', 'cn-beijing', '-f'],
                   capture_output=True, timeout=1800)
```

**⚠️ workbench 踩坑**：

- **Git Bash 直调会报 `missing port in address`** → 必须用 **Python subprocess** 调。
- **输出含进度条 Unicode（如 `⠇`）**，Windows 默认 GBK 解码会抛 `UnicodeEncodeError` 并**吞掉真实 rc**（rc=0 却显示失败）。用 `capture_output=True` 收字节 + `.decode('utf-8', errors='replace')`，别直接 print。
- `--timeout` 默认 30s，长命令要显式加大。
- `workbench list` 在 AK 模式下返回空 `{"instances": []}`，属正常；**直接用已知 instance-id 即可**。

## 4. 云端切换

**顺序很重要**：先备份 DB → 再 checkpoint → 再换镜像。

```bash
# ① 用 SQLite backup API 备份（见下方 ⚠️，不要用 cp）
docker exec claude-memory python -c "
import sqlite3
src=sqlite3.connect('/data/claude-memory.db')
dst=sqlite3.connect('/data/claude-memory.db.bak.YYYYMMDD')
src.backup(dst); dst.close(); print('备份完成')"

# ② WAL checkpoint 落盘（保证数据都写进主库）
docker exec claude-memory python -c "
import sqlite3
c=sqlite3.connect('/data/claude-memory.db')
c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
print('memories:', c.execute('SELECT COUNT(*) FROM memories').fetchone()[0])"

# ③ 旧镜像打回滚 tag（别丢），加载新镜像
docker tag claude-memory:latest claude-memory:rollback-YYYYMMDD
gunzip -c /root/cm.tar.gz | docker load

# ④ 旧容器必须手动移除（它不属于新的 compose 项目，不删会撞名）
docker stop claude-memory && docker rm claude-memory
cd /root/claude-memory && docker compose up -d
```

**⚠️ 数据备份的坑（2026-09-12 踩到）**：

- **`cp claude-memory.db` 备份是废的**！WAL 模式下数据可能全在 `-wal` 文件里——实测主库 4KB、WAL 2.2MB，`cp` 出来的备份只有 4KB，**18 条记忆全丢**。
- **必须用 SQLite `backup()` API**（会正确处理 WAL），或用容器内的 `sqlite3` 命令行 `.backup`。
- 备份后用 `db_size_kb` 校验：新版 `memory_stats` 会返回准确大小（旧版算错，报 4.0 而实际 108）。

**⚠️ compose 切换（`build: .` → `image:`）**：
云端 compose 必须写 `image: claude-memory:<tag>`。若留 `build: .`，`docker compose up -d` 会尝试**线上构建**——正是要避免的。`Dockerfile` / `.dockerignore` 已从云端运行目录移除（挪到 `.old/`）。

## 5. 验证

```bash
# 云端内部
docker ps --filter name=claude-memory --format "{{.Image}}|{{.Status}}"   # 应 healthy
docker logs claude-memory 2>&1 | grep -v "^INFO:" | tail -6              # fts=on, tokenizer=jieba
# 外部（公网）
curl -s http://123.56.66.84:8080/health                                   # {"status":"ok"}
```

功能验证走 MCP（§2 的 `call` 改 URL 为 `http://123.56.66.84:8080/mcp`）：

- `memory_stats` → `capabilities.fts == true`、`tokenizer == "jieba"`、`total_memories` 与升级前一致
- `memory_search(scope=["project:*"])` → 有结果；`scope=["domain:*"]` → **空数组**（不是全集）

## 6. Web UI 密码构建注入（重建前端时必读）

`Login.jsx` 的密码来自 `import.meta.env.VITE_MEMORY_PASSWORD`，**fail-closed**（未注入 → 空字符串 → 拒绝一切登录）。

```bash
cd extensions/memory/web && VITE_MEMORY_PASSWORD=<值> bun run build
```

值见内部凭据笔记。忘记注入 → 构建产物 `PASSWORD=''` → 登录全被拒。**当前 `web/dist/` 是 8-23 的旧构建，未含此改动**——只要不重建前端，行为保持不变。

## 7. 常用运维

```bash
# 看容器实时日志
docker logs -f claude-memory
# 改代码后热更（不重建镜像）
docker cp <file> claude-memory:/app/<file> && docker restart claude-memory
# 回滚
docker tag claude-memory:rollback-YYYYMMDD claude-memory:latest
cd /root/claude-memory && docker compose up -d
```

**DB 路径**：容器内 `/data/claude-memory.db`（由 `DB_PATH` env 决定），宿主 `/data/memory/`（compose bind mount）。

## 8. 本项目特有：同时改云端与 96

96 与云是**两套独立部署**，端口/挂载都不同（见 §0 表），镜像需分别上传。本次升级只做了云——**96 仍为旧版**（14020 端口那份）。同步时记得 96 的 compose 端口映射是 `14020:8080`，别照抄云的。
