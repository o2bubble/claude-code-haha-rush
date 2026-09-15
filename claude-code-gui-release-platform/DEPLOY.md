# release-platform 部署指南

> ⚠️ **铁律：镜像一律在本地构建，服务器只做 `docker load`。**
> 云服务器是 **2核2G + `cloud_essd_entry`**（ESSD 入门级，IOPS 上限仅 2520），
> **扛不住 `docker build`**（pip 安装 + 层解压的 I/O 会把磁盘打满，导致全系统卡顿）。
> 详见 `docs/§ 云服务器性能事故`。

---

## 0.5 必须配置的环境变量（⚠️ 最容易漏）

管理后台（`/admin`）靠这两个变量工作，**两侧 compose 都要配**：

| 变量 | 作用 | 缺失后果 |
|---|---|---|
| `ADMIN_PASSWORD` | 后台登录口令 | `/api/admin/*` 一律返回 **503**，新后台登不进去 |
| `SITE_NAME` | 顶栏显示的实例名 | 显示 `release-platform`（无法区分看的是哪台） |
| `ADMIN_TOKEN_SECRET` | （可选）token 签名密钥 | 缺省从 `ADMIN_PASSWORD` 派生，够用 |

```yaml
environment:
  - ADMIN_PASSWORD=<口令>          # 值见笔记『账号密码』
  - SITE_NAME=96 内网              # 云侧写「云生产」
```

> 两侧 `registry.db` 是**两份独立库**（96 在 `/root/claude-release-data/`，
> 云在项目目录下）→ 统计数字天然不同，靠 `SITE_NAME` 区分，不要误以为是同一份数据。
>
> **应急入口**：口令配错导致进不去新后台时，用 `/admin-legacy` ——
> 旧页面无需登录、直连公开 API，可临时改反馈状态。

---

## 0.6 备份（改任何东西之前先做）

```bash
STAMP=$(date +%Y%m%d)
mkdir -p /root/backup-release-platform
# 数据库 + 反馈图片
cd <数据目录> && tar czf /root/backup-release-platform/data-$STAMP.tar.gz \
    registry.db registry.db-wal registry.db-shm feedback-images
# compose
cp docker-compose.yml /root/backup-release-platform/docker-compose.yml.bak.$STAMP
```

**回滚锚点**：把当前运行的镜像固定成一个不会被覆盖的 tag：

```bash
# 96（有私有 registry）
docker tag <当前镜像> 192.168.186.96:5000/claude-release-platform:rollback-$STAMP
docker push 192.168.186.96:5000/claude-release-platform:rollback-$STAMP
# 云：compose 里用的是日期 tag，旧 tag 天然保留，无需额外操作
```

> 为什么必须做：新版本发布时会用**新日期 tag**，若直接覆盖 `:latest`
> 就没有可回退的镜像了。数据库新增列（如 `feedback.note`）虽然向后兼容，
> 但回滚时保留一份 db 快照总是更稳。

---

## 0. 本机构建环境：WSL

Windows 侧没装 Docker Desktop，用 **WSL 里的 Docker**：

| 项 | 值 |
|---|---|
| 发行版 | `Ubuntu-22.04` |
| Docker | 28.5.1（overlay2 / cgroup v2） |
| 资源 | 12 核 / 15.5 GB 内存 |

### ⚠️ 代理配置（必须，否则拉不到基础镜像）

WSL 里访问宿主机的代理要**用网关 IP**，不是 `127.0.0.1`：

```bash
# 在 WSL 里查网关
ip route | grep default | awk '{print $3}'     # 例：172.25.208.1
```

**Docker daemon 代理**（一次性配置）：

```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/proxy.conf <<'EOF'
[Service]
Environment="HTTP_PROXY=http://172.25.208.1:17891"
Environment="HTTPS_PROXY=http://172.25.208.1:17891"
Environment="NO_PROXY=localhost,127.0.0.1,192.168.186.96,192.168.0.0/16,172.25.0.0/16"
EOF
sudo systemctl daemon-reload && sudo systemctl restart docker
```

> ⚠️ 网关 IP 在 WSL 重启后**可能变化**（`172.25.x.1`）→ 拉不到镜像时先查网关。
> 若 WSL 重启后 docker 起不来，检查 `proxy.conf` 里的 IP 是否还有效。

---

## 1. 本地构建

