# DbManager Tree View Port to tsql-intellisense

**Date:** 2026-03-22
**Status:** Approved
**Approach:** A — Port DbManager code, integrate with tsql-intellisense infrastructure

## Summary

Port DbManager's rich connections tree view (deep hierarchy, custom SVG icons, context menus, Script As submenu) into tsql-intellisense, while preserving tsql-intellisense's per-database project path, color coding, object filtering, and existing script commands.

## Requirements

### Must Have
- Full DbManager hierarchy: Connection → Server Folders (Databases/Security/Server Objects) → Database → Schema → Tables/Views/Functions/Procedures/Triggers → Columns/Keys/Constraints/Indexes/Statistics/Parameters
- Custom SVG icons from DbManager (SqlServerConnected, SqlServerDisconnected, Database, DatabaseOffline, Schema, Table, View, Column, ColumnKey, Index, Function, Procedure, Trigger, Folder, icons8-folder)
- Context menus with DbManager's full set of actions
- Script As submenu (CREATE, ALTER, CREATE OR ALTER, DROP, DROP+CREATE, SELECT, INSERT, UPDATE, DELETE, EXECUTE)
- Security folder (Logins, Server Roles, Credentials, Audits, Server Audit Specifications)
- Server Objects folder (Endpoints, Linked Servers, Triggers)
- Function sub-categorization (Scalar-valued, Table-valued, Aggregate, System)

### Must Preserve from tsql-intellisense
- Per-database project path (ProjectFolderItem under Database node)
- Color coding in descriptions (charts.orange for tables, charts.blue for views, charts.purple for SPs, charts.yellow for functions, charts.green for project folder)
- Object filtering with filtered/total count display
- Existing script commands: alterProc, copyTableScript, openTableScript, selectTop100 (query upgraded to TOP 1000, command ID unchanged), insertSpParams, insertInsertTemplate
- Connection form (webview with two tabs, saved/recent connections sidebar)

## Architecture

### 1. Tree View — SQL Query Based (No SchemaCache dependency)

The tree view will use direct SQL queries for all node expansion, identical to DbManager's approach. This decouples the tree from SchemaCache entirely.

