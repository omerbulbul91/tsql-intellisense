# Sidebar Connection Tree Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native TreeView sidebar panel with connection management, object explorer, context menus, and a webview-based connection form to the tsql-intellisense VS Code extension.

**Architecture:** Native `TreeDataProvider` for the sidebar tree (lightweight, native icons/context menus), separate `WebviewPanel` for the connection add/edit form. Tree consumes existing `SchemaCache` — no new caching layer. Single active connection model preserved.

**Tech Stack:** TypeScript, VS Code Extension API (TreeDataProvider, WebviewPanel, createTreeView), tedious (SQL Server driver)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/providers/connectionTreeItems.ts` | Create | TreeItem subclasses: ConnectionItem, ProjectFolderItem, ObjectFolderItem, ObjectItem, ColumnItem, ErrorItem |
| `src/providers/connectionTreeProvider.ts` | Create | TreeDataProvider — getTreeItem, getChildren, refresh, event wiring |
| `src/providers/connectionFormProvider.ts` | Create | WebviewPanel factory — HTML form, postMessage handling, save/test/browse |
| `src/connection/connectionManager.ts` | Modify | Add `testConnection()` method |
| `package.json` | Modify | Add activitybar viewContainer, views, commands, menus |
| `src/extension.ts` | Modify | Register tree, form, new commands, wire events |

---

## Chunk 1: Tree Item Classes & Tree Data Provider

### Task 1: Create TreeItem subclasses

**Files:**
- Create: `src/providers/connectionTreeItems.ts`

- [ ] **Step 1: Create connectionTreeItems.ts with all TreeItem subclasses**

```typescript
// src/providers/connectionTreeItems.ts
import * as vscode from 'vscode';

/** Root-level connection profile node */
export class ConnectionItem extends vscode.TreeItem {
    constructor(
        public readonly profileName: string,
        public readonly server: string,
        public readonly database: string,
        public readonly isActive: boolean,
        public readonly projectPath?: string
    ) {
        super(profileName, vscode.TreeItemCollapsibleState.Collapsed);

        this.description = `${server} / ${database}`;
        this.contextValue = isActive ? 'connection.connected' : 'connection.disconnected';
        this.iconPath = new vscode.ThemeIcon(isActive ? 'database' : 'plug');

        if (isActive) {
            this.tooltip = `Connected: ${server} / ${database}`;
        } else {
            this.tooltip = `${server} / ${database} (disconnected)`;
            // Double-click to connect
            this.command = {
                command: 'tsql-intellisense.treeConnect',
                title: 'Connect',
                arguments: [profileName]
            };
        }
    }
}

