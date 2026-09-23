#!/bin/bash
# 17lumen HTTPS 一键配置 —— DNS 解析生效后运行
#   用法:  bash /opt/17lumen/setup-ssl.sh
#   说明:  检查 4 个域名的 A 记录 → 申请 Let's Encrypt 证书 → 写入 HTTPS 配置 → 重载 nginx
set -euo pipefail

DOMAINS=(17lumen.com www.17lumen.com 17lumen.cn www.17lumen.cn)
PRIMARY=17lumen.com
EXPECT_IP=123.56.66.84
EMAIL="admin@17lumen.com"     # ← 如需接收证书到期提醒，改成自己的邮箱
BASE=/opt/17lumen

echo "== 1/4 检查 DNS 解析 =="
ok=1
for d in "${DOMAINS[@]}"; do
  ip=$(getent ahostsv4 "$d" 2>/dev/null | awk '{print $1}' | head -1 || true)
  if [ "$ip" = "$EXPECT_IP" ]; then
    echo "  ✓ $d -> $ip"
  else
    echo "  ✗ $d -> ${ip:-未解析}  (期望 $EXPECT_IP)"
    ok=0
  fi
done
if [ "$ok" != "1" ]; then
  echo
  echo "解析尚未就绪：请先给以上每个域名添加 A 记录指向 $EXPECT_IP，"
  echo "等解析生效（可 dig 验证）后重新运行本脚本。"
  exit 1
fi

echo "== 2/4 申请 Let's Encrypt 证书 =="
domain_args=()
for d in "${DOMAINS[@]}"; do domain_args+=(-d "$d"); done

docker run --rm \
  -v "$BASE/certbot/www:/var/www/certbot" \
  -v "$BASE/certbot/conf:/etc/letsencrypt" \
  certbot/certbot certonly --webroot -w /var/www/certbot \
  "${domain_args[@]}" \
  --cert-name "$PRIMARY" \
  --email "$EMAIL" \
  --agree-tos --no-eff-email --non-interactive

echo "== 3/4 写入 HTTPS 配置 =="
cat > "$BASE/nginx/conf.d/home.conf" <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name 17lumen.com www.17lumen.com 17lumen.cn www.17lumen.cn;

    # 续期校验路径必须保留在 80 端口
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name 17lumen.com www.17lumen.com 17lumen.cn www.17lumen.cn;

    ssl_certificate     /etc/letsencrypt/live/17lumen.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/17lumen.com/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;

    location / {
        root /usr/share/nginx/html;
        index index.html;
    }
}
NGINX

echo "== 4/4 校验并重载 nginx =="
docker exec 17lumen-web nginx -t
docker exec 17lumen-web nginx -s reload

echo
echo "✓ 完成：https://$PRIMARY"
