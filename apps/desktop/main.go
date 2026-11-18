package main

import (
	"log"
	"os"
	"runtime"

	"github.com/egoist/mygo"
)

// Runtime is the Go side the page talks to: `mygo generate` turns its methods
// into typed functions in src/mygo.ts. Nothing here reaches the agent runtime
// yet — this window is the shell the product grows into.
type Runtime struct{}

// Info describes the app and the machine it runs on.
type Info struct {
	App        string `json:"app"`
	Version    string `json:"version"`
	OS         string `json:"os"`
	Arch       string `json:"arch"`
	GoVersion  string `json:"goVersion"`
	APIBaseURL string `json:"apiBaseUrl"`
}

// Info returns the build and platform details the status bar shows.
func (Runtime) Info() Info {
	return Info{
		App:        "vessel",
		Version:    version,
		OS:         runtime.GOOS,
		Arch:       runtime.GOARCH,
		GoVersion:  runtime.Version(),
		APIBaseURL: apiBaseURL(),
	}
}

// version is the release version, injected at build time.
var version = "0.1.0-dev"

// apiBaseURL is where the backend lives. The desktop app is configured at run
// time (VESSEL_API_URL), so one build can point at any deployment.
func apiBaseURL() string {
	if v := os.Getenv("VESSEL_API_URL"); v != "" {
		return v
	}
	return "http://localhost:8080"
}

func main() {
	mygo.Bind(Runtime{})

	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{
			Title:           "Vessel",
			Width:           1120,
			Height:          720,
			MinWidth:        720,
			MinHeight:       520,
			BackgroundColor: "light-dark(#f7f7f5, #101211)",
			StateKey:        "main",
			URL:             "/",
		})
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
