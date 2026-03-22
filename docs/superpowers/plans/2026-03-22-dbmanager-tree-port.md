# DbManager Tree View Port — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port DbManager's rich connections tree view (deep hierarchy, SVG icons, context menus, Script As) into tsql-intellisense while preserving existing features.

**Architecture:** Replace tsql-intellisense's flat tree with DbManager's SQL-query-based deep hierarchy. New TreeQueryService wraps ConnectionManager for tree queries. SchemaCache decoupled from tree, refactored to per-database Map for IntelliSense only.

**Tech Stack:** TypeScript, VS Code Extension API, tedious (SQL Server), SVG icons

**Spec:** `docs/superpowers/specs/2026-03-22-dbmanager-tree-port-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/models/DatabaseNode.ts` | DatabaseTreeItem class, NodeType/ServerFolderType/FolderType enums, ColumnMetadata/IndexMetadata interfaces |
| `src/utils/IconManager.ts` | Maps NodeType + contextValue → SVG icon URI |
| `src/services/TreeQueryService.ts` | Thin wrapper around ConnectionManager.executeQuery() with USE [db] switching |
| `src/services/ScriptGenerator.ts` | 10 script generation methods (CREATE, ALTER, DROP, SELECT, INSERT, UPDATE, DELETE, EXECUTE etc.) |
| `src/utils/connectionHeader.ts` | Parse/write `-- Connection: X \| Database: Y \| Project: Z` header comments |
| `resources/icons/*.svg` | 14 SVG icon files copied from DbManager |

### Modified Files
| File | Changes |
|------|---------|
| `src/providers/connectionTreeProvider.ts` | Complete rewrite — DbManager-style SQL-query-based provider |
| `src/providers/connectionTreeItems.ts` | Delete (replaced by DatabaseNode.ts) |
| `src/cache/schemaCache.ts` | Refactor to support per-database Map storage |
| `src/extension.ts` | New commands, SchemaCache map, connection header handlers, tree wiring |
| `src/extension.web.ts` | Register stub commands for new tree commands |
| `package.json` | New commands, submenu, context menus, updated when clauses |
| `package.nls.json` | New command display names |
| `package.nls.tr.json` | Turkish translations for new commands |

---

## Chunk 1: Foundation (Node Model + Icons + TreeQueryService)

### Task 1: Copy SVG Icons

**Files:**
- Create: `resources/icons/SqlServerConnected.svg`
- Create: `resources/icons/icons8-sql-server.svg`
- Create: `resources/icons/Database.svg`
- Create: `resources/icons/DatabaseOffline.svg`
- Create: `resources/icons/Schema.svg`
- Create: `resources/icons/Table.svg`
- Create: `resources/icons/View.svg`
- Create: `resources/icons/Column.svg`
- Create: `resources/icons/ColumnKey.svg`
- Create: `resources/icons/Index.svg`
- Create: `resources/icons/Function.svg`
- Create: `resources/icons/Procedure.svg`
- Create: `resources/icons/Trigger.svg`
- Create: `resources/icons/icons8-folder.svg`

- [ ] **Step 1: Copy all 14 SVG files from DbManager**

```bash
cp /c/Users/ÖmerBülbül/source/repos/DbManager/Resources/Icons/SqlServerConnected.svg resources/icons/
cp /c/Users/ÖmerBülbül/source/repos/DbManager/Resources/Icons/icons8-sql-server.svg resources/icons/
cp /c/Users/ÖmerBülbül/source/repos/DbManager/Resources/Icons/Database.svg resources/icons/
cp /c/Users/ÖmerBülbül/source/repos/DbManager/Resources/Icons/DatabaseOffline.svg resources/icons/
cp /c/Users/ÖmerBülbül/source/repos/DbManager/Resources/Icons/Schema.svg resources/icons/
cp /c/Users/ÖmerBülbül/source/repos/DbManager/Resources/Icons/Table.svg resources/icons/
cp /c/Users/ÖmerBülbül/source/repos/DbManager/Resources/Icons/View.svg resources/icons/
cp /c/Users/ÖmerBülbül/source/repos/DbManager/Resources/Icons/Column.svg resources/icons/
cp /c/Users/ÖmerBülbül/source/repos/DbManager/Resources/Icons/ColumnKey.svg resources/icons/
cp /c/Users/ÖmerBülbül/source/repos/DbManager/Resources/Icons/Index.svg resources/icons/
cp /c/Users/ÖmerBülbül/source/repos/DbManager/Resources/Icons/Function.svg resources/icons/
cp /c/Users/ÖmerBülbül/source/repos/DbManager/Resources/Icons/Procedure.svg resources/icons/
cp /c/Users/ÖmerBülbül/source/repos/DbManager/Resources/Icons/Trigger.svg resources/icons/
cp /c/Users/ÖmerBülbül/source/repos/DbManager/Resources/Icons/icons8-folder.svg resources/icons/
```

- [ ] **Step 2: Verify icons exist and clean up unused dirs**

Note: The existing `resources/icons/dark/` and `resources/icons/light/` directories are empty and unused. The new SVGs go directly into `resources/icons/` and are used for both light and dark themes (same SVG file for both).

```bash
ls -la resources/icons/*.svg | wc -l
```
Expected: 14 (plus the existing `database.svg` = 15 total files)

- [ ] **Step 3: Commit**

```bash
git add resources/icons/
git commit -m "feat: add SVG icons from DbManager for tree view"
```

---

### Task 2: Create DatabaseNode Model

**Files:**
- Create: `src/models/DatabaseNode.ts`

- [ ] **Step 1: Create the DatabaseNode model**

