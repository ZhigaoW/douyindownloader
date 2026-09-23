// Package web embeds the browser interface into the executable.
package web

import "embed"

// Files contains the static interface; rebuild after changing any asset.
//
//go:embed static/*
var Files embed.FS
