// Package plugins loader: discovering and loading server-side plugins.
//
// A plugin lives in the plugins directory as a manifest.json next to its code.
// The loader reads every manifest it finds and hands the plugin to the registry.
package plugins

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
)

// ErrPluginDirMissing is returned when the configured plugins directory does not exist.
var ErrPluginDirMissing = errors.New("plugins: plugins directory does not exist")

// LoadDir reads every *.json manifest in dir and returns the manifests it found.
// Malformed manifests are logged and skipped.
func LoadDir(dir string) ([]Manifest, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrPluginDirMissing
		}
		return nil, err
	}
	var out []Manifest
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			log.Printf("plugins: read %s: %v", e.Name(), err)
			continue
		}
		var m Manifest
		if err := json.Unmarshal(raw, &m); err != nil {
			log.Printf("plugins: parse %s: %v", e.Name(), err)
			continue
		}
		if m.Name == "" {
			log.Printf("plugins: %s has no name", e.Name())
			continue
		}
		out = append(out, m)
	}
	return out, nil
}

// LoadManifest reads one manifest file.
func LoadManifest(path string) (Manifest, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Manifest{}, err
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return Manifest{}, err
	}
	return m, nil
}

// WriteManifest writes a manifest to path.
func WriteManifest(path string, m Manifest) error {
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(raw, '\n'), 0o644)
}
