# Sidebar Connection Tree & Connection Form

**Date:** 2026-03-18
**Status:** Approved

## Summary

VS Code sidebar'a native TreeView ile SQL Server bağlantı paneli eklenmesi. mssql eklentisindeki "SQL Server" paneline benzer yapı: bağlantı listesi, nesne explorer (Tables/Views/SPs/Functions), kolon detayları, context menu aksiyonları ve webview tabanlı bağlantı formu.

## Architecture

### Yaklaşım: TreeView + Webview Tab

- **Sidebar**: VS Code native `TreeDataProvider` (performanslı, native context menu/icon desteği)
- **Bağlantı formu**: Ayrı editor tab'da açılan Webview panel (geniş alan, mssql benzeri UX)

### New Files

| File | Responsibility |
|------|---------------|
| `src/providers/connectionTreeProvider.ts` | `TreeDataProvider` implementation — tree data source, refresh logic |
| `src/providers/connectionTreeItems.ts` | TreeItem subclasses: ConnectionItem, ObjectFolderItem, ObjectItem, ColumnItem, ProjectFolderItem |
| `src/providers/connectionFormProvider.ts` | WebviewPanel — connection add/edit form (HTML/CSS/JS) |

### Modified Files

| File | Changes |
|------|---------|
| `package.json` | viewsContainers (activitybar), views, commands, menus |
| `src/extension.ts` | Register tree provider, form provider, new commands |
| `src/connection/connectionManager.ts` | Add `testConnection()` method |

## Tree Hierarchy

```
📁 ArimisProd (connected ✓)          → ConnectionItem (contextValue: "connection.connected")
  📂 Project: C:\...\SQL-DEV         → ProjectFolderItem (contextValue: "projectFolder")
  📂 Tables (124)                    → ObjectFolderItem (contextValue: "folder.tables")
    📄 AsortimentMaster              → ObjectItem (contextValue: "table")
      🔑 ID (int, not null)          → ColumnItem (contextValue: "column.pk")
      🔗 CategoryID (int, null)      → ColumnItem (contextValue: "column.fk")
      📄 Name (varchar(50), null)    → ColumnItem (contextValue: "column")
  📂 Views (12)                      → ObjectFolderItem (contextValue: "folder.views")
    📄 vw_ActiveProducts             → ObjectItem (contextValue: "view")
  📂 Stored Procedures (45)          → ObjectFolderItem (contextValue: "folder.sps")
    📄 sp_GetOrders                  → ObjectItem (contextValue: "sp")
  📂 Functions (8)                   → ObjectFolderItem (contextValue: "folder.functions")
    📄 fn_CalculateTotal             → ObjectItem (contextValue: "func")
📁 AtiksaProd                        → ConnectionItem (contextValue: "connection.disconnected")
📁 Eksen                             → ConnectionItem (contextValue: "connection.disconnected")
```

### Lazy Loading Strategy

- **Connection node expand**: Connects if not already connected, then shows folder nodes
- **Folder node expand**: Reads from schemaCache (instant if loaded, loading indicator if not)
- **Table node expand**: Loads columns via `schemaCache.getColumns(tableName)` (returns `Promise<ColumnInfo[]>`, lazy if not cached). `getChildren()` returns `Thenable<TreeItem[]>` for async column loading.

## package.json Contributions

### Activity Bar & Views

```jsonc
"viewsContainers": {
  "activitybar": [{
    "id": "tsql-explorer",
    "title": "T-SQL Explorer",
    "icon": "$(database)"
  }],
  "panel": [{ /* existing query results panel */ }]
},
"views": {
  "tsql-explorer": [{
    "id": "tsqlConnections",
    "name": "Connections"
  }],
  "tsql-results-panel": [{ /* existing */ }]
}
```

> **Not:** Başlık "T-SQL Explorer" olarak seçildi — mssql'in "SQL Server" başlığıyla çakışmayı önlemek için.

### Context Menus (view/item/context)