/** Project folder node (shown when projectPath is set) */
export class ProjectFolderItem extends vscode.TreeItem {
    constructor(public readonly projectPath: string) {
        super(`Project: ${projectPath}`, vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'projectFolder';
        this.iconPath = new vscode.ThemeIcon('folder-library');
        this.tooltip = projectPath;
    }
}

export type ObjectFolderType = 'tables' | 'views' | 'sps' | 'functions';

/** Folder node for Tables, Views, SPs, Functions */
export class ObjectFolderItem extends vscode.TreeItem {
    constructor(
        public readonly folderType: ObjectFolderType,
        public readonly count: number
    ) {
        const labels: Record<ObjectFolderType, string> = {
            tables: 'Tables',
            views: 'Views',
            sps: 'Stored Procedures',
            functions: 'Functions',
        };
        const icons: Record<ObjectFolderType, string> = {
            tables: 'symbol-class',
            views: 'symbol-interface',
            sps: 'symbol-method',
            functions: 'symbol-function',
        };

        super(labels[folderType], vscode.TreeItemCollapsibleState.Collapsed);
        this.description = `(${count})`;
        this.contextValue = `folder.${folderType}`;
        this.iconPath = new vscode.ThemeIcon(icons[folderType]);
    }
}

export type ObjectType = 'table' | 'view' | 'sp' | 'func';

/** Individual database object node */
export class ObjectItem extends vscode.TreeItem {
    constructor(
        public readonly objectName: string,
        public readonly objectType: ObjectType,
        public readonly hasTrigger: boolean = false
    ) {
        const isExpandable = objectType === 'table' || objectType === 'view';
        super(
            objectName,
            isExpandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );

        this.contextValue = objectType;
        const icons: Record<ObjectType, string> = {
            table: 'symbol-class',
            view: 'symbol-interface',
            sp: 'symbol-method',
            func: 'symbol-function',
        };
        this.iconPath = new vscode.ThemeIcon(icons[objectType]);
        this.tooltip = hasTrigger ? `${objectName} ⚡ (has triggers)` : objectName;
    }
}

/** Column node under a table/view */
export class ColumnItem extends vscode.TreeItem {
    constructor(
        public readonly columnName: string,
        public readonly dataType: string,
        public readonly isNullable: boolean,
        public readonly isPK: boolean,
        public readonly isFK: boolean
    ) {
        super(columnName, vscode.TreeItemCollapsibleState.None);

        const nullStr = isNullable ? 'null' : 'not null';
        this.description = `${dataType} ${nullStr}`;

        if (isPK) {
            this.contextValue = 'column.pk';
            this.iconPath = new vscode.ThemeIcon('key');
        } else if (isFK) {
            this.contextValue = 'column.fk';
            this.iconPath = new vscode.ThemeIcon('link');
        } else {
            this.contextValue = 'column';
            this.iconPath = new vscode.ThemeIcon('symbol-field');
        }
    }
}

/** Error/info node shown when loading fails */
export class ErrorItem extends vscode.TreeItem {
    constructor(message: string, isError: boolean = true) {
        super(message, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(isError ? 'error' : 'warning');
        this.contextValue = 'errorItem';
    }
}
```

- [ ] **Step 2: Verify build succeeds**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/providers/connectionTreeItems.ts
git commit -m "feat: add TreeItem subclasses for connection sidebar"
```

---

### Task 2: Create TreeDataProvider

**Files:**
- Create: `src/providers/connectionTreeProvider.ts`

- [ ] **Step 1: Create connectionTreeProvider.ts**

```typescript
// src/providers/connectionTreeProvider.ts
import * as vscode from 'vscode';
import { ConnectionManager, ConnectionProfile } from '../connection/connectionManager';
import { SchemaCache } from '../cache/schemaCache';
import {
    ConnectionItem,
    ProjectFolderItem,
    ObjectFolderItem,
    ObjectFolderType,
    ObjectItem,
    ColumnItem,
    ErrorItem,
} from './connectionTreeItems';

type TreeNode = ConnectionItem | ProjectFolderItem | ObjectFolderItem | ObjectItem | ColumnItem | ErrorItem;

export class ConnectionTreeProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private connectionError: string | null = null;

    constructor(
        private connectionManager: ConnectionManager,
        private schemaCache: SchemaCache
    ) {}

    refresh(): void {
        this.connectionError = null;
        this._onDidChangeTreeData.fire();
    }

    setConnectionError(message: string): void {
        this.connectionError = message;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        // Root level: list all connection profiles
        if (!element) {
            return this.getRootChildren();
        }

        // Connection node: show project folder + object folders
        if (element instanceof ConnectionItem) {
            return this.getConnectionChildren(element);
        }

        // Object folder: list objects of that type
        if (element instanceof ObjectFolderItem) {
            return this.getObjectFolderChildren(element);
        }

        // Object (table/view): list columns
        if (element instanceof ObjectItem) {
            return this.getObjectChildren(element);
        }

        return [];
    }

    private getRootChildren(): TreeNode[] {
        const profiles = this.connectionManager.getSavedProfiles();
        const activeProfile = this.connectionManager.currentProfile;

        return profiles.map(p => {
            const isActive = !!activeProfile
                && p.name === activeProfile.name
                && p.server === activeProfile.server
                && p.database === activeProfile.database;
            return new ConnectionItem(p.name, p.server, p.database, isActive, p.projectPath);
        });
    }

    private getConnectionChildren(item: ConnectionItem): TreeNode[] {
        if (!item.isActive) {
            return [new ErrorItem('Not connected — double-click to connect', false)];
        }

        if (this.connectionError) {
            return [new ErrorItem(`Connection failed: ${this.connectionError}`)];
        }

        const children: TreeNode[] = [];

        // Project folder
        if (item.projectPath) {
            children.push(new ProjectFolderItem(item.projectPath));
        }

        // If schema not yet loaded, show loading indicator
        if (!this.schemaCache.isLoaded) {
            children.push(new ErrorItem('$(sync~spin) Loading schema...', false));
            return children;
        }

        // Object folders with counts
        const tablesAndViews = this.schemaCache.getTablesAndViews();
        const tables = tablesAndViews.filter(o => o.type === 'TABLE');
        const views = tablesAndViews.filter(o => o.type === 'VIEW');
        const sps = this.schemaCache.getProcedures();
        const funcs = this.schemaCache.getFunctions();

        children.push(new ObjectFolderItem('tables', tables.length));
        children.push(new ObjectFolderItem('views', views.length));
        children.push(new ObjectFolderItem('sps', sps.length));
        children.push(new ObjectFolderItem('functions', funcs.length));

        return children;
    }

    private getObjectFolderChildren(folder: ObjectFolderItem): TreeNode[] {
        if (!this.schemaCache.isLoaded) {
            return [new ErrorItem('Schema loading...', false)];
        }

        const typeMap: Record<ObjectFolderType, () => TreeNode[]> = {
            tables: () => {
                const items = this.schemaCache.getTablesAndViews().filter(o => o.type === 'TABLE');
                return items
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(o => new ObjectItem(o.name, 'table', this.schemaCache.hasTriggers(o.name)));
            },
            views: () => {
                const items = this.schemaCache.getTablesAndViews().filter(o => o.type === 'VIEW');
                return items
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(o => new ObjectItem(o.name, 'view'));
            },
            sps: () => {
                return this.schemaCache.getProcedures()
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(o => new ObjectItem(o.name, 'sp'));
            },
            functions: () => {
                return this.schemaCache.getFunctions()
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(o => new ObjectItem(o.name, 'func'));
            },
        };

        const builder = typeMap[folder.folderType];
        return builder ? builder() : [];
    }

    private async getObjectChildren(item: ObjectItem): Promise<TreeNode[]> {
        if (item.objectType !== 'table' && item.objectType !== 'view') {
            return [];
        }

        try {
            const columns = await this.schemaCache.getColumns(item.objectName);
            if (columns.length === 0) {
                return [new ErrorItem('No columns found', false)];
            }

            // Determine PK and FK columns
            const indexes = this.schemaCache.getIndexes(item.objectName);
            const pk = indexes.find(idx => idx.isPrimaryKey);
            const pkCols = new Set(pk ? pk.columns.split(',').map(c => c.trim().replace(/\[|\]/g, '')) : []);

            const fks = this.schemaCache.getForeignKeysForTable(item.objectName);
            const fkCols = new Set(fks.map(fk => fk.parentColumn));

            return columns.map(col => {
                let typeStr = col.dataType;
                if (col.maxLength && col.maxLength > 0) {
                    typeStr += `(${col.maxLength})`;
                }
                return new ColumnItem(
                    col.name,
                    typeStr,
                    col.isNullable,
                    pkCols.has(col.name),
                    fkCols.has(col.name)
                );
            });
        } catch (err: any) {
            return [new ErrorItem(`Failed to load columns: ${err.message}`)];
        }
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
```

- [ ] **Step 2: Verify build succeeds**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/providers/connectionTreeProvider.ts
git commit -m "feat: add ConnectionTreeProvider for sidebar tree"
```

---

## Chunk 2: package.json & extension.ts Wiring

### Task 3: Update package.json — viewsContainers, views, commands, menus

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add activitybar viewContainer and view**

In the `contributes.viewsContainers` section, add `activitybar` alongside existing `panel`:

```jsonc
"viewsContainers": {
  "activitybar": [
    {
      "id": "tsql-explorer",
      "title": "T-SQL Explorer",
      "icon": "resources/database.svg"
    }
  ],
  "panel": [
    { /* existing tsql-results-panel */ }
  ]
}
```

> **Note:** Activity bar icons require an SVG file path — `$(codicon)` syntax doesn't work here. Create a simple `resources/database.svg` file (16x16 monochrome SVG). You can grab one from VS Code's codicon set or create a minimal one:

```svg
<!-- resources/database.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor">
  <ellipse cx="8" cy="3.5" rx="6" ry="2.5"/>
  <path d="M2 3.5v9c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5v-9" fill="none" stroke="currentColor" stroke-width="1"/>
  <ellipse cx="8" cy="8" rx="6" ry="2.5" fill="none" stroke="currentColor" stroke-width="0.5"/>
</svg>
```
```

In `contributes.views`, add `tsql-explorer` alongside existing `tsql-results-panel`:

```jsonc
"views": {
  "tsql-explorer": [
    {
      "id": "tsqlConnections",
      "name": "Connections"
    }
  ],
  "tsql-results-panel": [
    { /* existing tsqlResults */ }
  ]
}
```

- [ ] **Step 2: Add new commands to contributes.commands**

Append these commands to the existing commands array:

```jsonc
{ "command": "tsql-intellisense.addConnection", "title": "T-SQL IntelliSense: Add Connection", "icon": "$(add)" },
{ "command": "tsql-intellisense.editConnection", "title": "T-SQL IntelliSense: Edit Connection", "icon": "$(edit)" },
{ "command": "tsql-intellisense.deleteConnection", "title": "T-SQL IntelliSense: Delete Connection", "icon": "$(trash)" },
{ "command": "tsql-intellisense.treeConnect", "title": "T-SQL IntelliSense: Connect", "icon": "$(plug)" },
{ "command": "tsql-intellisense.selectTop100", "title": "SELECT TOP 100", "icon": "$(play)" },
{ "command": "tsql-intellisense.openInExplorer", "title": "Open in Explorer", "icon": "$(folder-opened)" }
```

- [ ] **Step 3: Add menus contributions**

Add `view/title` and `view/item/context` menus. Merge with existing `menus` section:

```jsonc
"menus": {
  "editor/title": [ /* existing run query button */ ],
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
    { "command": "tsql-intellisense.refreshSchema", "when": "viewItem =~ /^folder\\./" , "group": "1_actions" },
    { "command": "tsql-intellisense.selectTop100", "when": "viewItem == table", "group": "1_actions" },
    { "command": "tsql-intellisense.copyTableScript", "when": "viewItem == table", "group": "1_actions" },
    { "command": "tsql-intellisense.openTableScript", "when": "viewItem == table || viewItem == view || viewItem == func", "group": "1_actions" },
    { "command": "tsql-intellisense.alterProc", "when": "viewItem == sp", "group": "1_actions" },
    { "command": "tsql-intellisense.insertSpParams", "when": "viewItem == sp", "group": "1_actions" },
    { "command": "tsql-intellisense.openInExplorer", "when": "viewItem == projectFolder", "group": "1_actions" }
  ]
}
```

- [ ] **Step 4: Verify JSON valid**

Run: `npm run build`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "feat: add sidebar viewContainer, commands, and context menus to package.json"
```

---

### Task 4: Add testConnection to ConnectionManager

**Files:**
- Modify: `src/connection/connectionManager.ts`

- [ ] **Step 1: Add testConnection method**

Add this method to the `ConnectionManager` class (before `promptConnect()`):

```typescript
/** Test a connection profile without affecting current connection state */
async testConnection(profile: ConnectionProfile): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
        const config = {
            server: profile.server,
            authentication: {
                type: (profile.user ? 'default' : 'ntlm') as 'default' | 'ntlm',
                options: {
                    userName: profile.user || '',
                    password: profile.password || '',
                },
            },
            options: {
                database: profile.database,
                port: profile.port || 1433,
                trustServerCertificate: profile.trustServerCertificate !== false,
                encrypt: false,
                connectTimeout: 10000,
            },
        };

