# 发布平台域名迁移：Cloudflare 隧道 → 自有域名

> 2026-10-25 · 已切换完成 · 状态：`release` / `mem` / `mcp` 走自有域名，`nps` 保持原样

## 为什么切

| 指标 | CF 隧道 | 自有域名 | 差异 |
|---|---|---|---|
| 国内访问耗时 | **3.27s** | **0.26s** | **快 12 倍** |
| 单请求体上限 | **100MB**（Cloudflare 免费版）| 500MB（可用）| 发版不再撞 413 |

原本走 CF 的原因是「**企业网络封禁对云主机 IP 的访问**」（见
`docs/cloudflare-tunnel-cloud-playbook.md`）。2026-10-25 实测该限制已不存在
（直连云 `123.56.66.84:8765` 返回 404，正常响应），因此可以直连。

## 当前架构

```
                                   ┌─ 17lumen-web (nginx:alpine) :80/:443
                                   │    ├─ www.17lumen.com  → 官网静态页（不动）
用户 ──直连──> 123.56.66.84 ───────┤    ├─ release.17lumen.com → 172.17.0.1:8765
                                   │    ├─ mem.17lumen.com     → 172.17.0.1:40021
                                   │    └─ mcp.17lumen.com     → 172.17.0.1:8080

用户 ──CF───> *.17lumen.cloud ────> cloudflared 隧道 ──> 127.0.0.1:<port>
              （保留作为备选，老客户端仍用它）
```

### 端口与域名对照

| 域名 | 后端 | 容器 | 状态 |
|---|---|---|---|
| `www.17lumen.com` / `.cn` / 裸域 | 静态页 `/opt/17lumen/site` | 17lumen-web | 不变 |
| `release.17lumen.com` | `:8765` 发布平台 | release-platform | **新** |
| `mem.17lumen.com` | `:40021` Memory Web | claude-memory | **新** |
| `mcp.17lumen.com` | `:8080` Memory MCP | claude-memory | **新** |
| `nps.17lumen.com` | `:50003` nps 面板 | 宿主机 | **保持 CF** |

## 配置位置

| 文件 | 作用 |
|---|---|
| `/opt/17lumen/nginx/conf.d/home.conf` | 官网（**未改**）|
| `/opt/17lumen/nginx/conf.d/subdomains.conf` | **新增**，三个子域名 |
| `/opt/17lumen/docker-compose.yml` | certbot 加了 `dns:` |
| `/opt/17lumen/certbot/conf/renewal/17lumen.com.conf` | 7 个域名的 webroot_map |

备份：
- `/opt/17lumen/nginx/conf.d.bak-20261025-2235`
- `/opt/17lumen/docker-compose.yml.bak-20261025-2247`

## 🔴 三个必须记住的坑

### ① `proxy_pass` 不能用 `127.0.0.1`

nginx 跑在**容器里**，`127.0.0.1` 指容器自身。而 `release-platform` /
`claude-memory` 都在**各自独立的 docker 网络**（不是 nginx 那个 `17lumen_default`）。

**必须用 `172.17.0.1`（docker0 网关）** —— 实测可达。

### ② certbot 容器必须显式指定 DNS

本机 `/etc/resolv.conf` 指向 `127.0.0.53`（systemd-resolved），**容器里的回环地址不可用**。

试过 `network_mode: host` → 反而继承了 `127.0.0.53`，更糟。
**最终方案**：默认网络 + `dns: [223.5.5.5, 223.6.6.6]`。

> 附带收益：这台机器 **IPv6 出口不通**，而 ACME 端点有 AAAA 记录。
> 用阿里云 DNS 后 certbot 能正常走 IPv4 完成校验。

### ③ 续期配置的 `webroot_map` 要含全部域名

`certbot certonly --expand` **不会**自动补全新域名的 webroot_map。
本次切域名后就发现配置里只有旧的 4 个域名 → 已手工补全为 7 个。

## 证书

```
域名：7 个（4 个旧 + 3 个新）
有效期：2026-10-25 → 2027-01-23
自动续期：容器内 while 循环，每 12 小时试一次
```

**续期后 nginx 会自动生效** —— 17lumen-web 容器里有独立的
`while :; do sleep 6h; nginx -s reload; done` 循环（进程 7 + 542）。

## 验证方法

```bash
# 新域名
curl -s "https://release.17lumen.com/api/updates/latest?platform=windows" | head -c 100
curl -sI https://mem.17lumen.com/ | head -1
curl -s -o /dev/null -w "%{http_code}\n" https://mcp.17lumen.com/    # 401 = 正常（要鉴权）

# 旧 CF 域名仍可用
curl -s -o /dev/null -w "%{http_code}\n" https://release.17lumen.cloud/api/updates/latest

# 续期链路（**必须先停掉 certbot 容器**，否则锁冲突）
docker stop 17lumen-certbot
docker run --rm --dns 223.5.5.5 --dns 223.6.6.6 \
  -v /opt/17lumen/certbot/conf:/etc/letsencrypt \
  -v /opt/17lumen/certbot/www:/var/www/certbot \
  certbot/certbot renew --dry-run --webroot -w /var/www/certbot
docker start 17lumen-certbot
```

## 遗留：客户端仍指向旧域名

`gui/src/utils/serverProfile.ts` 等 3 处写死 `https://release.17lumen.cloud`。
**老用户手里的 exe 不会自动改** → CF 隧道必须保留，直到用户完成迁移。

下一步要做的：
- 客户端 URL 改为 `https://release.17lumen.com`
- 加迁移函数（照 `migrations.rs` 的 `migrate_legacy_cloud_url` 写法，
  从 `release.17lumen.cloud` → `release.17lumen.com`）
- 发版，等用户更新后再考虑停 CF