**Data source:** A new `TreeQueryService` wraps `ConnectionManager.executeQuery()` to provide tree-specific query execution. It handles:
- Database context switching (`USE [dbName]` before schema queries)
- Result set normalization (returns `rows[]` array like DbManager's QueryService)
- Error handling: all query failures return an `ErrorItem` node instead of throwing

For expanding nodes under a non-active connection, the service calls `ConnectionManager.connect()` first, then queries.

**Multi-connection note:** tsql-intellisense currently supports one active connection. The tree view works within this constraint — expanding a different connection's nodes triggers a reconnect. This is the same behavior as DbManager. Future multi-connection support can be added by upgrading ConnectionManager without changing the tree provider.

### 2. SchemaCache — IntelliSense Only, Per-Database Map

SchemaCache is exclusively for IntelliSense (completion, definition, rename). It is **not** used by the tree view.

**Triggering:**
1. A `.sql` file is opened or tab is switched to
2. The file's connection header comment is parsed to determine profile + database
3. If that database's cache doesn't exist yet, it is loaded

**Storage:** `Map<"profileName::dbName", SchemaCache>` — multiple databases can be cached simultaneously. Tab switching between files with different databases is instant (no reload).

### 3. Query File Connection Header

Each SQL file carries its connection info as a first-line comment:

```sql
-- Connection: ProfileName | Database: AdventureWorks | Project: C:\Projects\AdventureWorks
```

If no project path is configured for that database:
```sql
-- Connection: ProfileName | Database: AdventureWorks | Project: null
```

**Behavior:**
- **Tree "New Query":** Creates file with header auto-populated from the node's connection/database context. Project path comes from `ConnectionProfile.databaseProjects[dbName]`.
- **Connection change** (status bar, command, USE statement): Header is updated, old SchemaCache stays in map, new DB's cache is loaded if not present.
- **File opened:** Header is parsed → connection is established if needed → SchemaCache is loaded for IntelliSense.
- **Tab switch (`onDidChangeActiveTextEditor`):** Header is parsed → status bar updates → SchemaCache switches to the file's database (instant if already cached).

### 4. Node Model — Single Class (DatabaseTreeItem)

Replace the current multi-class model (`connectionTreeItems.ts` with ConnectionItem, DatabasesFolderItem, DatabaseItem, etc.) with a single `DatabaseTreeItem` class adapted from DbManager:

```typescript
// New file: src/models/DatabaseNode.ts

enum NodeType {
    Connection, ServerFolder, Database, Schema, Folder,
    Table, View, Column, Index, Function, Procedure, Trigger
}

enum ServerFolderType { Databases, Security, ServerObjects }

enum FolderType {
    Tables, Views, Functions, ScalarFunctions, TableValuedFunctions,
    AggregateFunctions, SystemFunctions, Procedures, Triggers,
    Columns, Keys, Constraints, Indexes, Statistics, Parameters
}

interface ColumnMetadata { Name, DataType, MaxLength, IsNullable, IsPrimaryKey }
interface IndexMetadata { Name, Type, IsUnique, IsPrimaryKey }

class DatabaseTreeItem extends vscode.TreeItem {
    constructor(
        Label, NodeType, ConnectionId, Collapsible,
        DatabaseName?, SchemaName?, FolderType?, ObjectName?,
        ColumnMetadata?, IndexMetadata?,
        // tsql-intellisense additions:
        profileName?, projectPath?
    )
}
```

### 5. IconManager

New file: `src/utils/IconManager.ts` — adapted from DbManager.

Maps NodeType + contextValue to SVG icon files in `resources/icons/`.

| NodeType | Condition | SVG Icon |
|----------|-----------|----------|
| Connection | Connected | SqlServerConnected.svg |
| Connection | Disconnected | icons8-sql-server.svg |
| Database | Online | Database.svg |
| Database | Offline | DatabaseOffline.svg |
| ServerFolder | — | icons8-folder.svg |
| Schema | — | Schema.svg |
| Table | — | Table.svg |
| View | — | View.svg |
| Column | IsPrimaryKey | ColumnKey.svg |
| Column | Regular | Column.svg |
| Index | — | Index.svg |
| Function | — | Function.svg |
| Procedure | — | Procedure.svg |
| Trigger | — | Trigger.svg |
| Folder | — | icons8-folder.svg |

**Hybrid icon strategy:** SVG icons for all node types. Color coding preserved in description text via ThemeColor (not on icons).

### 6. ConnectionTreeProvider — Rewritten

New provider based on DbManager's pattern with tsql-intellisense adaptations.

**Key methods (DbManager pattern):**

```
getChildren(element?) → dispatch by NodeType:
  undefined        → GetConnectionNodes()
  Connection       → GetServerFolders() [Databases, Security, Server Objects]
  ServerFolder     → GetServerFolderChildren() [dispatch by folder type]
  Database         → GetSchemaNodes() [+ ProjectFolderItem if configured]
  Schema           → GetSchemaFolders() [Tables, Views, Functions, Procedures, Triggers]
  Folder           → GetFolderChildren() [dispatch by FolderType]
  Table            → GetTableChildren() [Columns, Keys, Constraints, Triggers, Indexes, Statistics]
  View             → GetViewChildren() [Columns, Triggers, Indexes, Statistics]
  Procedure/Func   → GetRoutineChildren() [Parameters, Returns]
```

**Preserved from tsql-intellisense:**
- `setFilter(target, value)` / `getFilter()` — object filtering
- `fullRefresh()` — complete tree refresh
- ProjectFolderItem rendering under Database nodes

**Removed:**
- Registry system (reg/registry map) — fresh nodes on each getChildren call
- perConnectionCache / perDbCache — tree uses live SQL queries
- SchemaCache dependency
- `fireAllConnections()` — replaced by `fullRefresh()` since there is no registry to iterate

**Icon updates after connect/disconnect:** Call `Refresh()` (fires `onDidChangeTreeData` with `undefined`) which re-renders the entire tree. Connection nodes get their icon from `IconManager.GetIcon()` based on `contextValue` which is set in `GetConnectionNodes()` using `TreeQueryService.isConnected()`.

**`getParent()` implementation:** Required for `treeView.reveal()`. Since there is no registry, `getParent()` reconstructs parent nodes from the child's metadata:
- `DatabaseTreeItem` carries `ConnectionId`, `DatabaseName`, `SchemaName`, `FolderType`, `ObjectName`
- From any node, the parent can be reconstructed by creating a new `DatabaseTreeItem` with the appropriate subset of these fields
- Example: A Table node with `{ConnectionId, DatabaseName, SchemaName, ObjectName}` → parent is a Folder node with `{ConnectionId, DatabaseName, SchemaName, FolderType: Tables}`

**Error handling:** Every `getChildren` branch wraps SQL execution in try/catch. On failure, returns `[new ErrorItem(errorMessage)]` to display the error inline in the tree.

### 7. Filtering

**Database filter:** Applied in `GetDatabaseNodes()` — case-insensitive substring match on database name.

**Folder filter:** Applied via `ApplyFolderFilter()` in `GetTableNodes()`, `GetViewNodes()`, `GetProcedureNodes()`, `GetFunctionSubNodes()`, `GetDmlTriggerNodes()`. Filter key: `connectionId|databaseName|schemaName|folderType`.

**Display:** Filtered folders show `(filtered/total) 🔍 filterText` in description.

### 8. Context Menus & Commands

#### New Commands (from DbManager)
- `tsql-intellisense.Script.Create`
- `tsql-intellisense.Script.Alter`
- `tsql-intellisense.Script.CreateOrAlter`
- `tsql-intellisense.Script.Drop`
- `tsql-intellisense.Script.DropAndCreate`
- `tsql-intellisense.Script.Select`
- `tsql-intellisense.Script.Insert`
- `tsql-intellisense.Script.Update`
- `tsql-intellisense.Script.Delete`
- `tsql-intellisense.Script.Execute`
- `tsql-intellisense.RefreshDatabases`
- `tsql-intellisense.FilterDatabases`
- `tsql-intellisense.NewDatabase`
- `tsql-intellisense.RefreshDatabase`
- `tsql-intellisense.NewSchema`
- `tsql-intellisense.RefreshFolder`
- `tsql-intellisense.FilterFolder`
- `tsql-intellisense.NewTable`
- `tsql-intellisense.NewView`
- `tsql-intellisense.NewScalarFunction`
- `tsql-intellisense.NewTableValuedFunction`
- `tsql-intellisense.NewProcedure`
- `tsql-intellisense.NewTrigger`

#### Preserved Commands (from tsql-intellisense)
- `tsql-intellisense.selectTop100` — Tables/Views context menu (command ID kept as-is for backward compat, but query changed to TOP 1000 and title updated to "Select Top 1000")
- `tsql-intellisense.copyTableScript` — Tables context menu
- `tsql-intellisense.openTableScript` — Tables/Views/Functions context menu
- `tsql-intellisense.alterProc` — SP context menu
- `tsql-intellisense.insertSpParams` — SP context menu
- `tsql-intellisense.insertInsertTemplate` — IntelliSense integration (unchanged)

#### Script As Submenu
```json
"submenus": [{ "id": "tsql-intellisense.ScriptAs", "label": "Script As" }]
```

Groups:
- **1_create:** CREATE, ALTER, CREATE OR ALTER
- **2_drop:** DROP, DROP+CREATE
- **3_dml:** SELECT, INSERT, UPDATE, DELETE (Tables/Views only)
- **4_exec:** EXECUTE (Procedures/Functions only)

#### Context Value Map
| Node | contextValue |
|------|-------------|
| Connected connection | ConnectionConnected |
| Disconnected connection | ConnectionDisconnected |
| Online database | Database |
| Offline database | DatabaseOffline |
| Databases server folder | ServerFolderDatabases |
| Other server folders | ServerFolder |
| Tables folder | SchemaFolderTables |
| Views folder | SchemaFolderViews |
| Functions folder (parent) | SchemaFolderFunctions (Refresh/Filter inline, NO "New" button — "New" appears on sub-folders) |
| Procedures folder | SchemaFolderProcedures |
| Triggers folder | SchemaFolderTriggers |
| Scalar functions folder | FuncFolderSC |
| Table-valued functions folder | FuncFolderTV |
| Aggregate functions folder | FuncFolderAG |
| System functions folder | FuncFolderSY |
| Security sub-folders | SecurityLogins, SecurityServerRoles, SecurityCredentials, SecurityAudits, SecurityAuditSpecs |
| Server object sub-folders | ServerEndpoints, ServerLinkedServers, ServerTriggers |
| Table node | Table |
| View node | View |
| Procedure node | Procedure |
| Function node | Function |
| Trigger node | Trigger |

### 9. ScriptGenerator Service

Extract script generation logic from Extension.ts into a dedicated service: `src/services/ScriptGenerator.ts`.

**Methods:**
- `generateCreateScript(node)` — Tables: reconstruct from INFORMATION_SCHEMA. Others: OBJECT_DEFINITION().
- `generateAlterScript(node)` — Tables: ALTER TABLE ADD template. Others: replace CREATE with ALTER.
- `generateCreateOrAlterScript(node)` — Replace CREATE with CREATE OR ALTER.
- `generateDropScript(node)` — DROP [TYPE] [qualified_name]
- `generateDropAndCreateScript(node)` — DROP IF EXISTS + CREATE
- `generateSelectScript(node)` — SELECT with all columns
- `generateInsertScript(node)` — INSERT with non-identity columns, default values, comments
- `generateUpdateScript(node)` — UPDATE with SET clauses and WHERE placeholder
- `generateDeleteScript(node)` — DELETE with WHERE placeholder
- `generateExecuteScript(node)` — EXEC for SPs, SELECT for Functions with parameters

All generated scripts include the connection header comment and are opened in a new SQL editor tab.

### 10. SVG Icons

Copy 14 SVG icons from `DbManager/Resources/Icons/` to `tsql-intellisense/resources/icons/`:

SqlServerConnected.svg, icons8-sql-server.svg (disconnected icon), Database.svg, DatabaseOffline.svg, Schema.svg, Table.svg, View.svg, Column.svg, ColumnKey.svg, Index.svg, Function.svg, Procedure.svg, Trigger.svg, icons8-folder.svg

Note: DbManager's code uses `icons8-sql-server.svg` for disconnected connections (not `SqlServerDisconnected.svg`). `Folder.svg`, `SqlServer.svg`, and `SqlServerDisconnected.svg` exist in DbManager but are not referenced by code — they are not copied.

### 11. Files to Create/Modify

**New files:**
- `src/models/DatabaseNode.ts` — Node model, enums, metadata interfaces
- `src/utils/IconManager.ts` — Icon resolution
- `src/services/TreeQueryService.ts` — SQL query wrapper for tree view
- `src/services/ScriptGenerator.ts` — Script generation service
- `resources/icons/*.svg` — 14 SVG icon files

**Modified files:**
- `src/providers/connectionTreeProvider.ts` — Complete rewrite
- `src/providers/connectionTreeItems.ts` — Remove (replaced by DatabaseNode.ts)
- `src/cache/schemaCache.ts` — Refactor to support per-database Map
- `src/extension.ts` — New command registrations, SchemaCache map, tab switch handler, connection header parsing
- `package.json` — New commands, submenu, context menus, icons

### 12. TreeQueryService Design

`TreeQueryService` is a **thin wrapper** around the existing `ConnectionManager` (single-connection model). It is NOT a connection pool or a port of DbManager's `DesktopQueryService`.

```typescript
// src/services/TreeQueryService.ts
class TreeQueryService {
    constructor(private connectionManager: ConnectionManager) {}

    // Wraps connectionManager.executeQuery with database context switching
    async execute(sql: string, databaseName?: string): Promise<{ rows: any[] }> {
        if (databaseName) {
            // Switch context: USE [dbName] before the actual query
            await this.connectionManager.executeQuery(`USE [${escapeSql(databaseName)}]`);
        }
        const result = await this.connectionManager.executeQuery(sql);
        return { rows: result.rows };
    }

    isConnected(): boolean {
        return this.connectionManager.isConnected;
    }

    async connect(profileName: string): Promise<void> {
        const profile = this.connectionManager.getSavedProfiles()
            .find(p => p.name === profileName);
        if (profile) await this.connectionManager.connect(profile);
    }
}
```

When the tree expands a node under a different connection, `connect()` is called first (switches the active connection), then `execute()` runs queries. This means only one connection is active at a time — same as DbManager's behavior when expanding a disconnected server.

### 13. Existing Commands Migration

**Retained with updated `when` clauses (contextValue changes):**
- `tsql-intellisense.treeConnect` — `when` updated from `viewItem == connection.disconnected` to `viewItem == ConnectionDisconnected`
- `tsql-intellisense.newQueryFromTree` — `when` updated from `viewItem == connection.connected || viewItem == database.connected` to `viewItem == ConnectionConnected || viewItem == Database`
- `tsql-intellisense.loadDatabaseSchema` — `when` updated from `viewItem == database.connected || viewItem == database` to `viewItem == Database`
- `tsql-intellisense.openInExplorer` — `when` updated from `viewItem == projectFolder` to `viewItem == ProjectFolder` (new contextValue for ProjectFolderItem)
- `tsql-intellisense.openProjectFile` — `when` clauses updated to new contextValues
- `tsql-intellisense.selectTop100` — `when` updated from `viewItem == table` to `viewItem == Table || viewItem == View`

**Removed (replaced by new commands):**
- `tsql-intellisense.filterItems` → replaced by `tsql-intellisense.FilterDatabases` + `tsql-intellisense.FilterFolder`
- `tsql-intellisense.clearFilter` → integrated into FilterDatabases/FilterFolder (empty string clears)
- `tsql-intellisense.switchDatabase` → no longer needed (database switching via tree expand + USE statement)

**Retained unchanged:**
- `tsql-intellisense.connect`, `tsql-intellisense.disconnect` (command palette / status bar)
- `tsql-intellisense.addConnection`, `tsql-intellisense.editConnection`, `tsql-intellisense.deleteConnection`
- `tsql-intellisense.alterProc`, `tsql-intellisense.copyTableScript`, `tsql-intellisense.openTableScript`
- `tsql-intellisense.insertSpParams`, `tsql-intellisense.insertInsertTemplate`
- All query execution, formatting, and IntelliSense commands

### 14. Naming Conventions

All new code follows tsql-intellisense's existing camelCase TypeScript convention (not DbManager's PascalCase). Enum values remain PascalCase as is standard in TypeScript.

### 15. Existing Command Compatibility

- `tsql-intellisense.loadDatabaseSchema` — Retained for IntelliSense purposes. Triggers SchemaCache loading for the current file's database. Not used by tree view.
- `tsql-intellisense.active` context key — New Script As commands and tree context menus are gated behind this key where appropriate (e.g., Script As requires an active connection).
- `ConnectionProfile.projectPath` (legacy single-DB path) — Deprecated in favor of `databaseProjects` map. If `projectPath` is set but `databaseProjects` is empty, the legacy path is used as fallback for the profile's default database.

### 16. Migration Notes

- Existing tsql-intellisense users' saved connections (`tsql-intellisense.connections` setting) remain unchanged — ConnectionManager is not modified.
- The tree view ID (`tsqlConnections`) stays the same to avoid breaking existing settings.
- Existing keybindings are preserved.