        const testConn = new Connection(config);

        testConn.on('connect', (err) => {
            if (err) {
                resolve({ success: false, error: err.message });
            } else {
                testConn.close();
                resolve({ success: true });
            }
        });

        testConn.on('error', () => {
            // Swallow — handled in connect callback
        });

        testConn.connect();
    });
}
```

- [ ] **Step 2: Verify build succeeds**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/connection/connectionManager.ts
git commit -m "feat: add testConnection method to ConnectionManager"
```

---

### Task 5: Wire tree provider and new commands in extension.ts

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Add imports at top of extension.ts**

```typescript
import { ConnectionTreeProvider } from './providers/connectionTreeProvider';
```

> **Note:** `ConnectionFormProvider` import will be added in Task 6 Step 2, after the file is created, to keep every commit buildable.

- [ ] **Step 2: Create tree provider and register TreeView**

Add after the `queryRunner` initialization block (after line 25), before the webview provider registration:

```typescript
// Register sidebar tree view
const treeProvider = new ConnectionTreeProvider(connectionManager, schemaCache);
const treeView = vscode.window.createTreeView('tsqlConnections', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
});
context.subscriptions.push(treeView);
```

- [ ] **Step 3: Register new commands**

Add these command registrations in extension.ts:

```typescript
// Tree: Add Connection — placeholder, will be replaced in Task 6
context.subscriptions.push(
    vscode.commands.registerCommand('tsql-intellisense.addConnection', () => {
        vscode.window.showInformationMessage('Connection form loading...');
    })
);

// Tree: Edit Connection — placeholder, will be replaced in Task 6
context.subscriptions.push(
    vscode.commands.registerCommand('tsql-intellisense.editConnection', (item: any) => {
        vscode.window.showInformationMessage('Connection form loading...');
    })
);

// Tree: Delete Connection
context.subscriptions.push(
    vscode.commands.registerCommand('tsql-intellisense.deleteConnection', async (item: any) => {
        if (!item?.profileName) { return; }
        const activeProfile = connectionManager.currentProfile;
        const isActive = activeProfile && activeProfile.name === item.profileName;

        const confirmMsg = isActive
            ? `This connection is active. Disconnect and delete "${item.profileName}"?`
            : `Delete connection "${item.profileName}"?`;

        const answer = await vscode.window.showWarningMessage(confirmMsg, { modal: true }, 'Delete');
        if (answer !== 'Delete') { return; }

        if (isActive) {
            await connectionManager.disconnect();
        }

        const config = vscode.workspace.getConfiguration('tsql-intellisense');
        const connections = config.get<any[]>('connections', []);
        const filtered = connections.filter(c => c.name !== item.profileName);
        const target = vscode.workspace.workspaceFolders
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
        await config.update('connections', filtered, target);
        treeProvider.refresh();
    })
);

// Tree: Connect to a profile (handles both string from TreeItem.command and ConnectionItem from context menu)
context.subscriptions.push(
    vscode.commands.registerCommand('tsql-intellisense.treeConnect', async (arg: any) => {
        const profileName = typeof arg === 'string' ? arg : arg?.profileName;
        if (!profileName) { return; }
        const profiles = connectionManager.getSavedProfiles();
        const profile = profiles.find(p => p.name === profileName);
        if (!profile) { return; }

        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Connecting to ${profileName}...` },
                () => connectionManager.connect(profile)
            );
        } catch (err: any) {
            treeProvider.setConnectionError(err.message);
            vscode.window.showErrorMessage(err.message);
        }
    })
);

