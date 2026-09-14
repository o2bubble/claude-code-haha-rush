# Cloudflare Tunnel 实战 · 暴露云服务器服务（2026-09-14 完整记录）

> **场景**：本机在公司网络内，**企业网络封禁了对云主机 IP 的访问** → 无法直接连自己的云服务器。
> **解法**：让**云主动连出来**（Cloudflare Tunnel），本机通过 CF 域名访问，绕开限制。
> **本文档记录全过程、真实踩的坑、以及可复用的判断方法。**
>
> 配套文档：`docs/cloudflare-tunnel-playbook.md`（本机服务暴露的通用手册）

---

## 0. 一句话原理

```
你（受限制的网络）→ Cloudflare 边缘 → [云主动建立的出站隧道] → 云上 127.0.0.1:8765
      ✅ 放行              ✅ 出站不拦              ✅ 本地服务
```

**关键洞察**：企业网络拦的是「**你主动连云**」（入站方向的连接发起），而 CF 是「**云主动连出来**」（出站），**方向相反** → 不受同一策略影响。

---

## 1. 问题诊断（这部分最值得复用）

### 1.1 症状

本机访问云 `123.56.66.84` 的所有端口（22/8765/8080/40021）**全部超时**，但访问百度、GitHub 正常。

### 1.2 逐步排除（每一步都要有证据，别猜）

| 假设 | 验证方法 | 结论 |
|---|---|---|
| 密码/端口配错 | `workbench exec` 能进云 | ❌ 排除 |
| 阿里云安全组拦截 | `DescribeSecurityGroupAttribute` API 查询 | ❌ 规则正确（8765 放行 0.0.0.0/0） |
| 云机器 iptables | `iptables -L INPUT -n` | ❌ policy ACCEPT，无规则 |
| 网络 ACL | `DescribeNetworkAcls` API | ❌ 未绑定子网，不生效 |
| DDoS 黑洞 | 控制台「拦截查询」7 天记录 | ❌ 零记录 |
| VPN 出口 IP 被封 | **卸载深信服 VPN 后重测** | ❌ 仍然不通 |
| **企业网络封云主机** | **全球 6 国节点测试** | ✅ **确认** |

### 1.3 决定性证据（两个）

**① 全球节点测试** —— 用第三方服务从世界各地的机器测你的云：

```bash
curl -H "Accept: application/json" \
  "https://check-host.net/check-tcp?host=123.56.66.84:8765&max_nodes=6"
# 隔 15 秒取结果
curl -H "Accept: application/json" "https://check-host.net/check-result/<request_id>"
```

**实测结果**：印度/意大利/荷兰/乌克兰/英国/美国 **6/6 全通** → **云本身完全正常**。

**② 云端 iptables 计数** —— 证明包有没有到达云：

```bash
# 在云上加计数规则
iptables -I INPUT -p tcp --dport 7000 -j ACCEPT
# 等 25 秒（期间从本机发起连接）
sleep 25
iptables -L INPUT -v -n --line-numbers
# 清理
iptables -D INPUT -p tcp --dport 7000 -j ACCEPT
```

**实测结果**：`pkts = 0` → **云上一个包都没收到** → 包在**到达云之前**就被丢弃。

### 1.4 结论

**企业网络（DLP 类策略）静默丢弃了「目标为云主机 IP」的流量。**

- 本机 + 96（同一企业网络）→ ❌ 都不通
- 手机 4G、全球节点 → ✅ 都通
- 拦的是**云主机 IP**，不是所有外网（百度/GitHub 正常）

---

## 2. 为什么 frp 不可行（对比说明）

frp 的架构是 **frpc（本机）主动连 frps（云）**：

```
本机 frpc ──TCP──> 云 frps:7000        ← 这条正是被拦的路径
```

**所以 frp 在当前网络下用不了**，换端口/换协议都没用（拦的是 IP 不是端口）。

