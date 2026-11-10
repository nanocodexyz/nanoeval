FROM alpine:3.21

RUN adduser -D -u 1000 worker && mkdir /app && chown worker /app

USER worker
WORKDIR /app
