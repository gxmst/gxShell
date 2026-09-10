package termio

import (
	"bytes"
	"io"
	"strings"
	"testing"
	"testing/iotest"
)

func TestLegacyCodecsPreserveTextAndControlSequences(t *testing.T) {
	for _, tc := range []struct {
		name, text string
		wire       []byte
	}{
		{"gbk", "中文", []byte{0xd6, 0xd0, 0xce, 0xc4}},
		{"gb18030", "𠀀", []byte{0x95, 0x32, 0x82, 0x36}},
		{"big5", "中文", []byte{0xa4, 0xa4, 0xa4, 0xe5}},
		{"windows-1252", "café €", []byte{'c', 'a', 'f', 0xe9, ' ', 0x80}},
		{"utf-8", "中文 😀", []byte("中文 😀")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			prefix, suffix := "\x1b[31m", "\x1b[0m\r\n\x08\x7f\x1b[3~\x03"
			wire := append(append([]byte(prefix), tc.wire...), suffix...)
			text := prefix + tc.text + suffix
			encoded, err := EncodeInput(text, tc.name)
			if err != nil || !bytes.Equal(encoded, wire) {
				t.Fatalf("encode = %x, %v; want %x", encoded, err, wire)
			}
			// A single-byte reader forces each multibyte character across reads.
			decoded, err := io.ReadAll(DecoderReader(iotest.OneByteReader(bytes.NewReader(wire)), tc.name))
			if err != nil || string(decoded) != text {
				t.Fatalf("decode = %q, %v; want %q", decoded, err, text)
			}
		})
	}
}

func TestLegacyInputRejectsUnsupportedCharacters(t *testing.T) {
	for _, name := range []string{"gbk", "big5", "windows-1252"} {
		if _, err := EncodeInput("echo 😀\r", name); err == nil {
			t.Fatalf("%s silently accepted an unsupported character", name)
		}
	}
}

func TestUTF8DecoderIsPassThrough(t *testing.T) {
	reader := strings.NewReader("中文😀")
	if DecoderReader(reader, "utf-8") != reader {
		t.Fatal("default UTF-8 path should not allocate a transformer")
	}
}
