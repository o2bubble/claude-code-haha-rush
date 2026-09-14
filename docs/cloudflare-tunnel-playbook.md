# Cloudflare Tunnel 实战手册 — 把本机服务暴露到公网

> 写于 2026-09-14，**本机实测跑通**（cloudflared v2026.9.1 / Windows 11）。
> 适用场景：**本机 → 公网**，不需要自己的服务器、不需要公网 IP。

## 📖 两份文档怎么选

| 文档 | 讲什么 | 什么时候看 |
|---|---|---|
| **本文**（`cloudflare-tunnel-playbook.md`） | CF Tunnel 的**通用用法**：快速隧道 / 命名隧道 / 服务化 / 原理 | 想在**任意机器**上暴露服务 |
| [`cloudflare-tunnel-cloud-playbook.md`](./cloudflare-tunnel-cloud-playbook.md) | **本环境的实战记录**：为什么改用 CF（企业网络封云主机）、7 个实测坑、诊断方法论 | 要动**本项目这套**（云服务器 / 17lumen.cloud 域名） |

> ⚠️ 本环境**实际在用**的是云版那份的方案（一条隧道 + 三个子域名
> `release`/`mem`/`mcp.17lumen.cloud`）。本文的"本机服务"用法在需要时同样可用。

## 0. 为什么不用云服务器 + frp

本机实测（2026-09-14）：

| 路径 | 结果 |
| --- | --- |
| 本机直连 `api.github.com` / `baidu.com` | ✅ 通 |
| 本机直连**云主机 IP**（`123.56.66.84`，以及阿里云/腾讯云/华为云的其它 IP） | ❌ **全超时** |
| 96 服务器 → 云（同一企业网络） | ❌ 也不通 |
| 手机 4G → 云 | ✅ 通 |
| **全球 6 国节点** → 云（check-host.net） | ✅ **6/6 全通** |

→ 云服务器本身完全正常，**是企业网络的出口策略在静默丢弃「目标为云主机 IP」的流量**
（实测：在云上加 iptables 计数规则，本机发起 3 次连接 → **云上收到 0 个包**）。

> ⚠️ **归因别下太死**：本机装有 `360DesktopLiteApp` + `0dcloudCore` + 奇安信天擎，
> 但**卸载深信服 VPN 后问题依旧** —— 说明是**企业网络层面的策略**，
> 不是某个软件能关掉的。排查时别在这几个软件上耗太久。

⚠️ **frp 在这种环境下用不了** —— frpc 的原理就是"本机 → 云公网 TCP"，这条路不通，装了也连不上。
（换网络环境后 **nps / frp** 这类自带服务端的方案依然是好选择，尤其是要给国内用户访问时。）

**Cloudflare Tunnel 的优势**：cloudflared **主动出站**连 Cloudflare（走 443/TCP），
不吃"访问特定 IP 段"的限制。

---

## 1. 原理（一句话）

```
外网访问者 → Cloudflare 边缘 → [cloudflared 建的出站长连接] → 本机服务
```

本机**主动拨出去**连 Cloudflare，公网流量沿着这条已建立的连接回灌到本机。
所以：**不需要公网 IP、不需要开放入站端口、不需要路由器端口映射。**

---

## 2. 安装

```bash
# 下载（本机 github 直连不通，走代理）
mkdir -p tools/cloudflared
curl -L -x http://127.0.0.1:17891 -o tools/cloudflared/cloudflared.exe \
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"

# 验证
./tools/cloudflared/cloudflared.exe --version
# → cloudflared version 2026.9.1 (built 2026-09-10T13:52 UTC)
```

> 其它平台把 `windows-amd64` 换成 `linux-amd64` / `darwin-arm64` 等。

---

## 3. 方式 A：快速隧道（免账号，最省事）

**特点**：不用注册、不用域名，命令一跑就给一个 `https://xxx.trycloudflare.com` 地址。

```bash
# 把本机 18999 端口暴露出去
./tools/cloudflared/cloudflared.exe tunnel --url http://127.0.0.1:18999 --no-autoupdate
```

