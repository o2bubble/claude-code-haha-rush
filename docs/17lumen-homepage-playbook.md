# 17lumen 备案主页 Playbook

> 备案站「一起留名」的部署、修改与运维手册。
> 首次上线：**2026-09-23**（HTTP + HTTPS 全通，外网实测 200）。

## 1. 站点身份

| 项 | 值 |
|---|---|
| 站名 | 一起留名 |
| Slogan | 十七流明 · IT 微光 / *A quiet light in IT.*（页脚彩蛋：微光一束，于此留名） |
| 域名 | `17lumen.com` · `www.17lumen.com` · `17lumen.cn` · `www.17lumen.cn` |
| 备案号 | 陕ICP备2026026135号-1（.com）/ -2（.cn） |
| 内容 | 单页静态站：项目简介（Claude Code Desktop）+ 备案信息 + 开源声明 |
| 定位 | 开源项目，仅供技术分享与学习交流，**不商业化** |

备案类型：个人网站 · 网站应用服务 · 主要分享个人开源项目与 IT 信息。

## 2. 云端布局

**服务器**：`i-2ze2rouoikcqrlbseu8a`（cn-beijing，公网 `123.56.66.84`）

```
/opt/17lumen/
├── site/index.html          ← 站点内容（部署时从仓库 homepage/index.html 上传）
├── nginx/conf.d/home.conf   ← nginx 站点配置
├── docker-compose.yml       ← nginx + certbot 两个容器
├── certbot/
│   ├── www/                 ← ACME HTTP-01 校验目录（webroot）
│   └── conf/                ← Let's Encrypt 证书（live/17lumen.com/）
└── setup-ssl.sh             ← 一键 HTTPS：查解析 → 签发 → 写配置 → reload
```

**容器**：

| 容器 | 镜像 | 职责 |
|---|---|---|
| `17lumen-web` | nginx:alpine | 80（301 跳 HTTPS）+ 443 SSL；每 6h `nginx -s reload` 让新证书生效 |
| `17lumen-certbot` | certbot/certbot | 每 12h 尝试续期（到期前 30 天才真正续） |

两者均 `restart: unless-stopped`，**服务器重启后自动拉起**。

**HTTPS 配置要点**（`home.conf` 最终态）：
- 80 端口保留 `/.well-known/acme-challenge/`（**续期校验必须走 80**，别删）
- 其余请求 301 跳 https
- TLS 1.2/1.3，HSTS，`X-Content-Type-Options: nosniff`

## 3. 日常改内容（最常用）

站点是**纯静态单文件**，改内容 = 改 HTML 再上传。

```bash
# ① 改仓库里的源文件
homepage/index.html

# ② 上传覆盖（MSYS_NO_PATHCONV 必须有，否则 Git Bash 会改写远程路径）
cd C:/Storage/claude-code-haha-dev
MSYS_NO_PATHCONV=1 python temp/wb.py upload \
  "C:/Storage/claude-code-haha-dev/homepage/index.html" \
  "/opt/17lumen/site/index.html"

# ③ 验证（从云端本机查，避免浏览器缓存干扰）
python temp/wb.py 'curl -s -H "Host: 17lumen.com" http://127.0.0.1/ | head -20'
```

> `temp/wb.py` 已内置 `--force`（workbench 覆盖已有文件必须带，否则非交互环境里
> 会被当成"用户取消"而静默失败）。它是 `workbench exec/upload` 的封装。

**仓库里 `homepage/` 的构成**：

```
homepage/
├── index.html              ← 站点源文件（唯一需要日常修改的）
└── deploy/                 ← 部署配置的权威副本（与云端保持一致）
    ├── docker-compose.yml
    ├── home.conf           ← 线上实际生效的 nginx 配置（HTTPS 版）
    └── setup-ssl.sh        ← 首次签证书用（内含同样的 conf，作为重建时的独立生成逻辑）
```

**要改线上 nginx 配置**，走「改仓库 → 上传 → 校验重载」：

```bash
cd C:/Storage/claude-code-haha-dev
# ① 改 homepage/deploy/home.conf
# ② 上传
MSYS_NO_PATHCONV=1 python temp/wb.py upload \
  "C:/Storage/claude-code-haha-dev/homepage/deploy/home.conf" \
  "/opt/17lumen/nginx/conf.d/home.conf"
# ③ 校验并重载（-t 通过才 reload，避免配错导致站点全挂）
python temp/wb.py 'docker exec 17lumen-web nginx -t && docker exec 17lumen-web nginx -s reload'
```

## 4. 访问通道（重要）

**本机/公司网络打不开 `123.56.66.84` 和这两个域名** —— 企业网络策略静默丢弃
「目标为云主机 IP」的流量（详见 `docs/cloudflare-tunnel-cloud-playbook.md` §1）。
这是环境限制，**不代表站点有问题**。

