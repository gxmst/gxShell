// Package mcpserver exposes gxShell's approved CLI operations through MCP.
package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const MaxRequestBytes = 2 << 20
const maxResponseBytes = 4 << 20

// Caller invokes the existing authenticated CLI API. It must preserve the
// request context and exec request ID, and must never retry an action itself.
type Caller func(context.Context, string, string, any, string) (map[string]any, error)

// HTTPCaller is used by the stdio process. Tokens are loaded per request so a
// GUI token replacement does not require restarting the MCP process.
func HTTPCaller(baseURL string, loadToken func() (string, error)) Caller {
	client := &http.Client{
		Timeout:       31 * time.Minute,
		Transport:     &http.Transport{}, // Local requests must not use proxy env vars.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return apiCaller(func(req *http.Request) (*http.Response, error) {
		token, err := loadToken()
		if err != nil {
			return nil, fmt.Errorf("cannot load gxShell token; start the GUI and enable CLI / MCP access: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		return client.Do(req)
	}, baseURL)
}

// HandlerCaller dispatches inside the GUI through the same authenticated
// handlers as the CLI, including deduplication and native approval. It avoids
// making a second network connection back to the GUI itself.
func HandlerCaller(handler http.Handler, token string) Caller {
	return apiCaller(func(req *http.Request) (*http.Response, error) {
		req.Header.Set("Authorization", "Bearer "+token)
		recorder := &apiResponse{header: make(http.Header), status: http.StatusOK}
		handler.ServeHTTP(recorder, req)
		if recorder.overflow {
			return nil, fmt.Errorf("gxShell response exceeds the MCP output limit")
		}
		return &http.Response{
			StatusCode: recorder.status, Header: recorder.header,
			Body: io.NopCloser(bytes.NewReader(recorder.body.Bytes())),
		}, nil
	}, "http://127.0.0.1")
}

func apiCaller(send func(*http.Request) (*http.Response, error), baseURL string) Caller {
	return func(ctx context.Context, method, path string, payload any, requestID string) (map[string]any, error) {
		var body io.Reader
		if payload != nil {
			raw, err := json.Marshal(payload)
			if err != nil {
				return nil, err
			}
			if len(raw) > MaxRequestBytes {
				return nil, fmt.Errorf("gxShell request exceeds the 2 MiB input limit")
			}
			body = bytes.NewReader(raw)
		}
		req, err := http.NewRequestWithContext(ctx, method, baseURL+path, body)
		if err != nil {
			return nil, err
		}
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if requestID != "" {
			req.Header.Set("X-GxShell-Request-ID", requestID)
		}
		resp, err := send(req)
		if err != nil {
			return nil, fmt.Errorf("gxShell request failed; inspect remote state before retrying an action: %w", err)
		}
		defer resp.Body.Close()
		raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
		if err != nil {
			return nil, err
		}
		if len(raw) > maxResponseBytes {
			return nil, fmt.Errorf("gxShell response exceeds the MCP output limit")
		}
		var result map[string]any
		if err := json.Unmarshal(raw, &result); err != nil || result == nil {
			return nil, fmt.Errorf("gxShell returned an invalid JSON object (HTTP %d)", resp.StatusCode)
		}
		if resp.StatusCode >= 400 && result["error"] == nil {
			result["error"] = fmt.Sprintf("gxShell returned HTTP %d", resp.StatusCode)
		}
		if requestID != "" {
			result["requestId"] = requestID
			result["requestProtected"] = resp.Header.Get("X-GxShell-Request-ID") == requestID
			result["replayed"] = resp.Header.Get("X-GxShell-Request-Replayed") == "true"
		}
		return result, nil
	}
}

type apiResponse struct {
	header   http.Header
	status   int
	body     bytes.Buffer
	overflow bool
}

func (r *apiResponse) Header() http.Header    { return r.header }
func (r *apiResponse) WriteHeader(status int) { r.status = status }
func (r *apiResponse) Write(p []byte) (int, error) {
	if r.body.Len()+len(p) > maxResponseBytes {
		r.overflow = true
	}
	if !r.overflow {
		_, _ = r.body.Write(p)
	}
	return len(p), nil
}