| 方案 | 连接方向 | 当前网络 |
|---|---|---|
| frp | 本机 → 云（入站方向发起） | ❌ 被拦 |
| **CF Tunnel** | 云 → CF（**出站**） | ✅ 可用 |

> 💡 **判断口诀**：受限制的网络里，**「让远端连出来」永远比「自己连过去」更可能成功**。

---

## 3. 部署实战

### 3.1 前置检查（先确认云能连 CF）

```bash
# 在云上执行
for h in region1.v2.argotunnel.com region2.v2.argotunnel.com; do
  python3 -c "
import socket
try:
    s=socket.create_connection(('$h',7844),timeout=8); s.close(); print('$h:7844 通')
except Exception as e: print('$h:7844', type(e).__name__)
"
done
```

> ⚠️ 注意：**`https://region1.v2.argotunnel.com/` 返回 000 是正常的** —— 那个端点只收 QUIC（UDP 7844），不响应 HTTP。别被这个误导。

### 3.2 安装 cloudflared

```bash
# 云上（github 可达时）
mkdir -p /root/cloudflared && cd /root/cloudflared
curl -sL -o cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x cloudflared
./cloudflared --version
```

> 💡 **下载慢的话**：本地走代理下载再 `workbench upload` 上传（见 §5 坑 3）

### 3.3 快速隧道（免账号，立即可用）

```bash
cd /root/cloudflared
nohup ./cloudflared tunnel --url http://127.0.0.1:8765 --protocol http2 --no-autoupdate \
  > quick-tunnel.log 2>&1 &

sleep 18
# 取公网地址
grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" quick-tunnel.log | tail -1
```

**输出**：`https://globe-medium-wallpapers-rabbit.trycloudflare.com`

**验证**（从受限制的本机访问）：
```bash
curl "https://globe-medium-wallpapers-rabbit.trycloudflare.com/api/updates/latest?platform=windows"
# → {"ok":true,"data":{"version":"2026.09.13.8",...}}   ✅ 通了！
```

> ⚠️ **快速隧道的局限**：域名随机，**重启就变**；不能服务化。适合临时验证。

### 3.4 固定域名（✅ 2026-09-14 完成，用 `release.17lumen.cloud`）

> ⚠️ **走命令行，不要走 Zero Trust Dashboard** —— 后者首次使用会引导选套餐 →
> 跳到 **付款页要银行卡**（即使选 $0 的 Free）。命令行方式**不涉及任何付款**。

**① 本机登录授权**（本机能走代理访问 CF）

```bash
export HTTPS_PROXY=http://127.0.0.1:17891
cloudflared tunnel login
# → 打印一个 dash.cloudflare.com/argotunnel?... 授权 URL
```

浏览器打开该 URL → 选域名（`17lumen.cloud`）→ 点 **Authorize**
→ 凭证保存到 `~/.cloudflared/cert.pem`

**② 创建隧道 + 绑定域名**

```bash
cloudflared tunnel create 17lumen-cloud
# → ~/.cloudflared/<UUID>.json（凭证，含密钥）

cloudflared tunnel route dns 17lumen-cloud release.17lumen.cloud
# → Added CNAME release.17lumen.cloud which will route to this tunnel
```

**③ 上传凭证 + 配置到云**

```bash
workbench upload ~/.cloudflared/<UUID>.json /root/cloudflared/ -i <id> -r cn-beijing -f
workbench upload config.yml /root/cloudflared/ -i <id> -r cn-beijing -f
# ⚠️ workbench 保留原文件名，云上需 mv config-xxx.yml config.yml
```

**④ 云上服务化**（一条命令）

```bash
cd /root/cloudflared
chmod 600 <UUID>.json
./cloudflared --config /root/cloudflared/config.yml service install
# → "Linux service for cloudflared installed successfully"
```

`service install` 自动做的事：
- 创建 `/etc/systemd/system/cloudflared.service`
- 把 config **复制到** `/etc/cloudflared/config.yml`
- 启动服务并设为开机自启

