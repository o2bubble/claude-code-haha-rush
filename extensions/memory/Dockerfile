FROM python:3.12-slim

WORKDIR /app

# Use Aliyun PyPI mirror for faster downloads in China
RUN pip config set global.index-url https://mirrors.aliyun.com/pypi/simple/ && \
    pip config set install.trusted-host mirrors.aliyun.com

# Install dependencies (no PyTorch — FTS5 BM25 + jieba tokenization)
COPY requirements.txt .
RUN pip install --no-cache-dir --default-timeout=300 -r requirements.txt

# Copy application code
COPY store.py .
COPY tokenizer.py .
COPY normalize.py .
COPY search_engine.py .
COPY server.py .
COPY api.py .

# Copy pre-built frontend (build with: cd web && bun install && bun run build)
COPY web/dist/ ./web/dist/
COPY web/landing.html ./web/landing.html

# Persist DB outside container
VOLUME /data
ENV DB_PATH=/data/claude-memory.db

EXPOSE 8080 40021

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')" || exit 1

# Start both services: MCP (background) + API (foreground)
CMD ["sh", "-c", "python server.py --transport sse --host 0.0.0.0 --port 8080 --db-path /data/claude-memory.db & python api.py --host 0.0.0.0 --port 40021 --db-path /data/claude-memory.db"]