| contextValue | Actions |
|-------------|---------|
| `connection.connected` | Disconnect, Refresh Schema, Edit, Delete, Set Project Path |
| `connection.disconnected` | Connect, Edit, Delete |
| `folder.tables` | Refresh |
| `table` | SELECT TOP 100, Copy Script, Open Script |
| `view` | Open Script |
| `sp` | ALTER PROC (fetch code), EXEC with Params |
| `func` | Open Script |
| `projectFolder` | Open in Explorer |

### Menus Contribution (package.json)

```jsonc
"menus": {
  "view/title": [
    { "command": "tsql-intellisense.addConnection", "when": "view == tsqlConnections", "group": "navigation" },
    { "command": "tsql-intellisense.refreshSchema", "when": "view == tsqlConnections", "group": "navigation" }
  ],
  "view/item/context": [
    { "command": "tsql-intellisense.treeConnect", "when": "viewItem == connection.disconnected", "group": "1_connection" },
    { "command": "tsql-intellisense.disconnect", "when": "viewItem == connection.connected", "group": "1_connection" },
    { "command": "tsql-intellisense.refreshSchema", "when": "viewItem == connection.connected", "group": "1_connection" },
    { "command": "tsql-intellisense.editConnection", "when": "viewItem =~ /^connection\\./" , "group": "2_manage" },
    { "command": "tsql-intellisense.deleteConnection", "when": "viewItem =~ /^connection\\./" , "group": "2_manage" },
    { "command": "tsql-intellisense.setProjectPath", "when": "viewItem == connection.connected", "group": "2_manage" },
    { "command": "tsql-intellisense.selectTop100", "when": "viewItem == table", "group": "1_actions" },
    { "command": "tsql-intellisense.copyTableScript", "when": "viewItem == table", "group": "1_actions" },
    { "command": "tsql-intellisense.openTableScript", "when": "viewItem == table || viewItem == view || viewItem == func", "group": "1_actions" },
    { "command": "tsql-intellisense.alterProc", "when": "viewItem == sp", "group": "1_actions" },
    { "command": "tsql-intellisense.openInExplorer", "when": "viewItem == projectFolder", "group": "1_actions" }
  ]
}
```

### View Title Toolbar

- **+** (Add Connection) — opens webview form
- **🔄** (Refresh All) — refreshes all connected schemas

## Connection Form (Webview Tab)

### Opening

Triggered by "+" toolbar button or "Edit" context menu. Opens as a separate editor tab via `vscode.window.createWebviewPanel()`.

### Form Fields

| Field | Type | Required | Default |
|-------|------|----------|---------|
| Profile Name | text | ✓ | — |
| Server | text | ✓ | — |
| Port | number | | 1433 |
| Authentication | dropdown | ✓ | SQL Login |
| User Name | text | if SQL Login ✓ | — |
| Password | password | if SQL Login ✓ | — |
| Database | text | ✓ | — |
| Trust Server Certificate | checkbox | | ✓ |
| Project Path | text + browse | | — |

### Authentication Types

- **SQL Login** — user/password fields visible
- **Windows Auth** — user/password hidden (tedious `authentication.type: 'ntlm'`)

Authentication type is implicit: `user` alanı doluysa SQL Login, boşsa Windows Auth. `ConnectionProfile` interface'ine yeni alan eklenmez — mevcut davranış korunur. Form'da dropdown seçimi sadece user/password alanlarının görünürlüğünü kontrol eder.

### Buttons

- **Test Connection** — tests connectivity, shows result inline
- **Save** — saves profile to settings.json, refreshes tree
- **Save & Connect** — saves + connects immediately

### Webview ↔ Extension Communication

```
Form (HTML/JS)                    Extension (TS)
   ──postMessage({cmd:'test'})──►   connectionManager.testConnection()
   ◄──postMessage({result:ok})───
   ──postMessage({cmd:'save'})──►   write to settings.json, tree.refresh()
   ──postMessage({cmd:'browse'})─►  vscode.window.showOpenDialog → send path back
```

### Edit Mode

Same form opens with existing values pre-filled. Save updates the matching profile in settings.json.

### Styling

Uses VS Code CSS variables (`--vscode-input-background`, `--vscode-button-background`, etc.) for native dark/light theme support.

