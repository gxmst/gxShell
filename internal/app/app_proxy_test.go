package app

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"gxShell/backend/ai"
	"gxShell/backend/config"
	"gxShell/backend/types"
)

func TestAIUsesSavedProxyAndAppliesChangesWithoutRestart(t *testing.T) {
	app := newProfileTestApp(t)
	app.ai = ai.NewManagerWithTransport(app.networkProxy)
	t.Cleanup(app.networkProxy.CloseIdleConnections)
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Host != "ai.invalid" || r.URL.Path != "/v1/models" {
			t.Errorf("unexpected AI destination: %s", r.URL)
		}
		fmt.Fprint(w, `{"data":[{"id":"first"}]}`)
	}))
	defer first.Close()
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"data":[{"id":"second"}]}`)
	}))
	defer second.Close()
	settings := config.DefaultSettings()
	for i, address := range []string{first.URL, second.URL} {
		settings.Proxy = types.ProxySettings{Mode: "manual", URL: address}
		if _, err := app.UpdateSettings(settings); err != nil {
			t.Fatal(err)
		}
		models, err := app.ai.ListModels(ai.Config{Provider: ai.ProviderCustom, Endpoint: "http://ai.invalid/v1"})
		want := []string{"first", "second"}[i]
		if err != nil || len(models) != 1 || models[0] != want {
			t.Fatalf("models=%v err=%v, want %s", models, err, want)
		}
	}
}

func TestProxySettingsPersistAndRejectCredentialURL(t *testing.T) {
	app := newProfileTestApp(t)
	app.ai = ai.NewManagerWithTransport(app.networkProxy)
	settings := config.DefaultSettings()
	settings.Proxy = types.ProxySettings{Mode: "manual", URL: "http://127.0.0.1:7890", SSH: true, Bypass: "10.0.0.0/8"}
	if _, err := app.UpdateSettings(settings); err != nil {
		t.Fatal(err)
	}
	saved, err := app.store.GetSettings()
	if err != nil || saved.Proxy != settings.Proxy {
		t.Fatalf("saved=%#v err=%v", saved.Proxy, err)
	}
	settings.Proxy.URL = "http://user:password@proxy.test:8080"
	if _, err := app.UpdateSettings(settings); err == nil {
		t.Fatal("credential URL persisted")
	}
	got, _ := app.store.GetSettings()
	if got.Proxy != saved.Proxy {
		t.Fatal("failed update changed stored proxy")
	}
}

func TestDisabledBackgroundUpdateNeverContactsFeed(t *testing.T) {
	app := newUpdateTestApp(t)
	// This state models toggling off during the eight-second startup delay.
	saveUpdateSettings(t, app, false, "")
	app.networkProxy.Block("must not contact the release feed")
	result := app.checkForUpdate(context.Background(), false)
	if !result.CheckedAt.IsZero() || result.Error != "" || result.Latest != nil {
		t.Fatalf("disabled background check made a request: %#v", result)
	}
}