```bash
# 在 WSL 里执行
cd /mnt/c/Storage/claude-code-haha-dev/claude-code-gui-release-platform
export HTTP_PROXY=http://172.25.208.1:17891
export HTTPS_PROXY=http://172.25.208.1:17891
export NO_PROXY=localhost,127.0.0.1

docker build -t claude-release-platform:YYYYMMDD .
```

**版本 tag 用日期**（如 `20260915`），便于回滚。

> **Docker daemon 没在跑**时：`sudo systemctl start docker`（WSL 重启后不会自动起）。

### 多阶段构建（2026-09-15 起）

镜像现在是**两阶段**：阶段 1 用 `oven/bun:1` 构建管理后台前端（Vite + React），
阶段 2 把产物 `COPY --from=web` 到 `static/admin/`。

- **不需要**在本地先跑 `bun run build` —— 容器内会构建，避免"忘了构建就发旧前端"
- 用 `oven/bun` 而非 node：仓库只有 `bun.lock`，没有 `package-lock.json`，`npm ci` 会失败
- `web/bunfig.toml`（含国内 npm 镜像）必须与 `package.json` **同批 COPY**，否则 install 走默认源会超时
- `static/admin/` 在 `.dockerignore` 里**被排除**：唯一来源是阶段 1，防止本机残留产物混进上下文

### 构建产物验证

```bash
docker run --rm claude-release-platform:YYYYMMDD sh -c 'ls /app/ /app/static/'
# 期望：main.py requirements.txt server/ static/  +  static/admin/ static/admin.html
# ⚠️ 不应有 skills-store / updates-store / registry.db（都是运行时数据，见 .dockerignore）
# ⚠️ static/admin/ 必须存在且有 index.html + assets/ —— 缺了说明前端阶段没成功
```

---

## 2. 导出 + 上传

```bash
# WSL 里导出到 Windows 可访问路径（temp/ 已 gitignore）
docker save claude-release-platform:YYYYMMDD -o /mnt/c/Storage/claude-code-haha-dev/temp/crp-YYYYMMDD.tar
gzip -f /mnt/c/Storage/claude-code-haha-dev/temp/crp-YYYYMMDD.tar
# → 约 50MB（145MB 镜像压缩后）
```

```python
# Windows 侧上传（workbench 必须用 Python subprocess 调）
import subprocess
WB = r"C:\Program Files\workbench\workbench.exe"
subprocess.run([WB, "upload", "temp/crp-YYYYMMDD.tar.gz", "/root/",
                "-i", "i-2ze2rouoikcqrlbseu8a", "-r", "cn-beijing", "-f"], timeout=1800)
```

> ⚠️ 在 Python 里调 workbench 要设 `PYTHONIOENCODING=utf-8`
> （进度条的 Braille 字符会让 Windows GBK 控制台崩）

---

## 3. 云端切换（**只 load，绝不 build**）

用 `RunCommand` API（比 `workbench exec` 稳，后者在资源紧张时会超时）：

```python
from aliyunsdkecs.request.v20140526.RunCommandRequest import RunCommandRequest
# set_InstanceIds([...])（复数）；RegionId 由 client 提供
```

云端脚本：

```bash
cd /root/claude-code-gui-release-platform

# ① 备份 compose
cp docker-compose.yml docker-compose.yml.bak.$(date +%Y%m%d)

# ② 加载镜像（服务器只 load）
gunzip -c /root/crp-YYYYMMDD.tar.gz | docker load

# ③ compose 指向新镜像（⚠️ 不要用 build: .，那会触发服务器构建）
# image: claude-release-platform:YYYYMMDD
sed -i 's|^    build: \.$|    image: claude-release-platform:YYYYMMDD|' docker-compose.yml

# ④ 重建容器
docker compose up -d

# ⑤ 验证
docker inspect release-platform --format '{{.Config.Image}}'
docker logs release-platform --tail 20 | grep -iE "reload|watch|Uvicorn running"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/api/updates/latest

# ⑥ 清理上传的包
rm -f /root/crp-YYYYMMDD.tar.gz
```

**验证要点**：
- 镜像 tag 正确
- 日志**不应**出现 `Started reloader process ... using StatReload`（生产必须关 reload）
- 数据完好：`docker exec release-platform ls /app/skills-store | wc -l`
- 服务返回 200

---

## 4. compose 配置要点

