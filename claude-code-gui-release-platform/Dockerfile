# ── 阶段 1：构建管理后台前端 ──
# 必须用 bun 而非 npm：仓库只有 bun.lock，没有 package-lock.json，
# `npm ci` 会直接失败。
FROM oven/bun:1 AS web

WORKDIR /web

# bunfig.toml 里有 registry 配置（国内镜像），**必须与 package.json 同批 COPY** ——
# 晚一步 COPY 的话，bun install 会走默认源，在受限网络下直接 FailedToOpenSocket。
# 单独 COPY 这几项而不是整个 web/，是为了让依赖层在源码变动时仍能命中缓存。
COPY web/package.json web/bun.lock web/bunfig.toml ./
RUN bun install --frozen-lockfile

COPY web/ ./
# base 用默认的 /admin/（vite.config.ts 的默认值），与 main.py 的挂载路径一致
RUN bun run build


# ── 阶段 2：运行时 ──
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server/ server/
COPY main.py .
COPY static/ static/
# 前端产物覆盖到 static/admin/（构建阶段的 dist 即静态根）
COPY --from=web /web/dist/ static/admin/

# 注意：**不 COPY skills-store/** —— 它是运行时数据（技能包，160MB+），
# 由 compose 的 volume 挂载（`./skills-store:/app/skills-store`）提供；
# 打进镜像既会撑大镜像，又会被挂载覆盖成为死数据。
# 缺目录时 main.py 会 `mkdir(exist_ok=True)` 自动创建。
# 同理 updates-store / feedback-images / registry.db 都是运行时数据，见 .dockerignore。

EXPOSE 8765

CMD ["python", "main.py"]