启动后日志里会打印公网地址：

```
INF |  https://anymore-expectations-pro-nearest.trycloudflare.com  |
```

**实测验证**（2026-09-14）：

```
$ curl https://anymore-expectations-pro-nearest.trycloudflare.com/
<!DOCTYPE html> ... <h1>✅ 隧道打通了</h1> ...
[HTTP 200 | 总耗时 2.096s]
```

### ⚠️ 快速隧道的三个限制

1. **域名每次重启都变** —— 它是随机的，只能临时演示用
2. **不能作为 Windows 服务常驻**（因为域名不固定，服务化没有意义）
3. **带宽/稳定性无保证**，官方定位就是"测试用"

> 要给固定地址 → 看方式 B。

---

## 4. 方式 B：命名隧道（固定域名，需要账号）

**前提**：一个 Cloudflare 账号 + 一个托管在 Cloudflare 的域名（域名可以便宜买，CF 免费套餐够用）。

### 4.1 登录并创建隧道

```bash
# ① 浏览器登录授权（会打开浏览器，凭证存在 ~/.cloudflared/）
cloudflared tunnel login

# ② 创建隧道（名字自取）
cloudflared tunnel create my-tunnel
# → 生成 ~/.cloudflared/<UUID>.json（凭证文件，别外传）

# ③ 把域名解析指向隧道
cloudflared tunnel route dns my-tunnel app.example.com
```

### 4.2 写配置文件

`~/.cloudflared/config.yml`（Windows：`C:\Users\<你>\.cloudflared\config.yml`）：

```yaml
tunnel: my-tunnel
credentials-file: C:\Users\<你>\.cloudflared\<UUID>.json

ingress:
  # 多个服务就写多条 —— 按 hostname 分流
  - hostname: app.example.com
    service: http://127.0.0.1:3000
  - hostname: api.example.com
    service: http://127.0.0.1:8080
    originRequest:
      # 原服务是 https 且证书自签时
      noTLSVerify: true
  # ⚠️ 兜底规则必须放最后（匹配不到的请求）
  - service: http_status:404
```

### 4.3 运行

```bash
cloudflared tunnel run my-tunnel
```

---

## 5. 服务化（开机自启 + 后台常驻）

**方式 B（命名隧道）适用** —— 快速隧道域名会变，服务化没意义。

### ✅ 推荐：用配置文件安装（命令行，不涉及付款）

```bash
cloudflared --config C:\Users\<你>\.cloudflared\config.yml service install
cloudflared service uninstall     # 卸载
```

装完后在「服务」里能看到 `cloudflared agent`，设为自动启动即可。

（Linux 同理：`cloudflared --config /etc/cloudflared/config.yml service install`，
会创建 systemd 服务并把配置复制到 `/etc/cloudflared/config.yml`。）

### ⚠️ 不推荐：Zero Trust 面板拿 token

```bash
# 在 Cloudflare Zero Trust 面板 → Networks → Tunnels → 复制 token
cloudflared service install <TOKEN>
```

**实测坑（2026-09-14）**：首次进 Zero Trust 会被引导「选套餐」→
**跳到付款页要填银行卡**（即使选 $0 的 Free 套餐也要卡）。
**纯 Web 控制台管理不是必需** —— 命令行方式（`tunnel login` → `create` →
`route dns` → `service install`）全程不涉及任何支付。

> 💡 如果只是想建隧道 + 绑域名，**根本不需要进 Zero Trust**。

---

## 6. 本环境的三个实测坑（重要）

### ① QUIC 被企业网络限制 → 必须用 http2

cloudflared 默认走 **QUIC（UDP 7844）**。本机实测：

```
UDP Connectivity  region1  PASS    QUIC connection successful
UDP Connectivity  region2  FAIL    QUIC connection failed
WARNING: Allow outbound QUIC traffic on port 7844 or use HTTP2.
SUMMARY: Environment ready with degraded transport. cloudflared will proceed using 'http2'.
```

**它自己会降级到 http2**（走 TCP 443），所以能跑通 —— 但连接质量打了折扣。

