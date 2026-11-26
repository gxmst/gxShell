package app

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	sftpmanager "gxShell/backend/sftp"
	"gxShell/backend/types"
	"gxShell/internal/desktop"
)

type dropDestination struct{ sessionID, directory string }

// Use the directory under the pointer at drop time. An independent file
// window can only receive uploads for its own session.
func sftpDropDestination(window string, target *application.DropTargetDetails) (dropDestination, bool) {
	if target == nil || target.Attributes["data-gx-drop"] != "sftp" {
		return dropDestination{}, false
	}
	id, dir := target.Attributes["data-session"], target.Attributes["data-directory"]
	if id == "" || dir == "" || (window != "main" && window != "sftp-"+id) {
		return dropDestination{}, false
	}
	return dropDestination{id, dir}, true
}

func (a *App) watchFileDrops(win *application.WebviewWindow) {
	win.OnWindowEvent(events.Common.WindowFilesDropped, func(e *application.WindowEvent) {
		ctx := e.Context()
		paths := ctx.DroppedFiles()
		if len(paths) == 0 {
			return
		}
		target := ctx.DropTargetDetails()
		if target != nil && target.Attributes["data-gx-drop"] == "sftp" {
			if dest, ok := sftpDropDestination(win.Name(), target); ok {
				a.uploadDroppedFiles(win, dest, paths)
			}
			return
		}
		if win.Name() == "main" {
			a.openDroppedDocuments(a.ctx.Get(), paths)
		}
	})
}

func (a *App) uploadDroppedFiles(win *application.WebviewWindow, dest dropDestination, files []string) {
	session, err := a.ssh.Get(dest.sessionID)
	if err != nil || session.State != types.SessionConnected {
		return
	}
	settings, _ := a.store.GetSettings()
	zh := settings.Language == "zh-CN"
	title, upload, cancel, overwrite := "Upload files", "Upload", "Cancel", "Overwrite"
	where := fmt.Sprintf("Server: %s\nRemote directory: %s", session.Name, dest.directory)
	if zh {
		title, upload, cancel, overwrite = "上传文件", "上传", "取消", "覆盖"
		where = fmt.Sprintf("服务器：%s\n远程目录：%s", session.Name, dest.directory)
	}
	confirm := func(body, action string) bool {
		a.nativeDialogMu.Lock()
		defer a.nativeDialogMu.Unlock()
		if w, ok := application.Get().Window.GetByID(win.ID()); !ok || w != win {
			return false
		}
		ctx := desktop.WithWindow(a.ctx.Get(), win)
		answer, err := desktop.MessageDialog(ctx, desktop.MessageDialogOptions{
			Title: title, Message: where + "\n\n" + body, Buttons: []string{action, cancel}, DefaultButton: cancel, CancelButton: cancel,
		})
		return err == nil && answer == action
	}

	if !confirm(strings.Join(files, "\n"), upload) {
		return
	}
	result := struct {
		SessionID string   `json:"sessionId"`
		Directory string   `json:"directory"`
		Uploaded  int      `json:"uploaded"`
		Skipped   int      `json:"skipped"`
		Errors    []string `json:"errors"`
	}{SessionID: dest.sessionID, Directory: dest.directory}
	for _, local := range files {
		name := filepath.Base(local)
		info, err := os.Stat(local)
		if err == nil && (!info.Mode().IsRegular() || strings.Contains(name, "\\")) {
			if zh {
				err = fmt.Errorf("请选择普通文件：%s", local)
			} else {
				err = fmt.Errorf("expected a regular file: %s", local)
			}
		}
		target := path.Join(dest.directory, name)
		if err == nil {
			var exists bool
			exists, err = a.sftp.RemoteFileExists(dest.sessionID, target)
			if err == nil && !exists {
				err = a.sftp.UploadFileWithPolicy(dest.sessionID, local, target, false)
			}
			if (err == nil && exists) || sftpmanager.IsOverwriteRequired(err) {
				message := fmt.Sprintf("Replace the remote file %s?", target)
				if zh {
					message = fmt.Sprintf("覆盖已有的远程文件 %s？", target)
				}
				if !confirm(message, overwrite) {
					result.Skipped++
					continue
				}
				err = a.sftp.UploadFileWithPolicy(dest.sessionID, local, target, true)
			}
		}
		if err != nil {
			result.Skipped++
			result.Errors = append(result.Errors, err.Error())
			continue
		}
		result.Uploaded++
	}
	if w, ok := application.Get().Window.GetByID(win.ID()); ok && w == win {
		win.DispatchWailsEvent(&application.CustomEvent{Name: "sftp:drop-result", Data: result})
	}
}
