# CLAUDE.md (English)

## Project Summary

tsql-intellisense is a VS Code extension that serves as a Redgate SQL Prompt alternative. It connects to SQL Server databases to provide IntelliSense (table/column/SP completion), query execution, and ALTER PROC code fetching.

## Build

```bash
npm run build    # produces dist/extension.js via esbuild
npm run watch    # auto-build on changes
```

## Debug / Test

1. Open this folder in VS Code
2. F5 → Extension Development Host opens
3. Open a SQL file → test IntelliSense and Run Query
4. Connection settings: `settings.json` → `tsql-intellisense.connections`

## Architecture

```
src/
├── extension.ts                     -- Entry point, command registrations, query shortcuts
├── connection/
│   └── connectionManager.ts         -- tedious connection, executeQuery, executeBatch (multi result set)
├── cache/
│   └── schemaCache.ts               -- In-memory schema cache (table, view, SP, function, column, FK, PK, index, trigger, view definition)
├── parser/
│   └── sqlContext.ts                 -- Regex-based SQL context detection + extractNonAggColumns
├── providers/
│   ├── completionProvider.ts        -- CompletionItemProvider (all completion logic)
│   ├── snippetProvider.ts           -- Redgate SQL Prompt snippet loader
│   ├── alterProcProvider.ts         -- Quick Pick SP selection command
│   ├── queryRunner.ts               -- WebviewViewProvider, query execution, results panel (tabs/stacked)
│   └── renameProvider.ts            -- F2 alias rename
├── queries/
│   └── schemaQueries.ts             -- SQL query templates (INFORMATION_SCHEMA + sys tables)
├── sync/
│   └── projectSync.ts               -- DDL execution → SQL project file sync
└── snippets/
    └── sql.json                     -- SQL snippets (loj, ij, rj, cj, st)
```

## Features

### IntelliSense / Completion

| Context | Behavior |
|---------|----------|
| `FROM / JOIN` | Table/view suggestions with auto-alias generation |
| `FROM table alias keyword` | SQL keyword suggestions (WHERE, ORDER BY, JOIN, etc.) |
| `alias.` | Columns of that table (PK 🔑, FK 🔗 icons, type + nullable info) |
| `SELECT` | Column suggestions + SQL function snippets (COUNT, SUM, ROW_NUMBER, CAST, ISNULL, etc.) |
| `SELECT ... *` | `* (expand all columns)` — expands to all aliased columns |
| `JOIN table alias ON` | Join condition suggestions (FK matches first, same-name columns below) |
| `= ` (inside ON clause) | Aliases + all alias columns |
| `( ` (inside function) | Column suggestions (inside SUM(), COUNT()) |
| `ORDER BY col` | ASC / DESC suggestions |
| `GROUP BY` | "All non-aggregated columns" snippet + aliases + columns |
| `EXEC / EXECUTE` | SP suggestions only (functions not listed — use SELECT dbo.FnName()) |
| `ALTER PROC` | SP list, fetches code on selection |
| General fallback | Keyword suggestions within query (ORDER BY, WHERE, etc.) |

### Table/View Documentation Popup

Detailed info shown in the right panel when a table/view is selected in the completion list.
Metadata loads in the background — "Schema loading..." is shown until loaded.

**TABLE popup content:**
- `Copy Script` | `Open Script` clickable links
- CREATE TABLE script (all columns, type, nullable)
- PRIMARY KEY constraint
- UNIQUE / NONCLUSTERED / CLUSTERED indexes
- FOREIGN KEY constraints (referenced table)
- CHECK constraints (if any)
- DEFAULT constraints (if any)
- ⚡ Triggers (with CREATE TRIGGER script)

**VIEW popup content:**
- `Copy Script` | `Open Script` clickable links
- Actual CREATE VIEW definition (fetched from DB via `OBJECT_DEFINITION`)
- Column list as fallback (if view definition not yet loaded)

**Important rules:**
- Doc popup must never block completion (do NOT async await)
- Show "Schema loading..." if metadata not loaded, never leave blank
- `md.isTrusted = true` and `md.supportHtml = true` must be set (for command links)

### Column Info (In Completion List)

- PK columns: `int not null 🔑`
- FK columns: `int 🔗`
- Normal columns: `varchar(50) null`
- Type + nullable info shown directly in the completion list

### Go to Definition (F12)

