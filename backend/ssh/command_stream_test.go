package sshmanager

import "testing"

func TestCommandOutputWriterCapsStreamCallback(t *testing.T) {
	var streamed []byte
	writer := &commandOutputWriter{
		stream: "stdout", buffer: newLimitedBuffer(5),
		callback: func(_ string, chunk []byte) { streamed = append(streamed, chunk...) },
	}
	if n, err := writer.Write([]byte("hello")); err != nil || n != 5 {
		t.Fatalf("first write n=%d err=%v", n, err)
	}
	if n, err := writer.Write([]byte(" world")); err != nil || n != 6 {
		t.Fatalf("second write n=%d err=%v", n, err)
	}
	if got := string(streamed); got != "hello" {
		t.Fatalf("streamed = %q", got)
	}
	if !writer.buffer.Truncated() {
		t.Fatal("buffer should report truncation")
	}
}
