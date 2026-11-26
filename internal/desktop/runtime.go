// Package desktop connects application operations to the main Wails window.
package desktop

import (
	"context"
	"errors"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type windowKey struct{}

func WithWindow(ctx context.Context, w *application.WebviewWindow) context.Context {
	return context.WithValue(ctx, windowKey{}, w)
}
func CallerContext(caller, fallback context.Context) context.Context {
	if w, ok := caller.Value(application.WindowKey).(*application.WebviewWindow); ok {
		return WithWindow(caller, w)
	}
	return fallback
}
func MainWindow(ctx context.Context) *application.WebviewWindow {
	if ctx == nil {
		return nil
	}
	w, _ := ctx.Value(windowKey{}).(*application.WebviewWindow)
	return w
}
func EventsEmit(ctx context.Context, name string, data ...any) {
	if MainWindow(ctx) != nil {
		application.Get().Event.Emit(name, data...)
	}
}
func EmitToWindow(ctx context.Context, name string, data any) {
	if w := MainWindow(ctx); w != nil {
		w.DispatchWailsEvent(&application.CustomEvent{Name: name, Data: data})
	}
}
func Quit(ctx context.Context) {
	if MainWindow(ctx) == nil {
		return
	}
	host := application.Get()
	if runtime.GOOS == "windows" {
		// Closing through WM_CLOSE lets every WebView2 controller finish its
		// native teardown while the UI message pump is still running.
		for _, w := range host.Window.GetAll() {
			w.Close()
		}
		return
	}
	host.Quit()
}
func WindowCenter(ctx context.Context) {
	if w := MainWindow(ctx); w != nil {
		w.Center()
	}
}
func WindowShow(ctx context.Context) {
	if w := MainWindow(ctx); w != nil {
		w.Show()
	}
}
func WindowUnminimise(ctx context.Context) {
	if w := MainWindow(ctx); w != nil {
		if w.IsMinimised() {
			w.UnMinimise()
		}
		w.Focus()
	}
}
func WindowMinimise(ctx context.Context) {
	if w := MainWindow(ctx); w != nil {
		w.Minimise()
	}
}
func WindowToggleMaximise(ctx context.Context) {
	if w := MainWindow(ctx); w != nil {
		w.ToggleMaximise()
	}
}
func WindowIsMaximised(ctx context.Context) bool {
	w := MainWindow(ctx)
	return w != nil && w.IsMaximised()
}
func WindowIsMinimised(ctx context.Context) bool {
	w := MainWindow(ctx)
	return w != nil && w.IsMinimised()
}
func WindowSetAlwaysOnTop(ctx context.Context, b bool) {
	if w := MainWindow(ctx); w != nil {
		w.SetAlwaysOnTop(b)
	}
}
func WindowSetBackgroundColour(ctx context.Context, r, g, b, a uint8) {
	if w := MainWindow(ctx); w != nil {
		w.SetBackgroundColour(application.NewRGB(r, g, b))
	}
}

type FileFilter = application.FileFilter
type OpenDialogOptions struct {
	Title, DefaultDirectory, DefaultFilename string
	ShowHiddenFiles                          bool
	Filters                                  []FileFilter
}
type SaveDialogOptions struct {
	Title, DefaultFilename string
	Filters                []FileFilter
}

var errNoWindow = errors.New("desktop window unavailable")

func OpenFileDialog(ctx context.Context, o OpenDialogOptions) (string, error) {
	w := MainWindow(ctx)
	if w == nil {
		return "", errNoWindow
	}
	return application.Get().Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{
		Window: w, CanChooseFiles: true, Title: o.Title, Directory: o.DefaultDirectory, Filters: o.Filters, ShowHiddenFiles: o.ShowHiddenFiles,
	}).PromptForSingleSelection()
}
func SaveFileDialog(ctx context.Context, o SaveDialogOptions) (string, error) {
	w := MainWindow(ctx)
	if w == nil {
		return "", errNoWindow
	}
	return application.Get().Dialog.SaveFileWithOptions(&application.SaveFileDialogOptions{
		Window: w, CanCreateDirectories: true, Title: o.Title, Filename: o.DefaultFilename, Filters: o.Filters,
	}).PromptForSingleSelection()
}

const QuestionDialog = application.QuestionDialogType

type MessageDialogOptions struct {
	Type                                        application.DialogType
	Title, Message, DefaultButton, CancelButton string
	Buttons                                     []string
}

func MessageDialog(ctx context.Context, o MessageDialogOptions) (string, error) {
	w := MainWindow(ctx)
	if w == nil {
		return "", errNoWindow
	}
	d := application.Get().Dialog.Question().AttachToWindow(w).SetTitle(o.Title).SetMessage(o.Message)
	buttons := o.Buttons
	if len(buttons) == 0 {
		buttons = []string{"Yes", "No"}
	}
	result := o.CancelButton
	for _, label := range buttons {
		b := d.AddButton(label).OnClick(func() { result = label })
		if label == o.DefaultButton {
			b.SetAsDefault()
		}
		if label == o.CancelButton {
			b.SetAsCancel()
		}
	}
	d.Show()
	return result, nil
}