Port DbManager's `Src/Models/DatabaseNode.ts` with camelCase naming convention. The model includes:
- `NodeType` enum: Connection, ServerFolder, Database, Schema, Folder, Table, View, Column, Index, Function, Procedure, Trigger
- `ServerFolderType` enum: Databases, Security, ServerObjects
- `FolderType` enum: Tables, Views, Functions, ScalarFunctions, TableValuedFunctions, AggregateFunctions, SystemFunctions, Procedures, Triggers, Columns, Keys, Constraints, Indexes, Statistics, Parameters
- `ColumnMetadata` interface: name, dataType, maxLength, isNullable, isPrimaryKey
- `IndexMetadata` interface: name, type, isUnique, isPrimaryKey
- `DatabaseTreeItem` class extending `vscode.TreeItem` with constructor params:
  - `label, nodeType, connectionId, collapsible, databaseName?, schemaName?, folderType?, objectName?, columnMetadata?, indexMetadata?, profileName?, projectPath?`
  - `getContextValue()` — returns contextValue string based on nodeType (default "ConnectionDisconnected" for Connection, nodeType string for others)
  - `getTooltip()` — rich tooltip for Column (type + nullable + PK) and Index (unique + type + primary) nodes
- `ErrorItem` class extending `vscode.TreeItem` — simple error/info display node

Reference: `c:\Users\ÖmerBülbül\source\repos\DbManager\Src\Models\DatabaseNode.ts`

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit src/models/DatabaseNode.ts
```
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/models/DatabaseNode.ts
git commit -m "feat: add DatabaseNode model with enums and tree item class"
```

---

### Task 3: Create IconManager

**Files:**
- Create: `src/utils/IconManager.ts`

- [ ] **Step 1: Create the IconManager**

Port DbManager's `Src/Utils/IconManager.ts` with camelCase convention. The class:
- Constructor takes `extensionUri: vscode.Uri`, builds `iconsUri` pointing to `resources/icons`
- `getIcon(item: DatabaseTreeItem)` returns `{ light: Uri, dark: Uri }` or `undefined`
- `getIconName(item: DatabaseTreeItem)` — private method, switch on `item.nodeType`:
  - Connection: "SqlServerConnected" if contextValue is "ConnectionConnected", else "icons8-sql-server"
  - ServerFolder: "icons8-folder"
  - Database: "DatabaseOffline" if contextValue is "DatabaseOffline", else "Database"
  - Schema: "Schema"
  - Table: "Table"
  - View: "View"
  - Column: "ColumnKey" if columnMetadata?.isPrimaryKey, else "Column"
  - Index: "Index"
  - Function: "Function"
  - Procedure: "Procedure"
  - Trigger: "Trigger"
  - Folder: "icons8-folder"

Reference: `c:\Users\ÖmerBülbül\source\repos\DbManager\Src\Utils\IconManager.ts`

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/utils/IconManager.ts
git commit -m "feat: add IconManager for SVG icon resolution"
```

---

### Task 4: Create TreeQueryService

**Files:**
- Create: `src/services/TreeQueryService.ts`

- [ ] **Step 1: Create the TreeQueryService**

Thin wrapper around ConnectionManager. **IMPORTANT:** First check `connectionManager.executeQuery()` return type in `src/connection/connectionManager.ts`. It returns `Promise<QueryResult>` where `QueryResult = { rows: Record<string, any>[], columns: string[] }`. The wrapper normalizes this for tree use.

```typescript
import { ConnectionManager, ConnectionProfile } from '../connection/connectionManager';