## Integration with Existing Architecture

### ConnectionManager Changes

- New `testConnection(profile: ConnectionProfile): Promise<boolean>` method
- Existing `onConnectionChanged` event used to trigger tree refresh
- Status bar behavior preserved

### SchemaCache Integration

Tree uses existing schemaCache directly — no new cache mechanism:
- `schemaCache.getTablesAndViews()` → returns `ObjectInfo[]`, tree filters by `type === 'TABLE'` and `type === 'VIEW'` for separate folders
- `schemaCache.getProcedures()` → SP list for "Stored Procedures" folder
- `schemaCache.getFunctions()` → Function list for "Functions" folder
- `schemaCache.getColumns(tableName)` → returns `Promise<ColumnInfo[]>` (async, tree's `getChildren()` returns `Thenable`)
- `schemaCache.isFullyLoaded` → loading state indicator
- Folder counts (e.g. "Tables (124)") reflect cached data; "Refresh" triggers `schemaCache.refresh()` which reloads from server

### Single Active Connection

Current single-connection architecture is preserved:
- Multiple profiles listed in tree
- Clicking a disconnected connection: connects (disconnect previous first) and expands
- Clicking an already connected connection: no-op (just selects/expands)
- Active connection visually highlighted (bold + `$(database)` icon, disconnected uses `$(plug)`)
- Multi-connection support is future scope

### Connection Click Behavior

`treeConnect` command is triggered by double-click on a disconnected ConnectionItem (via `TreeItem.command`). Single-click only selects/expands. Connected items have no command — clicking just expands.

### Existing Commands Preserved

| Command | Change |
|---------|--------|
| `tsql-intellisense.connect` | Kept (Command Palette still works) |
| `tsql-intellisense.disconnect` | Kept |
| `tsql-intellisense.refreshSchema` | Kept, also refreshes tree |
| `promptConnect()` | Kept as fallback |

### New Commands

| Command | Trigger |
|---------|---------|
| `tsql-intellisense.addConnection` | Tree toolbar "+" |
| `tsql-intellisense.editConnection` | Context menu "Edit" |
| `tsql-intellisense.deleteConnection` | Context menu "Delete" |
| `tsql-intellisense.selectTop100` | Table context menu |
| `tsql-intellisense.openInExplorer` | Project folder context menu |
| `tsql-intellisense.treeConnect` | Connection item click/context menu |

### extension.ts Changes

- Create `ConnectionTreeProvider` and register via `vscode.window.createTreeView()` (not `registerTreeDataProvider`) — `createTreeView` provides `TreeView` instance for programmatic `reveal()` and active connection highlighting
- Create `ConnectionFormProvider`
- Register new commands
- Add tree refresh to `onConnectionChanged` handler

## Error Handling

Tree operasyonlarında hata durumları:

- **Bağlantı hatası (expand sırasında)**: Connection node altında `$(error) Connection failed: <message>` child item gösterilir
- **Schema yükleme hatası**: Folder altında `$(warning) Failed to load: <message>` child item gösterilir
- **Bağlantı düşmesi**: `onConnectionChanged(null)` tetiklenir → tree refresh → connection disconnected state'e döner
- **Delete connection (aktif bağlantı)**: Onay dialogu gösterilir ("This connection is active. Disconnect and delete?"). Onay → disconnect + delete.
- **Delete connection (pasif)**: Onay dialogu ("Delete connection 'ProfileName'?") → settings.json'dan kaldır, tree refresh

## Security: Password Storage

Şifreler şu anda `settings.json`'da plaintext saklanıyor (mevcut davranış). Bu bilinen bir sınırlama. Gelecekte `ExtensionContext.secrets` (VS Code SecretStorage API) ile güvenli saklama planlanıyor — bu spec'in scope'u dışında.

## Constraints

- Tek aktif bağlantı (multi-connection gelecek scope)
- Mevcut schemaCache yapısı korunur, tree sadece consumer
- settings.json'daki connection format değişmez (backward compatible)
- Mevcut Command Palette komutları çalışmaya devam eder
