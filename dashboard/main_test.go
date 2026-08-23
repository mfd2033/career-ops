package main

import (
	"path/filepath"
	"testing"
)

func TestDefaultOpsPathExplicitWins(t *testing.T) {
	got := defaultOpsPath(`C:\repo`, true, `C:\repo\bin\career-dashboard.exe`)
	if got != `C:\repo` {
		t.Fatalf("defaultOpsPath(explicit) = %q, want %q", got, `C:\repo`)
	}
}

func TestDefaultOpsPathAnchorsOnExecutableDir(t *testing.T) {
	exe := filepath.Join(`D:\somewhere`, `career-dashboard.exe`)
	got := defaultOpsPath(".", false, exe)
	want := filepath.Dir(exe)
	if got != want {
		t.Fatalf("defaultOpsPath(implicit) = %q, want executable dir %q", got, want)
	}
}

func TestDefaultOpsPathBareNameFallsBack(t *testing.T) {
	got := defaultOpsPath(".", false, "career-dashboard.exe")
	if got != "." {
		t.Fatalf("defaultOpsPath(bare name) = %q, want %q", got, ".")
	}
}