**建议显式指定**：

```bash
cloudflared tunnel --url http://127.0.0.1:18999 --protocol http2
```

### ② 延迟高（绕境外）

实测日志显示连接的边缘节点是 **`location=lax12`（洛杉矶）**：

```
Registered tunnel connection connIndex=0 ip=198.41.192.167 location=lax12 protocol=quic
```

公网访问实测 **首字节 2.1s**。原因：**Cloudflare 免费版在国内没有节点**，
流量绕到美西/香港/新加坡再回来。

| 访问者 | 体验 |
| --- | --- |
| 自己 / 境外用户 | 可用 |
| **国内用户** | ⚠️ 200-400ms 起，晚高峰可能更差 |

**要给国内用户访问、且要求低延迟 → 走国内机房中转（nps / frp + 国内云）更合适。**

### ③ 企业管控软件可能干扰

本机装有 `360DesktopLiteApp`（企业管控）和 `0dcloudCore`（接管了系统代理 17891）。
如果隧道连不上，先确认是不是它们拦了 —— 用 `cloudflared tunnel diag` 生成诊断包。

---

## 7. 测速与验证

```bash
# 隧道连上后，先在本机验证（走公网域名回来）
curl -s -o /dev/null -w "HTTP %{http_code} | 首字节 %{time_starttransfer}s\n" \
  "https://<你的域名>/"

# 到 Cloudflare 的裸链路测速
curl -s -o /dev/null -w "下载 %{speed_download} B/s\n" \
  "https://speed.cloudflare.com/__down?bytes=10000000"
# 本机实测：2.76 MB/s（约 22 Mbps）
```

**最终验证**：用**手机 4G**（关 WiFi）访问公网地址 —— 这是唯一能证明"外网真的能进"的方式。

---

## 8. 安全（必读）

暴露到公网 = 任何知道地址的人都能访问你的本机服务。

| 措施 | 说明 |
| --- | --- |
| **自带鉴权** | 服务本身要有认证（如 Memory Web 的 bearer token）—— 最重要 |
| **Cloudflare Access** | 免费版可加一层 SSO/邮箱验证，只有白名单能访问（Zero Trust → Access） |
| **别暴露管理端口** | SSH / Docker API / 数据库**不要**直接映射出去 |
| **域名别太好猜** | 快速隧道的随机域名天然有此优势；命名隧道可考虑加随机路径前缀 |
| **限流** | `originRequest` 可配连接超时等；防扫描主要靠 CF 边缘 |

> ⚠️ 本项目的教训（2026-09-14）：**凭据绝不写进任何会被检索/分享的地方**。
> 配隧道时如果要用 token 鉴权，token 存在 `.private/` 或环境变量，别写进本手册这类文档。

---

## 9. 排错清单

| 现象 | 原因 / 解法 |
| --- | --- |
| `QUIC connection failed` | 企业网络限 UDP 7844 → 加 `--protocol http2` |
| 隧道连上但访问 404 | `ingress` 缺兜底规则 / hostname 与 `route dns` 不一致 |
| 访问 502 | 本机服务没起 / 端口写错 / 服务只监听 `127.0.0.1` 且被代理绕过 |
| 域名解析失败 | `route dns` 没执行，或域名不在 CF 托管 |
| 服务化后不启动 | 检查 `%USERPROFILE%\.cloudflared\` 下 config/凭证路径（服务以 SYSTEM 运行，路径要写绝对路径） |
| 想诊断 | `cloudflared tunnel diag`（生成诊断包，含网络连通性检查） |

---

## 10. 快速上手（TL;DR）

```bash
# 一次性：暴露本机 3000 端口
./tools/cloudflared/cloudflared.exe tunnel --url http://127.0.0.1:3000 --protocol http2 --no-autoupdate
# 日志里拿到 https://xxx.trycloudflare.com → 手机 4G 访问验证
```

**要固定地址** → 方式 B（需 CF 账号 + 域名）。
**要给国内用户低延迟访问** → 换国内中转（nps + 国内云），见本文件 §0。
