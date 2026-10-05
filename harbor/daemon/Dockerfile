FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg util-linux \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml ./
COPY harbor_daemon ./harbor_daemon
RUN pip install --no-cache-dir .
USER root
ENTRYPOINT ["harbor-daemon", "--config", "/etc/harbor/harbor.json"]
CMD ["run"]