- F12 on SP/Function → CREATE PROCEDURE/FUNCTION script opens in new tab
- F12 on View → CREATE VIEW script
- F12 on Table → CREATE TABLE + PK + Index + FK + Trigger script
- Fetched via `OBJECT_DEFINITION` from DB (SP/Function/View), generated from cache for Table

### SP Parameter Completion

- After selecting SP with EXEC, parameters are auto-filled
- DECLARE lines for OUTPUT parameters are inserted above EXEC
- Each parameter: default value + type comment + alignment
- Format: `@ParamName = 0  -- int`

### Alias Rename (F2)

- F2 on alias → rename across all usages
- Works from both definition (`FROM table alias`) and usage (`alias.Column`) sites

### SQL Snippets

| Shortcut | Result |
|----------|--------|
| `loj` | LEFT OUTER JOIN ... ON |
| `lj` | LEFT JOIN ... ON |
| `ij` | INNER JOIN ... ON |
| `rj` | RIGHT JOIN ... ON |
| `cj` | CROSS JOIN ... |
| `st` | SELECT TOP 100 * FROM ... |

### Redgate SQL Prompt Snippet Support

- Set Redgate snippet folder path via `tsql-intellisense.snippetFolder`
- Use `T-SQL IntelliSense: Set Snippet Folder` from Command Palette for folder picker
- Reads `.json` files in Redgate format (`{id, prefix, description, body}`)
- Placeholder conversions:
  - `$CURSOR$` → VS Code cursor position
  - `$PASTE$` → clipboard content (tabstop if empty)
  - `$table_name$`, `$column_name$`, etc. → VS Code tabstops (navigate with Tab)
  - `$SELECTIONSTART$` / `$SELECTIONEND$` → removed
- Detail field shows `SQL Prompt` label, doc popup shows body preview
- Snippets sorted below schema completions (`sortText: "zz_"`)

### Query Shortcuts (SSMS-style)

| Shortcut | Default Query | Description |
|----------|--------------|-------------|
| `Alt+F1` | `EXEC sp_help '@WORD'` | Object info at cursor |
| `Ctrl+1` | `EXEC sp_who` | Active sessions |
| `Ctrl+2` | `EXEC sp_lock` | Locks |
| `Ctrl+3` | `SELECT TOP 100 * FROM @WORD` | Quick data preview |

- `@WORD` → replaced with word under cursor
- Customizable via settings: `tsql-intellisense.queryShortcuts`

### Query Execution

- `F5` to run (prioritized over mssql extension when active)
- Run Query button in editor toolbar
- GO batch separator support
- **Multiple result set support** (for SPs like sp_help)
- Two display modes: `tabs` or `stacked` — configurable in settings
- CSV/JSON export
- Sortable column headers

### Schema Cache

- On connection: object names loaded (INFORMATION_SCHEMA.TABLES + ROUTINES)
- Background: columns, FKs, indexes, triggers, view definitions loaded in bulk
- Lazy: individual table columns loaded on first use
- 30-minute auto refresh

### Project Sync (DDL → SQL Project)

- Automatic sync after `ALTER`, `CREATE`, `CREATE OR ALTER` for PROC/VIEW/FUNCTION/TRIGGER/TABLE
- Requires `projectPath` setting in connection profile
- `ALTER TABLE` selection only completes name, does NOT open CREATE script
- `ALTER VIEW/FUNCTION/TRIGGER` selection opens definition

## Context Detection (SqlContextType)

Regex-based cursor position analysis. Types:
- `AFTER_FROM_JOIN` — suggest table/view names
- `AFTER_EXEC` — suggest SP/function names
- `AFTER_ALIAS_DOT` — suggest columns of the alias's table
- `AFTER_ALTER_PROC` — show SP list, fetch code on selection
- `AFTER_SELECT` — suggest columns (with alias prefix) + SQL function snippets
- `AFTER_TABLE_NAME` — suggest keywords (WHERE, ORDER BY, JOIN, GO, etc.)
- `AFTER_ORDER_BY_COLUMN` — suggest ASC/DESC
- `AFTER_ON` — JOIN condition suggestions (FK + same-name columns + aliases)
- `AFTER_GROUP_BY` — non-agg columns + aliases + columns

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `tsql-intellisense.connections` | `[]` | Saved connection profiles |
| `tsql-intellisense.autoRefreshMinutes` | `30` | Schema cache refresh interval (0 to disable) |
| `tsql-intellisense.resultDisplayMode` | `stacked` | Result display: `tabs` or `stacked` |
| `tsql-intellisense.queryShortcuts` | SSMS defaults | Query shortcut definitions |
| `tsql-intellisense.snippetFolder` | `""` | Redgate SQL Prompt snippet folder path |

