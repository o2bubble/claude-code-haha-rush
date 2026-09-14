# release-platform 部署指南

> ⚠️ **铁律：镜像一律在本地构建，服务器只做 `docker load`。**
> 云服务器是 **2核2G + `cloud_essd_entry`**（ESSD 入门级，IOPS 上限仅 2520），
> **扛不住 `docker build`**（pip 安装 + 层解压的 I/O 会把磁盘打满，导致全系统卡顿）。
> 详见 `docs/§ 云服务器性能事故`。

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

**版本 tag 用日期**（如 `20260914`），便于回滚。

### 构建产物验证

```bash
docker run --rm claude-release-platform:YYYYMMDD sh -c 'ls -la /app/'
# 期望看到：main.py  requirements.txt  server/  static/
# ⚠️ 不应有 skills-store / updates-store / registry.db（都是运行时数据，见 .dockerignore）
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