**⑤ 验证**

```bash
# 本机（受限制的网络）
curl https://release.17lumen.cloud/api/updates/latest?platform=windows
# → {"ok":true,"data":{"version":"2026.09.13.8",...}}   ✅
```

### 3.5 一条隧道暴露多个服务（靠子域名分流）

**CF Tunnel 的 `ingress` 本身就是反向代理** —— 按 Host header 分流到不同本地端口，
**不需要自建 nginx**。所有流量都走 443 到 CF 边缘，靠子域名区分。

**当前线上状态（2026-09-14）**：

| 公网地址 | 云上服务 | 鉴权 |
|---|---|---|
| `https://release.17lumen.cloud` | release-platform `127.0.0.1:8765` | 无（公开的更新服务器） |
| `https://mem.17lumen.cloud` | Memory Web `127.0.0.1:40021` | bearer token |
| `https://mcp.17lumen.cloud` | Memory MCP `127.0.0.1:8080` | bearer token |

**完整 ingress 配置**（`/etc/cloudflared/config.yml`）：

```yaml
ingress:
  - hostname: release.17lumen.cloud
    service: http://127.0.0.1:8765
  - hostname: mem.17lumen.cloud
    service: http://127.0.0.1:40021
    originRequest:
      noTLSVerify: true
  - hostname: mcp.17lumen.cloud
    service: http://127.0.0.1:8080
    originRequest:
      noTLSVerify: true
  - service: http_status:404      # ⚠️ 兜底规则必须放最后
```

**⚠️ 命名原则：域名体现服务职能**（`release` / `mem` / `mcp`），别用无意义的 `tunnel`。
（最初叫 `tunnel.17lumen.cloud`，后来改成 `release.` 并删掉旧 DNS 记录。）

**加服务的三步**：
```bash
# ① 本机建 DNS 路由（走代理）
tools/cloudflared/cloudflared.exe tunnel route dns 17lumen-cloud 新名字.17lumen.cloud
# ② 云上改 /etc/cloudflared/config.yml 的 ingress（兜底规则仍在最后）
# ③ systemctl restart cloudflared
```

**本例最终参数**：

| 项 | 值 |
|---|---|
| 隧道名 / ID | `17lumen-cloud` / `2177c195-32d6-4666-beea-eace3e2d0214` |
| 协议 | http2（QUIC 在部分网络受限） |
| systemd | `cloudflared.service`（active + enabled，`Restart=on-failure`） |
| 边缘节点 | lax01/lax05/lax10（洛杉矶） |

> ⚠️ **配置有两份，改错地方不生效**：systemd 读 `/etc/cloudflared/config.yml`，
> 不是 `/root/cloudflared/config.yml`。

**管理 DNS 记录**（删旧记录等）：`~/.cloudflared/cert.pem` 是 **ARGO TUNNEL TOKEN**
（PEM 格式，去掉头尾后 base64 解出 `{zoneID, apiToken}`），可直接调 CF API：

```python
# GET    /client/v4/zones/{zoneID}/dns_records
# DELETE /client/v4/zones/{zoneID}/dns_records/{id}
```

---

## 4. 验证清单

| 检查项 | 命令 | 期望 |
|---|---|---|
| 隧道进程 | `ps aux \| grep cloudflared` | 有进程 |
| 隧道注册 | `grep "Registered tunnel connection" /root/cloudflared/tunnel.log \| tail` | 有记录（命名隧道的日志是 `tunnel.log`；快速隧道是 `quick-tunnel.log`） |
| 三个域名 | `curl -o /dev/null -w '%{http_code}' https://{release,mem,mcp}.17lumen.cloud/` | release 200 / mem 401（要 token）/ mcp 401 |
| 服务化 | `systemctl is-active cloudflared` | active |
| 开机自启 | `systemctl is-enabled cloudflared` | enabled |

