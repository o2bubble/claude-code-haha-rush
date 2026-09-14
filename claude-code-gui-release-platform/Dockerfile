FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server/ server/
COPY main.py .
COPY static/ static/
# 注意：**不 COPY skills-store/** —— 它是运行时数据（技能包，160MB+），
# 由 compose 的 volume 挂载（`./skills-store:/app/skills-store`）提供；
# 打进镜像既会撑大镜像，又会被挂载覆盖成为死数据。
# 缺目录时 main.py 会 `mkdir(exist_ok=True)` 自动创建。
# 同理 updates-store / feedback-images / registry.db 都是运行时数据，见 .dockerignore。

EXPOSE 8765

CMD ["python", "main.py"]
