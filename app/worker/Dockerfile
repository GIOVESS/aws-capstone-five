FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1
ARG APP_VERSION=bootstrap
ENV APP_VERSION=$APP_VERSION
WORKDIR /srv
COPY requirements.txt .
RUN pip install -r requirements.txt && useradd -r -u 10001 appuser
COPY common ./common
COPY worker ./worker
USER appuser
STOPSIGNAL SIGTERM
CMD ["python", "-m", "worker.main"]
