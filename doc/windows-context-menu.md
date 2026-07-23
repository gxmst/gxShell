# Windows Context Menu Integration

gxShell registers per-user text-file context-menu entries under:

```text
HKCU\Software\Classes\SystemFileAssociations\<ext>\shell\OpenWithGxShell
HKCU\Software\Classes\*\shell\OpenWithGxShell
HKCU\Software\Classes\Applications\gxShell.exe
```

This covers supported text extensions without changing the user's default file
handlers and without requiring administrator rights.

On Windows 11, traditional registry verbs may still appear under "Show more
options". First-level Windows 11 menu placement is controlled by the modern
Explorer command model, normally through a packaged app identity/MSIX sparse
package with `FileExplorerContextMenus`, or a COM Explorer command handler.

Do not try to fake the Windows 11 first-level menu with undocumented registry
hacks. The stable path is to add a packaged Explorer extension in the Windows
installer while keeping the current registry registration as a fallback for
classic menus, development builds, and unsupported installs.