> 💡 **从"受限制的网络"验证才有效** —— 本机（企业网络）能访问 = 真的绕过了限制。

---

## 5. 本次真实踩的坑（**最有价值的部分**）

### 坑 1：workbench exec 报 `CloudAssistantInvokeTimeout` —— ⚠️ **先查服务器负载，不是 daemon**

**症状**：
```
Error: session resolve: login instance: SDKError:
Code: IncorrectStatus.CloudAssistantInvokeTimeout
```

**误导性**：看着像"云服务器挂了"或"workbench daemon 挂了"，**两个都是错的**。

**当时走错的诊断**（记录在此避免重犯）：
1. 先怀疑 `workbench daemon` 没运行 → 查 `daemon status` 显示正常，`daemon restart` 也没用
2. 查 API 层 → `DescribeCloudAssistantStatus` 显示 agent **完全健康**：
   `CloudAssistantStatus: true`、心跳正常、`LastInvokedTime` 是几分钟前、`ActiveTaskCount: 0`
3. 差点去"重启 cloud assistant agent"

**真根因（2026-09-14 查清）**：**云服务器资源耗尽**。

```
load average: 9.30（2 核机器）    iowait: 84.6%    磁盘 %util: 91.2%
```

命令投递本身要落盘/调度，服务器卡在这个状态时投递就超时了。

**决定性证据**：`docker restart release-platform`（清掉一个烧 CPU 的进程）后，
**`workbench exec` 自动恢复正常** —— 从头到尾没碰过 daemon 或 agent。

> 💡 **正确的诊断顺序**：
> ```
> ① workbench list -r cn-beijing     # 走 API，不经云助手 → 确认实例在不在
> ② DescribeCloudAssistantStatus     # 确认 agent 是否健康（心跳/ActiveTaskCount）
> ③ 若 ①② 都正常 → 查服务器负载：uptime / top / iostat -x
>    高 load + 高 iowait = 资源耗尽导致的通道超时，去降负载而不是折腾 daemon
> ```
>
> **教训**：通道超时的**最可能原因是服务器太慢**，而不是通道本身坏了。
> 详见 `claude-code-gui-release-platform/DEPLOY.md` 与记忆 `a4beae15`。

**绕过手段**：资源饱和时 `RunCommand` API 通道**仍可用**（它不走 Session Manager）。

```python
from aliyunsdkecs.request.v20140526.RunCommandRequest import RunCommandRequest
req = RunCommandRequest()
req.set_InstanceIds([INST])            # ⚠️ 复数；RegionId 由 client 提供（勿 set_RegionId）
req.set_Type("RunShellScript")
req.set_CommandContent(base64.b64encode(script.encode()).decode())
req.set_ContentEncoding("Base64"); req.set_Timeout(120)
# → 返回 InvokeId；再轮询 DescribeInvocationResultsRequest 取输出
```
> ⚠️ 用 `aliyunsdkecs` 的 Request 类，不要用 `CommonRequest`（参数名对不上，
> 报 `MissingParam.InstanceId`）。

### 坑 2：workbench 默认 30s 超时

```bash
# ❌ 长命令会超时
workbench exec -i <id> -c "curl -L -o big.tar.gz https://..."

# ✅ 加 --timeout
workbench exec -i <id> -c "curl -L -o big.tar.gz https://..." --timeout 400
```

### 坑 3：本地下载大文件要走代理，别在云上下

**云上直连 github 慢/不稳**；本地走代理快得多：

```bash
# 本地（走代理）
curl -L -x http://127.0.0.1:17891 -o cloudflared-linux-amd64 \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64

# 上传到云
workbench upload cloudflared-linux-amd64 /root/ -i <id> -r cn-beijing -f
```

**实测**：本地 4.6 秒（8.2 MB/s），上传 5.9 秒。

### 坑 4：本地 frp 安装包被 360 篡改

**症状**：下载的 `frp_0.71.0_windows_amd64.zip` 解压后**只有 frpc.exe，没有 frps.exe**，大小只有官方的 **45%**（6.3MB vs 13.9MB）。