| 场景 | 通道 |
|---|---|
| 运维操作 | `python temp/wb.py "<command>"`（workbench，走阿里云内网） |
| 传文件 | `MSYS_NO_PATHCONV=1 python temp/wb.py upload <local> <remote>` |
| 验证站点是否真的通 | 手机流量打开，或 check-host.net 全球节点 |
| 本机浏览器预览改版效果 | 直接开本地 `homepage/index.html` |

**外网验证方法**（本机可用）：

```bash
curl -s -H "Accept: application/json" \
  "https://check-host.net/check-http?host=https%3A%2F%2F17lumen.com%2F&max_nodes=4"
# 等 ~20 秒取结果
curl -s -H "Accept: application/json" "https://check-host.net/check-result/<request_id>"
```

## 5. 证书与续期

| 项 | 值 |
|---|---|
| CA | Let's Encrypt（当前证书 2026-09-23 签发，**2026-12-22 到期**） |
| 覆盖域名 | 4 个域名合一（cert-name = `17lumen.com`） |
| 续期 | `17lumen-certbot` 容器每 12h 尝试；到期前 30 天自动续 |
| 联系邮箱 | `admin@17lumen.com`（`setup-ssl.sh` 内，**如需收到到期提醒请改成真实邮箱**） |

**手动续期 / 检查**：

```bash
# 检查续期是否正常（--dry-run 不真的签）
python temp/wb.py 'docker exec 17lumen-certbot certbot renew --dry-run'

# 立即续期（仅当快到期时）
python temp/wb.py 'docker exec 17lumen-certbot certbot renew'

# 查看证书到期时间
python temp/wb.py 'echo | openssl s_client -connect 127.0.0.1:443 -servername 17lumen.com 2>/dev/null | openssl x509 -noout -dates'
```

**重新签发**（比如证书损坏、要加/减域名）：改 `setup-ssl.sh` 的 `DOMAINS` 数组 →
重新上传 → `bash /opt/17lumen/setup-ssl.sh`（脚本会检测 DNS 后再签）。

## 6. 网络与安全组

**阿里云安全组** `sg-2ze6zy9h72b0i4r7gpyt`（sg-20260728）已放行：

| 规则 | 说明 |
|---|---|
| `TCP 80/80` → 0.0.0.0/0 | website http（2026-09-23 加） |
| `TCP 443/443` → 0.0.0.0/0 | website https（2026-09-23 加） |

查询/恢复脚本（都在 `homepage/deploy/`，用 workbench 配置里的 AK 调阿里云 API）：

| 脚本 | 用途 |
|---|---|
| `aliyun_sg.py` | **只读查询**所有入方向规则（排障第一步） |
| `aliyun_open_web.py` | 放行 80/443（幂等，**规则被误删时重跑即可恢复**） |

**DNS**（GoDaddy 或对应服务商，**灰云/仅 DNS，不要 CF 代理**）：

```
A  @    → 123.56.66.84
A  www  → 123.56.66.84
```

⚠️ 不要开 Cloudflare 橙云代理：① 国内访问走 CF 可能不稳；② Let's Encrypt 的
HTTP-01 校验需要直接打到源站。

## 7. 排障

| 症状 | 排查 |
|---|---|
| 网站打不开（本机） | 先确认是不是企业网络限制（换手机流量试） |
| 网站打不开（全球都不通） | `python temp/wb.py 'docker ps --filter name=17lumen'` 看容器是否在跑；再查安全组规则 |
| 改完内容不生效 | 浏览器缓存（强制刷新）；或 `curl -H "Host: 17lumen.com" http://127.0.0.1/` 直接验云端文件 |
| 证书报错 | `docker exec 17lumen-web nginx -t` 看配置；`docker logs 17lumen-certbot` 看续期日志 |
| 上传失败 | 是否带了 `MSYS_NO_PATHCONV=1`；`temp/wb.py` 是否还在（没它就得重写封装） |
| 容器没起来 | `cd /opt/17lumen && docker compose up -d`；日志 `docker logs 17lumen-web` |

## 8. 待办

- [ ] **公安联网备案号** —— 工信部备案通过后 **30 天内**在 [beian.gov.cn](https://beian.gov.cn)
      补办公安备案。拿到号后加进页脚（与 ICP 备案号并列），可能还要挂公安备案 logo
- [ ] 确认证书联系邮箱 `admin@17lumen.com` 是否需要改成真实邮箱

## 9. 相关

| 文档 | 说明 |
|---|---|
| `docs/cloudflare-tunnel-cloud-playbook.md` | 本环境网络限制的完整诊断（为什么本机连不上云 IP） |
| `homepage/deploy/wb.py` | workbench exec/upload 封装（**运维入口**；`temp/wb.py` 是同一份的临时副本） |
| `homepage/deploy/aliyun_sg.py` · `aliyun_open_web.py` | 安全组查询 / 放行脚本 |