function escapeSql(value: string): string {
    return value.replace(/'/g, "''");
}

export class TreeQueryService {
    constructor(private connectionManager: ConnectionManager) {}

    async execute(sql: string, databaseName?: string): Promise<{ rows: Record<string, any>[] }> {
        if (databaseName) {
            const safe = databaseName.replace(/\]/g, ']]');
            await this.connectionManager.executeQuery(`USE [${safe}]`);
        }
        const result = await this.connectionManager.executeQuery(sql);
        return { rows: result.rows };
    }

    isConnected(): boolean {
        return this.connectionManager.isConnected;
    }

    get currentProfileName(): string | undefined {
        return this.connectionManager.currentProfile?.name;
    }

    async connect(profileName: string): Promise<void> {
        const profile = this.connectionManager.getSavedProfiles()
            .find(p => p.name === profileName);
        if (!profile) { throw new Error(`Profile "${profileName}" not found`); }
        await this.connectionManager.connect(profile);
    }

    getProfiles(): ConnectionProfile[] {
        return this.connectionManager.getSavedProfiles();
    }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/services/TreeQueryService.ts
git commit -m "feat: add TreeQueryService wrapper for tree SQL queries"
```

---

### Task 5: Create Connection Header Utility

**Files:**
- Create: `src/utils/connectionHeader.ts`

- [ ] **Step 1: Create the connection header parser/writer**

```typescript
export interface ConnectionHeader {
    profileName: string;
    database: string;
    project: string | null;
}

const HEADER_REGEX = /^--\s*Connection:\s*(.+?)\s*\|\s*Database:\s*(.+?)\s*\|\s*Project:\s*(.+?)\s*$/;

export function parseConnectionHeader(firstLine: string): ConnectionHeader | null {
    const match = firstLine.match(HEADER_REGEX);
    if (!match) { return null; }
    return {
        profileName: match[1].trim(),
        database: match[2].trim(),
        project: match[3].trim() === 'null' ? null : match[3].trim(),
    };
}

export function buildConnectionHeader(profileName: string, database: string, project: string | null): string {
    return `-- Connection: ${profileName} | Database: ${database} | Project: ${project ?? 'null'}`;
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/utils/connectionHeader.ts
git commit -m "feat: add connection header parser/writer for SQL files"
```

---

## Chunk 2: ConnectionTreeProvider Rewrite

### Task 6: Rewrite ConnectionTreeProvider — Core Structure

**Files:**
- Rewrite: `src/providers/connectionTreeProvider.ts`

- [ ] **Step 1: Create the new provider skeleton**

Rewrite `connectionTreeProvider.ts` completely. The new provider:
- Imports `DatabaseTreeItem`, `NodeType`, `FolderType`, `ServerFolderType`, `ErrorItem` from `../models/DatabaseNode`
- Imports `IconManager` from `../utils/IconManager`
- Imports `TreeQueryService` from `../services/TreeQueryService`
- Constructor takes `(treeQueryService: TreeQueryService, extensionUri: vscode.Uri)`
- Creates `IconManager` internally
- Has `_onDidChangeTreeData` EventEmitter
- Has `databaseFilter: string` and `folderFilters: Map<string, string>`
- `getTreeItem(element)` sets `element.iconPath = this.iconManager.getIcon(element)` then returns element
- `refresh(node?)` fires the EventEmitter
- `fullRefresh()` fires with undefined
- `setDatabaseFilter(filter)` / `getDatabaseFilter()`
- `setFolderFilter(element, filter)` / `getFolderFilter(element)`
- `applyFolderFilter(rows, nameField, element)` — case-insensitive substring match

Reference: `c:\Users\ÖmerBülbül\source\repos\DbManager\Src\Providers\ConnectionTreeProvider.ts` lines 1-280

- [ ] **Step 2: Implement getChildren dispatcher**

```typescript
async getChildren(element?: DatabaseTreeItem): Promise<(DatabaseTreeItem | ErrorItem)[]> {
    if (!element) { return this.getConnectionNodes(); }
    try {
        switch (element.nodeType) {
            case NodeType.Connection:
                // Auto-connect if not connected (do NOT call fullRefresh here — it causes infinite loop)
                if (this.treeQueryService.currentProfileName !== element.profileName) {
                    await this.treeQueryService.connect(element.profileName!);
                    // Update this node's contextValue to Connected, icon will refresh on next getTreeItem call
                    element.contextValue = 'ConnectionConnected';
                }
                return this.getServerFolders(element);
            case NodeType.ServerFolder:
                return this.getServerFolderChildren(element);
            case NodeType.Database:
                return this.getDatabaseChildren(element);
            case NodeType.Schema:
                return this.getSchemaFolders(element);
            case NodeType.Folder:
                return this.getFolderChildren(element);
            case NodeType.Table:
                return this.getTableChildren(element);
            case NodeType.View:
                return this.getViewChildren(element);
            case NodeType.Procedure:
            case NodeType.Function:
                return this.getRoutineChildren(element);
            default:
                return [];
        }
    } catch (err: any) {
        return [new ErrorItem(err.message)];
    }
}
```

- [ ] **Step 3: Implement getParent**

Reconstruct parent from child's metadata fields:
- ConnectionItem → undefined
- ServerFolder → Connection node (from profileName)
- Database → ServerFolder "Databases" node
- Schema → Database node
- Folder (SchemaFolder) → Schema node
- Folder (table sub-folders) → Table/View node
- Table/View/Procedure/Function/Trigger → parent Folder node
- Column/Index leaf → parent Folder (Columns/Indexes) node

Reference: the metadata fields on DatabaseTreeItem (connectionId, databaseName, schemaName, folderType, objectName, profileName)

- [ ] **Step 4: Verify it compiles (may have unresolved method errors — that's OK)**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
git add src/providers/connectionTreeProvider.ts
git commit -m "feat: rewrite ConnectionTreeProvider core structure"
```

---

### Task 7: Implement Connection & Server Folder Nodes

**Files:**
- Modify: `src/providers/connectionTreeProvider.ts`

- [ ] **Step 1: Implement getConnectionNodes()**

Load profiles from TreeQueryService, create DatabaseTreeItem with NodeType.Connection for each. Set contextValue to "ConnectionConnected" or "ConnectionDisconnected" based on `treeQueryService.currentProfileName`. Set description to "SQL Server".

Reference: DbManager `ConnectionTreeProvider.ts` lines 79-93

- [ ] **Step 2: Implement getServerFolders()**

Return 3 server folder nodes: Databases, Security, Server Objects. Set contextValue "ServerFolderDatabases" for Databases, "ServerFolder" for others.

Reference: DbManager lines 95-106

- [ ] **Step 3: Implement getServerFolderChildren() dispatcher**

Switch on element.label: Databases → getDatabaseNodes(), Security → getSecurityChildren(), ServerObjects → getServerObjectsChildren().

Reference: DbManager lines 108-119

- [ ] **Step 4: Implement getSecurityChildren()**

Execute 5 SQL queries for Logins, Server Roles, Credentials, Audits, Server Audit Specifications. Create folder nodes with contextValues: SecurityLogins, SecurityServerRoles, SecurityCredentials, SecurityAudits, SecurityAuditSpecs.

SQL queries:
- Logins: `SELECT [name], [type_desc], [is_disabled] FROM sys.server_principals WHERE [type] IN ('S','U','G') ORDER BY [name]`
- Server Roles: `SELECT [name] FROM sys.server_principals WHERE [type] = 'R' ORDER BY [name]`
- Credentials: `SELECT [name] FROM sys.credentials ORDER BY [name]`
- Audits: `SELECT [name] FROM sys.server_audits ORDER BY [name]`
- Audit Specs: `SELECT [name] FROM sys.server_audit_specifications ORDER BY [name]`

Reference: DbManager lines 121-198

- [ ] **Step 5: Implement getServerObjectsChildren()**

Execute 3 SQL queries for Endpoints, Linked Servers, Server Triggers. Create folder nodes with contextValues: ServerEndpoints, ServerLinkedServers, ServerTriggers.

SQL queries:
- Endpoints: `SELECT [name] FROM sys.endpoints ORDER BY [name]`
- Linked Servers: `SELECT [name] FROM sys.servers WHERE is_linked = 1 ORDER BY [name]`
- Server Triggers: `SELECT [name] FROM sys.server_triggers ORDER BY [name]`

Reference: DbManager lines 200-247

- [ ] **Step 6: Implement getServerSubFolderItems()**

When expanding Security/ServerObjects sub-folders (detected by contextValue starting with "Security" or "Server"), dispatch SQL by contextValue and return leaf nodes (NodeType.Folder, collapsible: None):

| contextValue | SQL |
|-------------|-----|
| SecurityLogins | `SELECT [name], [type_desc], [is_disabled] FROM sys.server_principals WHERE [type] IN ('S','U','G') ORDER BY [name]` — disabled logins show `(disabled)` suffix |
| SecurityServerRoles | `SELECT [name] FROM sys.server_principals WHERE [type] = 'R' ORDER BY [name]` |
| SecurityCredentials | `SELECT [name] FROM sys.credentials ORDER BY [name]` |
| SecurityAudits | `SELECT [name] FROM sys.server_audits ORDER BY [name]` |
| SecurityAuditSpecs | `SELECT [name] FROM sys.server_audit_specifications ORDER BY [name]` |
| ServerEndpoints | `SELECT [name] FROM sys.endpoints ORDER BY [name]` |
| ServerLinkedServers | `SELECT [name] FROM sys.servers WHERE is_linked = 1 ORDER BY [name]` |
| ServerTriggers | `SELECT [name] FROM sys.server_triggers ORDER BY [name]` |

Reference: DbManager lines 429-472

- [ ] **Step 7: Commit**

```bash
git add src/providers/connectionTreeProvider.ts
git commit -m "feat: implement connection, server folders, security, and server objects nodes"
```

---

### Task 8: Implement Database & Schema Nodes

**Files:**
- Modify: `src/providers/connectionTreeProvider.ts`

- [ ] **Step 1: Implement getDatabaseNodes()**

SQL: `SELECT [name], [state], [state_desc] FROM sys.databases ORDER BY [name]`
Apply database filter. Create Database nodes — online databases get Collapsed state, offline get None state + contextValue "DatabaseOffline" + description with state_desc.

Reference: DbManager lines 281-308

- [ ] **Step 2: Implement getDatabaseChildren()**

For the Database node, return:
1. ProjectFolderItem if project path exists for this DB
2. Schema nodes from getSchemaNodes()

**Project path resolution logic:**
```typescript
function getProjectPath(profileName: string, dbName: string): string | null {
    const profile = treeQueryService.getProfiles().find(p => p.name === profileName);
    if (!profile) return null;
    // 1. Check databaseProjects map (case-insensitive)
    if (profile.databaseProjects) {
        const path = profile.databaseProjects[dbName] || profile.databaseProjects[dbName.toLowerCase()];
        if (path) return path;
    }
    // 2. Fallback: legacy projectPath for the profile's default database only
    if (profile.projectPath && profile.database.toLowerCase() === dbName.toLowerCase()) {
        return profile.projectPath;
    }
    return null;
}
```

ProjectFolderItem: create a DatabaseTreeItem with NodeType.Folder, label "Project: {path}", contextValue "ProjectFolder", collapsible None, projectPath set. Use ThemeIcon('folder-library', charts.green) for this node's icon (special case in IconManager — if contextValue is "ProjectFolder", return ThemeIcon instead of SVG).

- [ ] **Step 3: Implement getSchemaNodes()**

SQL (run with USE [databaseName]):
```sql
SELECT s.[name] AS SchemaName, COUNT(*) AS ObjectCount
FROM sys.objects o
INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
WHERE o.[type] IN ('U','V','P','FN','IF','TF','TR') AND o.is_ms_shipped = 0
GROUP BY s.[name]
ORDER BY s.[name]
```

Create Schema nodes with description showing object count.

Reference: DbManager lines 310-335

- [ ] **Step 4: Implement getSchemaFolders()**

SQL (run with USE [databaseName]):
```sql
SELECT
    (SELECT COUNT(*) FROM [INFORMATION_SCHEMA].[TABLES]
     WHERE [TABLE_SCHEMA] = '{schemaName}' AND [TABLE_TYPE] = 'BASE TABLE') AS TableCount,
    (SELECT COUNT(*) FROM [INFORMATION_SCHEMA].[TABLES]
     WHERE [TABLE_SCHEMA] = '{schemaName}' AND [TABLE_TYPE] = 'VIEW') AS ViewCount,
    (SELECT COUNT(*) FROM [INFORMATION_SCHEMA].[ROUTINES]
     WHERE [ROUTINE_SCHEMA] = '{schemaName}' AND [ROUTINE_TYPE] = 'FUNCTION') AS FunctionCount,
    (SELECT COUNT(*) FROM [INFORMATION_SCHEMA].[ROUTINES]
     WHERE [ROUTINE_SCHEMA] = '{schemaName}' AND [ROUTINE_TYPE] = 'PROCEDURE') AS ProcedureCount,
    (SELECT COUNT(*) FROM sys.triggers t
     INNER JOIN sys.objects o ON t.parent_id = o.object_id
     INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
     WHERE s.[name] = '{schemaName}' AND t.parent_class = 1) AS TriggerCount
```

Create folder nodes only for non-zero counts. Each folder: NodeType.Folder, description `(count)`. Set contextValues: SchemaFolderTables, SchemaFolderViews, SchemaFolderFunctions, SchemaFolderProcedures, SchemaFolderTriggers.

Reference: DbManager lines 337-382

- [ ] **Step 5: Commit**

```bash
git add src/providers/connectionTreeProvider.ts
git commit -m "feat: implement database, schema, and schema folder nodes"
```

---

### Task 9: Implement Object Nodes (Tables, Views, Functions, Procedures, Triggers)

**Files:**
- Modify: `src/providers/connectionTreeProvider.ts`

- [ ] **Step 1: Implement getFolderChildren() dispatcher**

Switch on element.folderType: Tables, Views, Functions, Procedures, Triggers, plus function sub-types (ScalarFunctions, TableValuedFunctions, AggregateFunctions, SystemFunctions), plus table sub-folders (Columns, Keys, Constraints, Indexes, Statistics, Parameters). Also handle Security/ServerObjects sub-folders via contextValue check.

Reference: DbManager lines 384-427

- [ ] **Step 2: Implement getTableNodes()**

SQL: Query INFORMATION_SCHEMA.TABLES with column count. Apply folder filter. Create Table nodes with description showing column count.

Reference: DbManager lines 474-500

- [ ] **Step 3: Implement getViewNodes()**

SQL: Query INFORMATION_SCHEMA.TABLES for VIEWs. Apply folder filter. Create View nodes.

Reference: DbManager lines 502-523

- [ ] **Step 4: Implement getFunctionNodes()**

Return 4 sub-folders: Table-valued, Scalar, Aggregate, System functions with counts. Set contextValues: FuncFolderTV, FuncFolderSC, FuncFolderAG, FuncFolderSY.

Reference: DbManager lines 525-567

- [ ] **Step 5: Implement getFunctionSubNodes()**

Query sys.objects with type filters per function sub-type. Apply folder filter.

Reference: DbManager lines 569-611

- [ ] **Step 6: Implement getProcedureNodes()**

SQL: Query INFORMATION_SCHEMA.ROUTINES for PROCEDUREs. Apply folder filter.

Reference: DbManager lines 613-634

- [ ] **Step 7: Implement getDmlTriggerNodes()**

SQL: Query sys.triggers joined with sys.objects and sys.schemas. Apply folder filter.

Reference: DbManager lines 636-658

- [ ] **Step 8: Commit**

```bash
git add src/providers/connectionTreeProvider.ts
git commit -m "feat: implement table, view, function, procedure, and trigger nodes"
```

---

### Task 10: Implement Leaf Nodes (Columns, Keys, Constraints, Indexes, Statistics, Parameters)

**Files:**
- Modify: `src/providers/connectionTreeProvider.ts`

- [ ] **Step 1: Implement getTableChildren()**

Count query for Columns, Keys, Constraints, Triggers, Indexes, Statistics under a table. Create sub-folder nodes.

Reference: DbManager lines 660-721

- [ ] **Step 2: Implement getViewChildren()**

Count query for Columns, Triggers, Indexes, Statistics under a view. Create sub-folder nodes.

Reference: DbManager lines 723-766

- [ ] **Step 3: Implement getColumnNodes()**

SQL: Query INFORMATION_SCHEMA.COLUMNS with PK detection via TABLE_CONSTRAINTS/KEY_COLUMN_USAGE. Create Column nodes with ColumnMetadata. PK columns get "🔑 " prefix.

Reference: DbManager lines 814-862

- [ ] **Step 4: Implement getIndexNodes()**

SQL: Query sys.indexes. Create Index nodes with IndexMetadata. Show "(PRIMARY)" or "(UNIQUE)" suffix.

Reference: DbManager lines 864-903

- [ ] **Step 5: Implement getKeyNodes()**

SQL: Query sys.key_constraints UNION sys.foreign_keys. Show PK/UQ/FK type labels.

Reference: DbManager lines 905-933

- [ ] **Step 6: Implement getConstraintNodes()**

SQL: Query sys.check_constraints UNION sys.default_constraints. Show CK/DF type labels with definition tooltip.

Reference: DbManager lines 935-964

- [ ] **Step 7: Implement getStatisticsNodes()**

SQL: Query sys.stats. Show "(Auto)" for auto-created stats.

Reference: DbManager lines 966-988

- [ ] **Step 8: Implement getRoutineChildren() and getParameterNodes()**

For Procedure/Function: count parameters, create Parameters folder. For functions, show return type.
Parameters SQL: Query INFORMATION_SCHEMA.PARAMETERS with data type and mode.

Reference: DbManager lines 768-812, 990-1021

- [ ] **Step 9: Commit**

```bash
git add src/providers/connectionTreeProvider.ts
git commit -m "feat: implement column, index, key, constraint, statistics, and parameter leaf nodes"
```

---

## Chunk 3: package.json + Commands + Context Menus

### Task 11: Update package.json — New Commands

**Files:**
- Modify: `package.json`
- Modify: `package.nls.json`
- Modify: `package.nls.tr.json`

- [ ] **Step 1: Add Script As commands to package.json**

Add 10 Script commands to contributes.commands:
- `tsql-intellisense.Script.Create` — "CREATE To"
- `tsql-intellisense.Script.Alter` — "ALTER To"
- `tsql-intellisense.Script.CreateOrAlter` — "CREATE OR ALTER To"
- `tsql-intellisense.Script.Drop` — "DROP To"
- `tsql-intellisense.Script.DropAndCreate` — "DROP And CREATE To"
- `tsql-intellisense.Script.Select` — "SELECT To"
- `tsql-intellisense.Script.Insert` — "INSERT To"
- `tsql-intellisense.Script.Update` — "UPDATE To"
- `tsql-intellisense.Script.Delete` — "DELETE To"
- `tsql-intellisense.Script.Execute` — "EXECUTE To"

- [ ] **Step 2: Add tree management commands to package.json**

Add to contributes.commands:
- `tsql-intellisense.RefreshDatabases` — icon: $(refresh)
- `tsql-intellisense.FilterDatabases` — icon: $(filter)
- `tsql-intellisense.NewDatabase` — icon: $(add)
- `tsql-intellisense.RefreshDatabase` — icon: $(refresh)
- `tsql-intellisense.NewSchema` — icon: $(add)
- `tsql-intellisense.RefreshFolder` — icon: $(refresh)
- `tsql-intellisense.FilterFolder` — icon: $(filter)
- `tsql-intellisense.NewTable` — icon: $(add)
- `tsql-intellisense.NewView` — icon: $(add)
- `tsql-intellisense.NewScalarFunction` — icon: $(add)
- `tsql-intellisense.NewTableValuedFunction` — icon: $(add)
- `tsql-intellisense.NewProcedure` — icon: $(add)
- `tsql-intellisense.NewTrigger` — icon: $(add)
Note: CollapseAll uses VS Code's built-in `showCollapseAll: true` option in `createTreeView()` — no custom command needed. Remove `tsql-intellisense.CollapseAll` if it was added; the built-in button appears automatically.

- [ ] **Step 3: Add submenu definition**

```json
"submenus": [
    { "id": "tsql-intellisense.ScriptAs", "label": "Script As" }
]
```

- [ ] **Step 4: Update selectTop100 title**

Change the command title from `%command.selectTop100%` to "Select Top 1000" (or add nls key).

- [ ] **Step 5: Add NLS entries for new commands**

Add entries in `package.nls.json` and `package.nls.tr.json` for all new command titles.

- [ ] **Step 6: Commit**

```bash
git add package.json package.nls.json package.nls.tr.json
git commit -m "feat: add Script As, tree management commands and submenu to package.json"
```

---

### Task 12: Update package.json — Context Menus

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update view/title menus**

Add to view/title for `view == tsqlConnections`:
- RefreshConnections (existing `refreshSchema` or new) — group: navigation
- CollapseAll — group: navigation
- AddConnection (existing) — group: navigation

- [ ] **Step 2: Update view/item/context — Connection nodes**

```json
{ "command": "tsql-intellisense.editConnection", "when": "viewItem =~ /^Connection/", "group": "inline" },
{ "command": "tsql-intellisense.treeConnect", "when": "viewItem == ConnectionDisconnected" },
{ "command": "tsql-intellisense.disconnect", "when": "viewItem == ConnectionConnected" },
{ "command": "tsql-intellisense.editConnection", "when": "viewItem =~ /^Connection/" },
{ "command": "tsql-intellisense.deleteConnection", "when": "viewItem =~ /^Connection/" }
```

- [ ] **Step 3: Update view/item/context — Server folder nodes**

```json
{ "command": "tsql-intellisense.RefreshDatabases", "when": "viewItem == ServerFolderDatabases", "group": "inline@1" },
{ "command": "tsql-intellisense.FilterDatabases", "when": "viewItem == ServerFolderDatabases", "group": "inline@2" },
{ "command": "tsql-intellisense.NewDatabase", "when": "viewItem == ServerFolderDatabases", "group": "inline@3" }
```

- [ ] **Step 4: Update view/item/context — Database and Schema nodes**

```json
{ "command": "tsql-intellisense.RefreshDatabase", "when": "viewItem == Database", "group": "inline@1" },
{ "command": "tsql-intellisense.NewSchema", "when": "viewItem == Database", "group": "inline@2" },
{ "command": "tsql-intellisense.newQueryFromTree", "when": "viewItem == Database || viewItem == Schema", "group": "inline" },
{ "command": "tsql-intellisense.newQueryFromTree", "when": "viewItem == Database || viewItem == Schema" }
```

- [ ] **Step 5: Update view/item/context — Schema folder nodes**

```json
{ "command": "tsql-intellisense.RefreshFolder", "when": "viewItem =~ /^SchemaFolder/ || viewItem =~ /^FuncFolder/", "group": "inline@1" },
{ "command": "tsql-intellisense.FilterFolder", "when": "viewItem =~ /^SchemaFolder/ || viewItem =~ /^FuncFolder/", "group": "inline@2" },
{ "command": "tsql-intellisense.NewTable", "when": "viewItem == SchemaFolderTables", "group": "inline@3" },
{ "command": "tsql-intellisense.NewView", "when": "viewItem == SchemaFolderViews", "group": "inline@3" },
{ "command": "tsql-intellisense.NewProcedure", "when": "viewItem == SchemaFolderProcedures", "group": "inline@3" },
{ "command": "tsql-intellisense.NewTrigger", "when": "viewItem == SchemaFolderTriggers", "group": "inline@3" },
{ "command": "tsql-intellisense.NewScalarFunction", "when": "viewItem == FuncFolderSC", "group": "inline@3" },
{ "command": "tsql-intellisense.NewTableValuedFunction", "when": "viewItem == FuncFolderTV", "group": "inline@3" }
```

- [ ] **Step 6: Update view/item/context — Object nodes and Script As submenu**

```json
{ "command": "tsql-intellisense.selectTop100", "when": "viewItem == Table || viewItem == View" },
{ "command": "tsql-intellisense.copyTableScript", "when": "viewItem == Table" },
{ "command": "tsql-intellisense.openTableScript", "when": "viewItem == Table || viewItem == View || viewItem == Function" },
{ "command": "tsql-intellisense.alterProc", "when": "viewItem == Procedure" },
{ "command": "tsql-intellisense.insertSpParams", "when": "viewItem == Procedure" },
{ "submenu": "tsql-intellisense.ScriptAs", "when": "viewItem == Table || viewItem == View || viewItem == Procedure || viewItem == Function || viewItem == Trigger", "group": "2_script" }
```

- [ ] **Step 7: Add Script As submenu items**

```json
"tsql-intellisense.ScriptAs": [
    { "command": "tsql-intellisense.Script.Create", "group": "1_create@1" },
    { "command": "tsql-intellisense.Script.Alter", "group": "1_create@2" },
    { "command": "tsql-intellisense.Script.CreateOrAlter", "when": "viewItem == View || viewItem == Procedure || viewItem == Function || viewItem == Trigger", "group": "1_create@3" },
    { "command": "tsql-intellisense.Script.Drop", "group": "2_drop@1" },
    { "command": "tsql-intellisense.Script.DropAndCreate", "group": "2_drop@2" },
    { "command": "tsql-intellisense.Script.Select", "when": "viewItem == Table || viewItem == View", "group": "3_dml@1" },
    { "command": "tsql-intellisense.Script.Insert", "when": "viewItem == Table || viewItem == View", "group": "3_dml@2" },
    { "command": "tsql-intellisense.Script.Update", "when": "viewItem == Table || viewItem == View", "group": "3_dml@3" },
    { "command": "tsql-intellisense.Script.Delete", "when": "viewItem == Table || viewItem == View", "group": "3_dml@4" },
    { "command": "tsql-intellisense.Script.Execute", "when": "viewItem == Procedure || viewItem == Function", "group": "4_exec@1" }
]
```

- [ ] **Step 8: Remove old context menu entries**

Remove old `when` clauses that reference `viewItem == table`, `viewItem == connection.connected`, `viewItem == database`, `viewItem == folder.databases`, etc. Replace with new contextValue references.

Remove commands: `tsql-intellisense.filterItems`, `tsql-intellisense.clearFilter`, `tsql-intellisense.switchDatabase` from menus and commands sections.

- [ ] **Step 9: Commit**

```bash
git add package.json
git commit -m "feat: update context menus with DbManager-style hierarchy and Script As submenu"
```

---

## Chunk 4: ScriptGenerator + Extension Wiring

### Task 13: Create ScriptGenerator Service

**Files:**
- Create: `src/services/ScriptGenerator.ts`

- [ ] **Step 1: Create ScriptGenerator with helper methods**

Port from DbManager's Extension.ts (lines 695-841). The service takes `TreeQueryService` in constructor.

Helper methods:
- `getObjectTypeKeyword(nodeType)` — maps NodeType to SQL keyword
- `getColumns(connectionId, dbName, schemaName, tableName)` — queries INFORMATION_SCHEMA.COLUMNS with identity detection
- `formatColumnType(dataType, maxLength, precision, scale)` — formats types with sizes

- [ ] **Step 2: Implement script generation methods**

All 10 methods:
- `generateCreateScript(node)` — Tables: INFORMATION_SCHEMA columns + PK. Others: OBJECT_DEFINITION().
- `generateAlterScript(node)` — Tables: ALTER TABLE ADD template. Others: replace CREATE with ALTER.
- `generateCreateOrAlterScript(node)` — Replace CREATE with CREATE OR ALTER.
- `generateDropScript(node)` — `DROP {TYPE} [{schema}].[{name}]`
- `generateDropAndCreateScript(node)` — DROP IF EXISTS + GO + CREATE
- `generateSelectScript(node)` — SELECT with all column names
- `generateInsertScript(node)` — INSERT with non-identity columns, comments
- `generateUpdateScript(node)` — UPDATE with SET clauses
- `generateDeleteScript(node)` — DELETE with WHERE placeholder
- `generateExecuteScript(node)` — EXEC for SPs (with OUTPUT params), SELECT for Functions

Reference: DbManager `Extension.ts` lines 695-841

- [ ] **Step 3: Commit**

```bash
git add src/services/ScriptGenerator.ts
git commit -m "feat: add ScriptGenerator service with 10 script generation methods"
```

---

### Task 14: Wire Everything in extension.ts

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Create TreeQueryService and new ConnectionTreeProvider**

In the `activate()` function:
- Create `TreeQueryService` wrapping `connectionManager`
- Create new `ConnectionTreeProvider` with `treeQueryService` and `context.extensionUri`
- Replace old tree provider registration
- Remove old `loadDbDataFn` callback
- Remove imports of old `connectionTreeItems.ts` types

- [ ] **Step 2: Register Script As commands**

Register 10 Script.* commands, each calling `ScriptGenerator.generate*Script(node)` → open result in new SQL editor with connection header.

```typescript
type ScriptAction = 'Create' | 'Alter' | 'CreateOrAlter' | 'Drop' | 'DropAndCreate' | 'Select' | 'Insert' | 'Update' | 'Delete' | 'Execute';

async function scriptAs(node: DatabaseTreeItem, action: ScriptAction): Promise<void> {
    const generator = new ScriptGenerator(treeQueryService);
    const script = await generator.generate(node, action);
    const header = buildConnectionHeader(
        node.profileName ?? '',
        node.databaseName ?? '',
        getProjectPath(node)
    );
    const doc = await vscode.workspace.openTextDocument({
        content: header + '\n\n' + script,
        language: 'sql'
    });
    await vscode.window.showTextDocument(doc, { preview: false });
}
```

- [ ] **Step 3: Register tree management commands**

Register: RefreshDatabases, FilterDatabases, NewDatabase, RefreshDatabase, NewSchema, RefreshFolder, FilterFolder, NewTable, NewView, NewScalarFunction, NewTableValuedFunction, NewProcedure, NewTrigger, CollapseAll.

Filter commands: show InputBox, call `treeProvider.setDatabaseFilter()` or `treeProvider.setFolderFilter()`, then refresh.
Refresh commands: call `treeProvider.refresh(node)`.
New* commands: open new SQL editor with template (CREATE TABLE, CREATE VIEW, etc.).

- [ ] **Step 4: Update existing command when clauses**

Update `selectTop100` to query TOP 1000 instead of TOP 100.
Update `newQueryFromTree` to use new DatabaseTreeItem properties and write connection header.
Update `treeConnect` to work with new contextValue.

- [ ] **Step 5: Remove old tree-related code**

Remove old imports from `connectionTreeItems.ts`.
Remove `filterItems`, `clearFilter`, `switchDatabase` command registrations.
Remove old `loadDbDataFn` function and SchemaCache tree integration.

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts
git commit -m "feat: wire tree provider, Script As commands, and tree management commands"
```

---

### Task 15: Delete Old connectionTreeItems.ts

**Files:**
- Delete: `src/providers/connectionTreeItems.ts`

- [ ] **Step 1: Verify no remaining imports**

```bash
grep -r "connectionTreeItems" src/
```
Expected: No results (all imports should now reference DatabaseNode.ts)

- [ ] **Step 2: Delete the file**

```bash
rm src/providers/connectionTreeItems.ts
```

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove old connectionTreeItems.ts (replaced by DatabaseNode.ts)"
```

---

## Chunk 5: SchemaCache Per-Database Map + Connection Header

### Task 16: Refactor SchemaCache to Per-Database Map

**Files:**
- Modify: `src/cache/schemaCache.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Review existing SchemaCache API**

Before refactoring, check `src/cache/schemaCache.ts` for these key methods that IntelliSense providers depend on:
- `isLoaded: boolean` — whether schema data has been loaded
- `loadObjectNames()` — loads table/view/SP/function names from DB
- `getTablesAndViews()` — returns objects for completion
- `getProcedures()` / `getFunctions()` — for completion
- `getColumns(tableName)` — column details for a table
- `getIndexes(tableName)` — index info
- `getForeignKeysForTable(tableName)` — FK relationships
- `hasTriggers(tableName)` — trigger check
- `getViewDefinition(viewName)` — view source
- `startAutoRefresh()` / `stopAutoRefresh()` — periodic refresh
- `loadedDbName` — which DB this cache is for
- `objectCount` — total loaded objects

All these methods must continue working on the `active` cache instance. The per-DB map just wraps multiple instances.

- [ ] **Step 2: Create SchemaCacheManager wrapper**

Add a new class `SchemaCacheManager` in extension.ts (or a new file `src/cache/schemaCacheManager.ts`) that manages a `Map<string, SchemaCache>`:

```typescript
class SchemaCacheManager {
    private caches = new Map<string, SchemaCache>();

    get(profileName: string, dbName: string): SchemaCache | undefined {
        return this.caches.get(`${profileName}::${dbName}`);
    }

    getOrCreate(profileName: string, dbName: string, connectionManager: ConnectionManager): SchemaCache {
        const key = `${profileName}::${dbName}`;
        if (!this.caches.has(key)) {
            this.caches.set(key, new SchemaCache(connectionManager));
        }
        return this.caches.get(key)!;
    }

    remove(profileName: string, dbName: string): void {
        this.caches.delete(`${profileName}::${dbName}`);
    }

    clear(): void { this.caches.clear(); }

    get active(): SchemaCache | undefined { return this._active; }
    set active(cache: SchemaCache | undefined) { this._active = cache; }
    private _active: SchemaCache | undefined;
}
```

- [ ] **Step 3: Update extension.ts to use SchemaCacheManager**

Replace single `schemaCache` instance with `schemaCacheManager`. Update all references:
- `schemaCache.getTablesAndViews()` → `schemaCacheManager.active?.getTablesAndViews()`
- All IntelliSense providers use `schemaCacheManager.active`
- Tab switch handler sets active cache based on connection header

- [ ] **Step 4: Implement tab switch handler**

```typescript
vscode.window.onDidChangeActiveTextEditor(async (editor) => {
    if (!editor || editor.document.languageId !== 'sql') { return; }
    const firstLine = editor.document.lineAt(0).text;
    const header = parseConnectionHeader(firstLine);
    if (!header) { return; }

    const cache = schemaCacheManager.getOrCreate(header.profileName, header.database, connectionManager);
    schemaCacheManager.active = cache;

    if (!cache.isLoaded) {
        // Connect if needed, switch to DB, load schema
        const profile = connectionManager.getSavedProfiles().find(p => p.name === header.profileName);
        if (profile) {
            if (connectionManager.currentProfile?.name !== header.profileName) {
                await connectionManager.connect(profile);
            }
            await connectionManager.softSwitchDatabase(header.database);
            await cache.loadObjectNames();
        }
    }

    // Update status bar
    updateStatusBar(header);
});
```

- [ ] **Step 5: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/cache/ src/extension.ts
git commit -m "feat: refactor SchemaCache to per-database Map with tab switch handler"
```

---

### Task 17: Implement Connection Header in New Query and Connection Change

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Update newQueryFromTree command**

When creating a new query from tree:
- Extract profileName, databaseName, projectPath from the DatabaseTreeItem node
- Create new SQL document with connection header as first line
- Set document-database association via queryRunner
- Trigger SchemaCache loading for that DB

- [ ] **Step 2: Update connection change handler**

When connection changes (via status bar, connect command, etc.):
- If active editor has a connection header, update it
- Load SchemaCache for new DB if needed

- [ ] **Step 3: Update USE statement detection**

When user runs a query with `USE [dbName]`:
- Update the connection header in the active document
- Switch the active SchemaCache

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts
git commit -m "feat: connection header auto-population and update on connection change"
```

---

## Chunk 6: Final Integration + Cleanup

### Task 18: Update extension.web.ts

**Files:**
- Modify: `src/extension.web.ts`

- [ ] **Step 1: Update web extension stubs**

Update web extension to use new DatabaseTreeItem types for the read-only tree display. Register stub commands for all new commands (Script.*, RefreshDatabases, FilterDatabases, etc.) that show "Not supported in web" message.

- [ ] **Step 2: Commit**

```bash
git add src/extension.web.ts
git commit -m "feat: update web extension stubs for new tree commands"
```

---

### Task 19: Full Build and Smoke Test

**Files:** All

- [ ] **Step 1: Run full TypeScript compilation**

```bash
npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 2: Run webpack build**

```bash
npm run compile
```
Expected: Build succeeds

- [ ] **Step 3: Run existing tests**

```bash
npm test
```
Expected: All existing tests pass

- [ ] **Step 4: Manual smoke test checklist**

Launch extension in VS Code (F5):
1. Verify tree view shows in sidebar with correct icon
2. Add a connection — verify connection form works
3. Expand connection → see Databases, Security, Server Objects folders
4. Expand Databases → see database list with Database.svg icons
5. Expand a database → see schema nodes with Schema.svg icons
6. Expand a schema → see Tables/Views/Functions/Procedures/Triggers folders
7. Expand Tables → see tables with Table.svg icons and column counts
8. Expand a table → see Columns/Keys/Constraints/Triggers/Indexes/Statistics sub-folders
9. Expand Columns → see columns with PK indicator (🔑 + ColumnKey.svg)
10. Right-click a table → verify Script As submenu with all options
11. Right-click an SP → verify Script As + alterProc + insertSpParams
12. Test database filter: click filter icon on Databases folder
13. Test folder filter: click filter icon on Tables folder
14. Open a .sql file → verify connection header is present
15. Switch tabs between two .sql files with different DBs → verify IntelliSense switches

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete DbManager tree view port — build verified"
```
