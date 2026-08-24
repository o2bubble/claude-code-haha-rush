FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server/ server/
COPY main.py .
COPY static/ static/
COPY skills-store/ skills-store/

EXPOSE 8765

CMD ["python", "main.py"]
