GO ?= go
BINARY := bin/douyin-downloader
ifeq ($(OS),Windows_NT)
BINARY := $(BINARY).exe
endif

.PHONY: build run dev test vet check fmt release

build:
	$(GO) build -trimpath -ldflags="-s -w" -o $(BINARY) ./cmd/douyin-downloader

run: build
	DOWNLOAD_DIR="$${DOWNLOAD_DIR:-$(CURDIR)/downloads}" ./$(BINARY)

dev:
	DOWNLOAD_DIR="$${DOWNLOAD_DIR:-$(CURDIR)/downloads}" $(GO) run ./cmd/douyin-downloader

test:
	$(GO) test -race ./...

vet:
	$(GO) vet ./...

check: test vet

fmt:
	$(GO) fmt ./...

release:
	GO="$(GO)" bash scripts/release.sh