## Coding Standards

- Language: TypeScript, ES2020 target
- Bundler: esbuild (single file output: dist/extension.js)
- SQL Server connection: tedious package
- VS Code API: CompletionItemProvider, WebviewViewProvider, RenameProvider
- When adding new files, don't forget to import and register commands in `extension.ts`

## Dependencies

- **tedious** — SQL Server TDS protocol driver
- **@types/vscode** — VS Code API types
- **esbuild** — bundler

## Test

### Automated (programmatic)

```bash
npm test    # 41 context detection + 46 projectSync/snippet tests
```

### Manual Checklist (F5 in Extension Dev Host)

| # | Test | Type | Expected |
|---|------|------|----------|
| 1 | FROM table suggestion | `FROM asort` | Table list + doc popup (CREATE TABLE + PK + Index + FK) |
| 2 | VIEW doc popup | Select view after FROM | CREATE VIEW definition (from DB) |
| 3 | Trigger icon | Table with triggers | ⚡ icon + trigger script in doc |
| 4 | Copy/Open Script | Click link in doc popup | Copy to clipboard / open in new tab |
| 5 | Alias.dot columns | Type `am.` | Columns (PK 🔑, FK 🔗, type, nullable) |
| 6 | SELECT column suggestion | `SELECT ` (with FROM) | Columns + SQL function snippets |
| 7 | Function column | `SUM(` | Column suggestions |
| 8 | Keyword suggestion | `FROM T k wh` | WHERE, ORDER BY, etc. |
| 9 | Fallback keyword | `WHERE k.ID = 1 or` | ORDER BY suggestion |
| 10 | GO typing | Type `go` | GO suggestion, types correctly |
| 11 | JOIN ON condition | `LEFT JOIN T2 r ON ` | FK matches + same-name columns |
| 12 | After = alias | `ON r.ID = ` | Aliases + all columns |
| 13 | ORDER BY ASC/DESC | `ORDER BY k.Name de` | DESC / ASC |
| 14 | GROUP BY | `GROUP BY ` | Non-agg columns + aliases |
| 15 | EXEC SP suggestion | `EXEC sp_` | SP list only (no functions) |
| 16 | F2 alias rename | F2 on alias | Rename across all usages |
| 17 | SQL snippet | `loj` + Tab | LEFT OUTER JOIN ... ON |
| 18 | Alt+F1 sp_help | Alt+F1 on table | sp_help result (stacked/tabs) |
| 19 | Ctrl+3 SELECT | Ctrl+3 on table | SELECT TOP 100 * FROM table |
| 20 | Multi result set | Run sp_help | Separate grids (stacked or tabs) |
| 21 | F12 SP definition | F12 on SP name | CREATE PROCEDURE script in new tab |
| 22 | F12 Table definition | F12 on table name | CREATE TABLE + PK + FK + Index script |
| 23 | F12 View definition | F12 on view name | CREATE VIEW script |
| 24 | SP param completion | Select `EXEC spName` | Parameters auto-filled (DECLARE + format) |
| 25 | Redgate snippet | Type snippet prefix (e.g. `snp_`) | Shows in completion with "SQL Prompt" label |
| 26 | Snippet doc popup | Select snippet, check doc | **SQL Prompt Snippet** label + SQL body preview |
| 27 | Snippet $PASTE$ | Copy text, trigger $PASTE$ snippet | Copied text is pasted |
| 28 | Snippet folder picker | Command Palette → Set Snippet Folder | Folder picker opens, folder is selected |
| 29 | ALTER TABLE completion | Type `ALTER TABLE tab` | Table list appears, CREATE script does NOT open |
| 30 | CREATE OR ALTER sync | Run `CREATE OR ALTER TRIGGER` | File created/updated in project directory |
| 31 | F5 priority | F5 when extension active | Your runQuery runs (not mssql) |
| 32 | Run Query button | Check toolbar in SQL file | $(play) button visible |

## Known Limitations

- SQL parser is regex-based, may fail on complex nested queries
- mssql extension's encrypted passwords cannot be read (password comes empty)
- No formatting feature yet
