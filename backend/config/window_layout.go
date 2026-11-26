package config

import (
	"errors"
	"os"
)

// Positions and sizes are in device-independent pixels relative to WorkArea.
type WindowPlacement struct {
	ScreenID   string `json:"screenId"`
	ScreenName string `json:"screenName"`
	X          int    `json:"x"`
	Y          int    `json:"y"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	Maximised  bool   `json:"maximised,omitempty"`
}

func (s *Store) WindowLayout() (map[string]WindowPlacement, error) {
	values := map[string]WindowPlacement{}
	err := s.readJSON("window-layout.json", &values)
	if errors.Is(err, os.ErrNotExist) {
		err = nil
	}
	return values, err
}

func (s *Store) SaveWindowLayout(values map[string]WindowPlacement) error {
	return s.writeJSON("window-layout.json", values)
}
