# syntax=docker/dockerfile:1
# 国内加速源：默认使用 DaoCloud 镜像；可在 .env 中用 GO_IMAGE / ALPINE_IMAGE 覆盖。
ARG GO_IMAGE=docker.m.daocloud.io/library/golang:1.22-alpine
ARG ALPINE_IMAGE=docker.m.daocloud.io/library/alpine:3.20

FROM ${GO_IMAGE} AS build
ARG GOPROXY=https://goproxy.cn,direct
ENV GOPROXY=${GOPROXY}
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/qqdl ./cmd/qqdl

FROM ${ALPINE_IMAGE}
ARG ALPINE_MIRROR=https://mirrors.aliyun.com/alpine
RUN sed -i -e "s#https://dl-cdn.alpinelinux.org/alpine#${ALPINE_MIRROR}#g" \
        -e "s#http://dl-cdn.alpinelinux.org/alpine#${ALPINE_MIRROR}#g" /etc/apk/repositories \
    && apk add --no-cache ca-certificates tzdata
COPY --from=build /out/qqdl /usr/local/bin/qqdl
WORKDIR /downloads
ENV TZ=Asia/Shanghai
ENTRYPOINT ["qqdl"]
CMD ["--help"]
