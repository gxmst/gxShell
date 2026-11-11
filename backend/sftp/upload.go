package sftpmanager

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/pkg/sftp"
)

// 64 requests of 32 KiB keep at most 2 MiB of source buffers in flight.
const uploadConcurrency = 64
const uploadChunkSize = 32 * 1024

// stopSource interrupts a paused source reader when a remote write fails.
// pkg/sftp's ReaderFrom pipeline cannot propagate its worker cancellation to
// that reader, so we own the bounded WriteAt pipeline and await every request.
func copyUpload(destination *sftp.File, source io.Reader, offset int64, stopSource func()) (int64, error) {
	type chunk struct {
		data   []byte
		offset int64
	}
	buffers := make(chan []byte, uploadConcurrency)
	for range uploadConcurrency {
		buffers <- make([]byte, uploadChunkSize)
	}
	work := make(chan chunk)
	stopped := make(chan struct{})
	var stopOnce sync.Once
	var errorMu sync.Mutex
	var firstErr error
	var safe int64
	recordError := func(at int64, err error) {
		errorMu.Lock()
		if firstErr == nil || at < safe {
			firstErr, safe = err, at
		}
		errorMu.Unlock()
		stopOnce.Do(func() {
			close(stopped)
			if stopSource != nil {
				stopSource()
			}
		})
	}
	var workers sync.WaitGroup
	for range uploadConcurrency {
		workers.Go(func() {
			for c := range work {
				n, err := destination.WriteAt(c.data, c.offset)
				if err == nil && n != len(c.data) {
					err = io.ErrShortWrite
				}
				if err != nil {
					recordError(c.offset+int64(n), err)
				}
				buffers <- c.data[:cap(c.data)]
			}
		})
	}
	var read int64
readLoop:
	for {
		var buffer []byte
		select {
		case <-stopped:
			break readLoop
		case buffer = <-buffers:
		}
		n, err := io.ReadFull(source, buffer)
		if n > 0 {
			c := chunk{data: buffer[:n], offset: offset + read}
			select {
			case <-stopped:
				break readLoop
			case work <- c:
				read += int64(n)
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
				recordError(offset+read, err)
			}
			break
		}
	}
	close(work)
	workers.Wait()
	if firstErr == nil {
		_, err := destination.Seek(offset+read, io.SeekStart)
		return read, err
	}
	// Later chunks may have succeeded. Trim only after all dispatched writes
	// have completed, using the earliest failed byte rather than read-ahead.
	if truncateErr := destination.Truncate(safe); truncateErr != nil {
		// A disconnected server may be impossible to trim. Every retry verifies
		// the complete prefix, so such a sparse/stale part cannot be promoted.
		return safe - offset, fmt.Errorf("%w (could not trim incomplete upload: %v)", firstErr, truncateErr)
	}
	return safe - offset, firstErr
}

var errUploadPrefixMismatch = errors.New("upload prefix differs from source")

// WriteTo pipelines remote reads and delivers ordered buffers to the comparer.
// Verification stays bounded in memory and does not serialize each read RTT.
func verifyUploadPrefix(job *transferJob, source io.ReaderAt, partial *sftp.File, size int64) (bool, error) {
	comparer := &uploadPrefixComparer{job: job, source: source, size: size}
	_, err := partial.WriteTo(comparer)
	if errors.Is(err, errUploadPrefixMismatch) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("verify upload prefix: %w", err)
	}
	return comparer.offset == size, nil
}

type uploadPrefixComparer struct {
	job    *transferJob
	source io.ReaderAt
	size   int64
	offset int64
	buffer []byte
}

func (c *uploadPrefixComparer) Write(data []byte) (int, error) {
	if err := c.job.waitIfPaused(); err != nil {
		return 0, err
	}
	if int64(len(data)) > c.size-c.offset {
		return 0, errUploadPrefixMismatch
	}
	if cap(c.buffer) < len(data) {
		c.buffer = make([]byte, len(data))
	}
	buffer := c.buffer[:len(data)]
	n, err := c.source.ReadAt(buffer, c.offset)
	if err != nil && err != io.EOF {
		return 0, fmt.Errorf("read source prefix: %w", err)
	}
	if n != len(data) || !bytes.Equal(data, buffer) {
		return 0, errUploadPrefixMismatch
	}
	c.offset += int64(n)
	return n, nil
}