```yaml
services:
  release-platform:
    image: claude-release-platform:YYYYMMDD   # ⚠️ 不是 build: .
    container_name: release-platform
    ports:
      - "8765:8765"
    volumes:                                   # 运行时数据，与镜像分离
      - ./skills-store:/app/skills-store
      - ./updates-store:/app/updates-store
      - ./feedback-images:/app/feedback-images
      - ./registry.db:/app/registry.db
    restart: unless-stopped
```

**为什么用 `image:` 而不是 `build: .`**：`build: .` 会在**服务器上**构建 —— 那正是要避免的。

---

## 4.5 部署后必查：SPA 入口的缓存头

**症状**：部署成功（`docker inspect` 显示新 tag、curl `/admin` 返回新 SPA），
但浏览器里仍是**旧页面**。

**根因**：`FileResponse` 默认只带 `last-modified` / `etag`，**不带 `Cache-Control`**。
这种响应浏览器会走「启发式缓存」——按 `(现在 − last-modified) × 10%` 估算可缓存时长。
旧 `admin.html` 的修改时间很老，算出来能缓存好几天，于是浏览器直接用缓存、
连服务端都不问。

**修复**：`main.py` 里 SPA 入口（`/admin`、`/feedback`、`/admin-legacy`）的
`FileResponse` 统一带 `Cache-Control: no-cache, must-revalidate`
（是 no-cache 而非 no-store：允许缓存但每次必须回源验证，命中 304 还省流量）。
静态资源不用管，文件名带 hash、内容变则 URL 变。

**验证**：
```bash
curl -s -D - -o /dev/null http://<host>:8765/admin | grep -i cache-control
# 期望：cache-control: no-cache, must-revalidate
```

> ⚠️ 该头**只对新的响应生效**。已经缓存的旧响应仍按旧规则判断 ——
> 修复上线后，用户需要**强刷一次**（Ctrl+Shift+R），之后才恢复正常。

---

## 4.6 workbench 调用的两个坑

1. **Braille 进度条**：`workbench upload` 的输出含 U+28xx 盲文字符，
   Windows 下 Python 以 GBK 打印会 `UnicodeEncodeError` 崩掉。
   → 用 `re.sub(r'[^\x20-\x7e\n]', '', output)` 过滤后再打印。
2. **默认命令超时 30 秒**：`workbench exec` 的 `--timeout` 默认仅 30s，
   长任务（`docker load`）会中途被杀。
   → 显式传 `--timeout 600`。

**顺序纪律**：切换 compose 的 `image:` **之前**，必须先确认新镜像已在服务器上
（`docker image inspect <tag>`）。否则 compose 指向不存在的镜像 —— 容器会保持
原样运行（服务不挂）但状态与配置不一致，下次重启就起不来了。

---

## 5. 回滚

```bash
cd /root/claude-code-gui-release-platform
cp docker-compose.yml.bak.YYYYMMDD docker-compose.yml   # 或用旧 tag
docker compose up -d
```

旧镜像保留在 `docker images` 里（如 `claude-release-platform:latest`），
把 compose 的 `image:` 改回旧 tag 即可。

---

## 6. 生产环境禁止 reload

`main.py` 里：

```python
_reload = os.environ.get("RELOAD") == "1"      # 默认关
uvicorn.run("main:app", host="0.0.0.0", port=8765, reload=_reload)
```

**为什么**：`reload=True` 起一个 StatReload 进程**持续扫描整个工作目录**。
本项目 `skills-store` 有 160MB，实测在 2核小机上：
**持续 18% CPU、5 天烧 22 小时 CPU**，内存紧张时 stat 引发 inode 缺页读盘，
把入门级 ESSD 的 IOPS 打满 → 全系统卡死（`load 9.3`、`iowait 84.6%`）。

本地开发要热重载时：`RELOAD=1 python main.py`。

---

## 7. 快速热更（不改代码结构时）

**只改 Python 源码**（如 `main.py` / `server/*.py`）时，可以不重建镜像：

```bash
docker cp main.py release-platform:/app/main.py
docker restart release-platform
```

> ⚠️ 这是**临时手段** —— 容器重建后改动会丢失（回到镜像里的版本）。
> 正式发布仍应走「本地构建 → 上传 → load」。
> 且本地源码也要同步改，否则下次重建会把改动冲掉。