**根因**：360 企业版把 `frps.exe`（服务端）当可疑程序**删除**了。

**验证方法**：
```bash
# 对比官方大小
curl -s "https://api.github.com/repos/fatedier/frp/releases/tags/v0.71.0" | \
  python -c "import json,sys; [print(a['name'], a['size']) for a in json.load(sys.stdin)['assets'] if 'windows_amd64' in a['name']]"
```

**规避**：**在云端下载**（云端没有 360），或用本地代理直接下到云端。

> ⚠️ 这也解释了为什么"本地测试 frp 失败" —— 不是配置问题，是**文件不完整**。

### 坑 5：`/dev/tcp` 测域名会误判

Git Bash 的 `bash -c "echo > /dev/tcp/<域名>/<端口>"` 对**域名**（需 DNS 解析）经常超时失败，但对 IP 正常。

**正确做法**：用 `curl` 或 `python socket` 测：

```python
import socket, time
t0 = time.time()
try:
    s = socket.create_connection(('123.56.66.84', 8765), timeout=8); s.close()
    print(f'通 ({(time.time()-t0)*1000:.0f}ms)')
except Exception as e:
    print(f'失败: {type(e).__name__}')
```

### 坑 6：`connect=0.000000s` 的含义

`curl -w "%{time_connect}"` 返回 **`0.000000`** 表示**连接根本没发起**（本地立即拒绝/失败），而不是超时。

| 值 | 含义 |
|---|---|
| `0.000000` | 本地立即失败（路由/DNS/本地策略） |
| `8.xxx` + `000` | 超时（包被丢弃 → 远端/网关拦截） |

区分这两者能快速定位是"本地问题"还是"远端问题"。

### 坑 7：IPv6 优先导致部分站点"连不上"

**症状**：DNS 返回了 AAAA（IPv6）记录 → 系统优先尝试 IPv6 → IPv6 不可达 → 立即失败。

**验证**：
```bash
curl -4 https://www.baidu.com    # 强制 IPv4，通了 → 确认是 IPv6 问题
```

**影响**：卸载深信服 VPN 后暴露出来（其 DNS 驱动原本会过滤 AAAA 记录）。

---

## 6. 备选方案与取舍

| 方案 | 何时用 | 代价 |
|---|---|---|
| **CF 快速隧道** | 临时验证、域名没到位 | 域名会变、不能服务化 |
| **CF 命名隧道** | 长期使用（推荐） | 需 CF 账号 + 域名 + 等 NS 生效 |
| **frp + 云** | **换到不受限的网络**（手机热点/家里） | 国内延迟低，但要能直连云 |
| **手机热点** | 应急 | 每次都要切换网络 |

> 💡 **最佳实践**：两个都部署好（CF 负责受限网络，frp 负责正常网络），按场景切换。

---

## 7. 安全注意事项

| 项 | 建议 |
|---|---|
| **别暴露 SSH** | 22 端口映射到公网 = 把登录入口开放给全世界 |
| **服务自带鉴权** | 如 Memory Web 的 bearer token —— 这是第一道防线 |
| **Cloudflare Access** | CF 免费版可加 SSO/邮箱验证白名单 |
| **域名别太好猜** | 快速隧道的随机域名天然有此优势 |
| **token 别入库** | 隧道 token 存 `.env`（600）或环境变量，**别写进文档/脚本** |

---

## 8. 常用命令速查

