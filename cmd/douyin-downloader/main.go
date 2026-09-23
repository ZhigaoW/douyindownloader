package main

import (
	"douyin-downloader/internal/app"
	"log"
)

func main() {
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
