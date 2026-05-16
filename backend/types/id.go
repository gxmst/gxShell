package types

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

func NewID(prefix string) string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%s-%d-%s", prefix, time.Now().UnixNano(), hex.EncodeToString(b))
}