// Tree: SELECT TOP 100 from table
context.subscriptions.push(
    vscode.commands.registerCommand('tsql-intellisense.selectTop100', async (item: any) => {
        if (!item?.objectName || !connectionManager.isConnected) { return; }
        await queryRunner.runQueryText(`SELECT TOP 100 * FROM [${item.objectName}]`);
    })
);

// Tree: Open project folder in Explorer
context.subscriptions.push(
    vscode.commands.registerCommand('tsql-intellisense.openInExplorer', (item: any) => {
        if (!item?.projectPath) { return; }
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(item.projectPath));
    })
);
```

- [ ] **Step 4: Add tree refresh to onConnectionChanged handler**

In the existing `connectionManager.onConnectionChanged` callback (around line 488), add `treeProvider.refresh()` at the start of the callback:

```typescript
connectionManager.onConnectionChanged(async (profile) => {
    treeProvider.refresh(); // <-- ADD THIS LINE
    vscode.commands.executeCommand('setContext', 'tsqlIntellisense.connected', !!profile);
    // ... rest of existing code
});
```

Also add tree refresh after schema load completes (after the `statusItem.dispose()` line):

```typescript
treeProvider.refresh(); // refresh tree after schema fully loaded (counts update)
```

- [ ] **Step 5: Add treeProvider to dispose**

In the dispose block at the end of `activate()`:

```typescript
context.subscriptions.push({
    dispose: () => {
        connectionManager.dispose();
        schemaCache.dispose();
        queryRunner.dispose();
        treeProvider.dispose(); // <-- ADD
    }
});
```

- [ ] **Step 5b: Modify existing copyTableScript/openTableScript/alterProc handlers to accept TreeItem or string**

The existing handlers expect `(tableName: string)` but tree context menu passes an `ObjectItem`. Update these existing registrations:

For `copyTableScript` handler:
```typescript
vscode.commands.registerCommand('tsql-intellisense.copyTableScript', async (arg: any) => {
    const tableName = typeof arg === 'string' ? arg : arg?.objectName;
    if (!tableName) { return; }
    // ... rest of existing handler using tableName
```

For `openTableScript` handler:
```typescript
vscode.commands.registerCommand('tsql-intellisense.openTableScript', async (arg: any) => {
    const tableName = typeof arg === 'string' ? arg : arg?.objectName;
    if (!tableName) { return; }
    // ... rest of existing handler using tableName
```

For `alterProc` — currently opens a picker. When called from tree with an SP name, fetch code directly:
```typescript
vscode.commands.registerCommand('tsql-intellisense.alterProc', (arg: any) => {
    if (arg?.objectName) {
        // Called from tree context menu — fetch SP code directly
        vscode.commands.executeCommand('tsql-intellisense.fetchProcCode', arg.objectName);
    } else {
        // Called from Command Palette — show picker
        alterProcProvider.showAlterProcPicker();
    }
})
```

For `insertSpParams` — same pattern (accepts both string and ObjectItem):
```typescript
vscode.commands.registerCommand('tsql-intellisense.insertSpParams', async (arg: any) => {
    const spName = typeof arg === 'string' ? arg : arg?.objectName;
    if (!spName) { return; }
    // ... rest of existing handler using spName
```

- [ ] **Step 6: Verify build succeeds**

Run: `npm run build`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/extension.ts
git commit -m "feat: wire tree provider and new commands in extension.ts"
```

---

## Chunk 3: Connection Form Webview

### Task 6: Create connection form webview and wire to extension.ts

**Files:**
- Create: `src/providers/connectionFormProvider.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Create connectionFormProvider.ts**

```typescript
// src/providers/connectionFormProvider.ts
import * as vscode from 'vscode';
import { ConnectionManager, ConnectionProfile } from '../connection/connectionManager';
import { ConnectionTreeProvider } from './connectionTreeProvider';

export class ConnectionFormProvider {
    private static currentPanel: vscode.WebviewPanel | undefined;

    static show(
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager,
        treeProvider: ConnectionTreeProvider,
        editProfile?: ConnectionProfile
    ): void {
        const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;

        // Reuse existing panel if open
        if (ConnectionFormProvider.currentPanel) {
            ConnectionFormProvider.currentPanel.reveal(column);
            ConnectionFormProvider.currentPanel.webview.postMessage({
                cmd: 'loadProfile',
                profile: editProfile || null,
            });
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'tsqlConnectionForm',
            editProfile ? `Edit: ${editProfile.name}` : 'New Connection',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        ConnectionFormProvider.currentPanel = panel;
        panel.iconPath = new vscode.ThemeIcon('database');
        panel.webview.html = ConnectionFormProvider.getHtml(editProfile);

        panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.cmd) {
                case 'test': {
                    const result = await connectionManager.testConnection(msg.profile);
                    panel.webview.postMessage({ cmd: 'testResult', ...result });
                    break;
                }
                case 'save': {
                    await ConnectionFormProvider.saveProfile(msg.profile, msg.originalName);
                    treeProvider.refresh();
                    panel.webview.postMessage({ cmd: 'saved' });
                    break;
                }
                case 'saveAndConnect': {
                    await ConnectionFormProvider.saveProfile(msg.profile, msg.originalName);
                    treeProvider.refresh();
                    try {
                        await connectionManager.connect(msg.profile);
                        panel.webview.postMessage({ cmd: 'saved' });
                        panel.dispose();
                    } catch (err: any) {
                        panel.webview.postMessage({ cmd: 'testResult', success: false, error: err.message });
                    }
                    break;
                }
                case 'browse': {
                    const result = await vscode.window.showOpenDialog({
                        canSelectFiles: false,
                        canSelectFolders: true,
                        canSelectMany: false,
                        openLabel: 'Select Project Folder',
                    });
                    if (result && result[0]) {
                        panel.webview.postMessage({ cmd: 'browsed', path: result[0].fsPath });
                    }
                    break;
                }
            }
        }, undefined, context.subscriptions);

        panel.onDidDispose(() => {
            ConnectionFormProvider.currentPanel = undefined;
        }, null, context.subscriptions);
    }

    private static async saveProfile(profile: ConnectionProfile, originalName?: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('tsql-intellisense');
        const connections = config.get<any[]>('connections', []);
        const target = vscode.workspace.workspaceFolders
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;

        if (originalName) {
            // Edit mode: replace existing
            const idx = connections.findIndex(c => c.name === originalName);
            if (idx >= 0) {
                connections[idx] = profile;
            } else {
                connections.push(profile);
            }
        } else {
            connections.push(profile);
        }

        await config.update('connections', connections, target);
    }

    /** Escape HTML special chars to prevent injection in webview */
    static escapeHtml(str: string): string {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    private static getHtml(editProfile?: ConnectionProfile): string {
        const p = editProfile;
        const e = ConnectionFormProvider.escapeHtml; // shorthand
        const isWindows = p && !p.user;
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Connection</title>
<style>
    body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 20px 40px;
        max-width: 600px;
    }
    h2 {
        display: flex; align-items: center; gap: 10px;
        margin-bottom: 24px;
    }
    .form-group { margin-bottom: 16px; }
    label {
        display: block; margin-bottom: 4px;
        font-weight: 600; font-size: 12px;
        color: var(--vscode-descriptionForeground);
    }
    input, select {
        width: 100%; padding: 6px 8px; box-sizing: border-box;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 2px; font-size: 13px;
    }
    input:focus, select:focus {
        outline: 1px solid var(--vscode-focusBorder);
    }
    .checkbox-group {
        display: flex; align-items: center; gap: 8px;
    }
    .checkbox-group input { width: auto; }
    .browse-group { display: flex; gap: 8px; }
    .browse-group input { flex: 1; }
    button {
        padding: 6px 14px; border: none; border-radius: 2px;
        font-size: 13px; cursor: pointer;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .button-row { display: flex; gap: 10px; margin-top: 24px; }
    .sql-fields { display: ${!p || p.user ? 'block' : 'none'}; }
    .status {
        margin-top: 12px; padding: 8px 12px; border-radius: 4px;
        display: none; font-size: 12px;
    }
    .status.success { display: block; background: var(--vscode-testing-iconPassed); color: #fff; }
    .status.error { display: block; background: var(--vscode-testing-iconFailed); color: #fff; }
    .status.info { display: block; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
</style>
</head>
<body>
<h2>🔌 ${p ? 'Edit Connection' : 'New Connection'}</h2>

<div class="form-group">
    <label>Profile Name *</label>
    <input id="name" value="${p ? e(p.name) : ''}" placeholder="My Server" />
</div>
<div class="form-group">
    <label>Server *</label>
    <input id="server" value="${p ? e(p.server) : ''}" placeholder="localhost or 192.168.1.100" />
</div>
<div class="form-group">
    <label>Port</label>
    <input id="port" type="number" value="${p?.port || 1433}" />
</div>
<div class="form-group">
    <label>Authentication</label>
    <select id="authType" onchange="toggleAuth()">
        <option value="sql" ${p && !isWindows ? 'selected' : !p ? 'selected' : ''}>SQL Login</option>
        <option value="windows" ${p && isWindows ? 'selected' : ''}>Windows Authentication</option>
    </select>
</div>
<div class="sql-fields" id="sqlFields">
    <div class="form-group">
        <label>User Name *</label>
        <input id="user" value="${p?.user ? e(p.user) : ''}" placeholder="sa" />
    </div>
    <div class="form-group">
        <label>Password *</label>
        <input id="password" type="password" value="${p?.password ? e(p.password) : ''}" />
    </div>
</div>
<div class="form-group">
    <label>Database *</label>
    <input id="database" value="${p ? e(p.database) : ''}" placeholder="MyDatabase" />
</div>
<div class="form-group">
    <div class="checkbox-group">
        <input id="trustCert" type="checkbox" ${(!p || p.trustServerCertificate !== false) ? 'checked' : ''} />
        <label for="trustCert" style="margin:0;font-weight:normal">Trust Server Certificate</label>
    </div>
</div>
<div class="form-group">
    <label>Project Path</label>
    <div class="browse-group">
        <input id="projectPath" value="${p?.projectPath ? e(p.projectPath) : ''}" placeholder="Optional: SQL project folder" />
        <button class="btn-secondary" onclick="browse()">Browse...</button>
    </div>
</div>

<div class="button-row">
    <button class="btn-secondary" onclick="testConnection()">Test Connection</button>
    <button class="btn-secondary" onclick="save()">Save</button>
    <button onclick="saveAndConnect()">Save & Connect</button>
</div>

<div class="status" id="status"></div>

<script>
    const vscode = acquireVsCodeApi();
    let originalName = ${p ? `'${ConnectionFormProvider.escapeHtml(p.name).replace(/'/g, "\\'")}'` : 'null'};

    function toggleAuth() {
        const isSql = document.getElementById('authType').value === 'sql';
        document.getElementById('sqlFields').style.display = isSql ? 'block' : 'none';
    }

    function getProfile() {
        const isSql = document.getElementById('authType').value === 'sql';
        const profile = {
            name: document.getElementById('name').value.trim(),
            server: document.getElementById('server').value.trim(),
            port: parseInt(document.getElementById('port').value) || 1433,
            database: document.getElementById('database').value.trim(),
            trustServerCertificate: document.getElementById('trustCert').checked,
            projectPath: document.getElementById('projectPath').value.trim() || undefined,
        };
        if (isSql) {
            profile.user = document.getElementById('user').value.trim();
            profile.password = document.getElementById('password').value;
        }
        return profile;
    }

    function showStatus(msg, type) {
        const el = document.getElementById('status');
        el.textContent = msg;
        el.className = 'status ' + type;
    }

    function validate() {
        const p = getProfile();
        if (!p.name || !p.server || !p.database) {
            showStatus('Please fill in Profile Name, Server, and Database.', 'error');
            return null;
        }
        const isSql = document.getElementById('authType').value === 'sql';
        if (isSql && (!p.user || !p.password)) {
            showStatus('Please fill in User Name and Password for SQL Login.', 'error');
            return null;
        }
        return p;
    }

    function testConnection() {
        const profile = validate();
        if (!profile) return;
        showStatus('Testing connection...', 'info');
        vscode.postMessage({ cmd: 'test', profile });
    }

    function save() {
        const profile = validate();
        if (!profile) return;
        showStatus('Saving...', 'info');
        vscode.postMessage({ cmd: 'save', profile, originalName });
    }

    function saveAndConnect() {
        const profile = validate();
        if (!profile) return;
        showStatus('Saving and connecting...', 'info');
        vscode.postMessage({ cmd: 'saveAndConnect', profile, originalName });
    }

    function browse() {
        vscode.postMessage({ cmd: 'browse' });
    }

    window.addEventListener('message', (e) => {
        const msg = e.data;
        if (msg.cmd === 'testResult') {
            showStatus(
                msg.success ? '✓ Connection successful!' : '✗ ' + (msg.error || 'Connection failed'),
                msg.success ? 'success' : 'error'
            );
        } else if (msg.cmd === 'saved') {
            showStatus('✓ Saved successfully!', 'success');
        } else if (msg.cmd === 'browsed') {
            document.getElementById('projectPath').value = msg.path;
        } else if (msg.cmd === 'loadProfile') {
            // Fill form with profile data (for reuse of existing panel)
            if (msg.profile) {
                document.getElementById('name').value = msg.profile.name || '';
                document.getElementById('server').value = msg.profile.server || '';
                document.getElementById('port').value = msg.profile.port || 1433;
                document.getElementById('database').value = msg.profile.database || '';
                document.getElementById('user').value = msg.profile.user || '';
                document.getElementById('password').value = msg.profile.password || '';
                document.getElementById('trustCert').checked = msg.profile.trustServerCertificate !== false;
                document.getElementById('projectPath').value = msg.profile.projectPath || '';
                document.getElementById('authType').value = msg.profile.user ? 'sql' : 'windows';
                originalName = msg.profile.name || null; // Update originalName for edit mode
                toggleAuth();
            } else {
                // New connection mode — clear form
                document.getElementById('name').value = '';
                document.getElementById('server').value = '';
                document.getElementById('port').value = '1433';
                document.getElementById('database').value = '';
                document.getElementById('user').value = '';
                document.getElementById('password').value = '';
                document.getElementById('trustCert').checked = true;
                document.getElementById('projectPath').value = '';
                document.getElementById('authType').value = 'sql';
                originalName = null;
                toggleAuth();
            }
        }
    });
</script>
</body>
</html>`;
    }
}
```

- [ ] **Step 2: Wire ConnectionFormProvider into extension.ts**

Add import at top of `src/extension.ts`:
```typescript
import { ConnectionFormProvider } from './providers/connectionFormProvider';
```

Replace the placeholder `addConnection` and `editConnection` command handlers (from Task 5) with the real implementations:

```typescript
// Tree: Add Connection (opens webview form)
context.subscriptions.push(
    vscode.commands.registerCommand('tsql-intellisense.addConnection', () => {
        ConnectionFormProvider.show(context, connectionManager, treeProvider);
    })
);

// Tree: Edit Connection
context.subscriptions.push(
    vscode.commands.registerCommand('tsql-intellisense.editConnection', (item: any) => {
        if (!item?.profileName) { return; }
        const profiles = connectionManager.getSavedProfiles();
        const profile = profiles.find(p => p.name === item.profileName);
        if (profile) {
            ConnectionFormProvider.show(context, connectionManager, treeProvider, profile);
        }
    })
);
```

- [ ] **Step 3: Verify build succeeds**

Run: `npm run build`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/providers/connectionFormProvider.ts src/extension.ts
git commit -m "feat: add webview connection form (add/edit/test/browse)"
```

---

## Chunk 4: Final Build & Manual Testing

### Task 7: Full build and verification

**Files:** (no new files)

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: No errors, `dist/extension.js` produced

- [ ] **Step 2: Run existing tests**

Run: `npm test`
Expected: All 87 tests pass (no regressions)

- [ ] **Step 3: Manual test checklist (F5)**

Launch Extension Development Host and verify:

| # | Test | Expected |
|---|------|----------|
| 1 | Activity bar shows T-SQL Explorer icon | Database icon visible on left sidebar |
| 2 | Connections panel shows saved profiles | All profiles from settings.json listed |
| 3 | "+" button opens connection form | Webview tab opens with empty form |
| 4 | Fill form → Test Connection | Success/error message shown |
| 5 | Fill form → Save & Connect | Profile saved, tree refreshes, connection made |
| 6 | Connected profile shows folders | Tables, Views, SPs, Functions with counts |
| 7 | Expand Tables folder | Tables listed alphabetically |
| 8 | Expand a table | Columns shown with PK/FK icons and types |
| 9 | Right-click table → SELECT TOP 100 | Query results appear in bottom panel |
| 10 | Right-click SP → ALTER PROC | SP code fetched |
| 11 | Right-click connection → Edit | Form opens with pre-filled values |
| 12 | Right-click connection → Delete | Confirmation dialog, then removed |
| 13 | Double-click disconnected profile | Connects and expands |
| 14 | Project folder shown when projectPath set | Folder node with path visible |
| 15 | Right-click project → Open in Explorer | OS file explorer opens |
| 16 | Existing Command Palette commands still work | connect, disconnect, refreshSchema |

- [ ] **Step 4: Commit all remaining changes**

```bash
git add -A
git commit -m "feat: sidebar connection tree with object explorer and connection form"
```
