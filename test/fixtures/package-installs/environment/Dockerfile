FROM python:3.12-alpine

RUN apk add --no-cache nodejs npm
RUN pip install --no-cache-dir six==1.16.0
RUN npm install -g is-number@7.0.0

WORKDIR /app