```bash
# ── 云上操作（通过 workbench）──
# 通用格式
workbench exec -i i-2ze2rouoikcqrlbseu8a -r cn-beijing -c "<命令>" --timeout 120

# 查看隧道状态
ps aux | grep cloudflared | grep -v grep
grep "Registered tunnel connection" /root/cloudflared/quick-tunnel.log | tail -1

# 取当前公网地址
grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" /root/cloudflared/quick-tunnel.log | tail -1

# 重启隧道
pkill -f "cloudflared tunnel"
cd /root/cloudflared && nohup ./cloudflared tunnel --url http://127.0.0.1:8765 \
  --protocol http2 --no-autoupdate > quick-tunnel.log 2>&1 &

# ── 诊断 ──
# 云 → CF 连通性
python3 -c "import socket; s=socket.create_connection(('region1.v2.argotunnel.com',7844),timeout=8); s.close(); print('OK')"

# 全球节点测试（第三方）
curl -H "Accept: application/json" "https://check-host.net/check-tcp?host=<ip>:<port>&max_nodes=6"
```

---

## 9. 本次部署产物清单

| 项 | 位置 |
|---|---|
| cloudflared 二进制 | 云 `/root/cloudflared/cloudflared`（v2026.9.1） |
| **隧道凭证（含密钥）** | 云 `/root/cloudflared/2177c195-*.json`（600 权限） |
| **生效配置** | 云 `/etc/cloudflared/config.yml` ⚠️ systemd 读这份 |
| 配置副本 | 云 `/root/cloudflared/config-17lumen.yml` + 仓库 `tools/cloudflared/config-17lumen.yml` |
| 隧道日志 | 云 `/root/cloudflared/tunnel.log` |
| **发布部署手册** | `claude-code-gui-release-platform/DEPLOY.md`（本地构建→上传→只 load） |
| 本地手册 | `docs/cloudflare-tunnel-playbook.md` |
| 本实战文档 | `docs/cloudflare-tunnel-cloud-playbook.md` |
| 配置笔记 | GUI 笔记「Cloudflare Tunnel 配置 · 云服务器穿透」(id `82eb2816-…`) |
| frp 服务端 | 云 `/root/frp/`（systemd `frp.service`，端口 7000）— ⚠️ 当前不可用 |
| frp 客户端（本机） | `tools/frp/win/.../frpc.exe` + `tools/frp/frpc.toml` |
| frp 配置（入库） | `tools/frp/frpc.toml` · `tools/frp/frps.toml` |

---

## 10. 时间线（2026-09-14）

| 阶段 | 事件 |
|---|---|
| 起因 | 想用 frp 打通本机 ↔ 云 → 部署 frps 到云 |
| 诊断 | 本机连不上云 → 逐步排除安全组/ACL/iptables/黑洞/VPN |
| 定性 | **全球节点测试** → 确认云正常，是企业网络拦的 |
| 转向 | 改方案：CF Tunnel |
| 打通 | 云上装 cloudflared + 快速隧道跑通（本机可访问 ✅） |
| 域名 | 注册 CF 账号 → 添加 `17lumen.cloud` → Free 套餐 → 腾讯云改 NS |
| ~30min | **NS 生效**（CF Dashboard 显示 Active） |
| 授权 | 本机 `tunnel login` → 浏览器 Authorize（⚠️ 别走 Zero Trust 付款页） |
| 命名隧道 | `tunnel create 17lumen-cloud` + `route dns release.17lumen.cloud` |
| 服务化 | 上传凭证/config 到云 → `service install`（active + enabled） |
| **✅ 固定域名** | `https://release.17lumen.cloud` 从企业网络可访问 |
| 扩展 | 加 `mem.` / `mcp.` 两个子域名（Memory Web / MCP） |
| 改名 | `tunnel.` → `release.`（域名体现服务职能），删旧 DNS 记录 |
| **性能事故** | 发现云 `load 9.3` / `iowait 84.6%` → 查出 `uvicorn reload=True` 烧 CPU<br>（详见 `claude-code-gui-release-platform/DEPLOY.md`，修复后 load 0.05） |
| 部署规范 | release-platform 定下"本地构建 → 上传 → 服务器只 load"铁律（服务器扛不住 build） |
| GUI 适配 | 客户端"公网"档从裸 IP 改为 CF 域名 + 旧值自动迁移（**待发版生效**） |
