# T-SQL IntelliSense

SQL Server IntelliSense for VS Code — a Redgate SQL Prompt alternative.

Connect to SQL Server databases and get intelligent code completion, query execution, and schema navigation.

## Features

### IntelliSense

- **Table/View completion** after `FROM` / `JOIN` with auto-alias generation
- **Column completion** after `alias.` with type info, PK/FK icons
- **SP completion** after `EXEC` with automatic parameter fill
- **JOIN ON conditions** — FK matches first, then same-name columns
- **GROUP BY** — "All non-aggregated columns" snippet
- **SQL function snippets** — COUNT, SUM, ROW_NUMBER, CAST, ISNULL, etc.
- **Keyword suggestions** — WHERE, ORDER BY, JOIN after table names
- **SELECT * expand** — expands to all aliased columns

### Documentation Popups

- **Table popup**: CREATE TABLE script, PK, indexes, FK constraints, triggers
- **View popup**: CREATE VIEW definition from database
- **Copy Script / Open Script** clickable links

### Navigation

- **F12 Go to Definition** — SP, Function, View, Table definitions
- **F2 Rename** — alias rename across all usages

### Query Execution

- **F5** to run queries (prioritized over mssql extension)
- **Run Query button** in editor toolbar
- GO batch separator support
- Multiple result set support (tabs or stacked view)
- CSV/JSON export, sortable columns

### Redgate SQL Prompt Snippets

- Load existing Redgate SQL Prompt snippets from a folder
- Set via `T-SQL IntelliSense: Set Snippet Folder` command
- Supports `$CURSOR$`, `$PASTE$`, and named placeholders (`$table_name$`)
- Clipboard integration for `$PASTE$` placeholders

### Project Sync

- Automatically sync DDL changes to SQL Server Database Projects
- Supports `CREATE`, `ALTER`, and `CREATE OR ALTER` statements
- PROC, VIEW, FUNCTION, TRIGGER, TABLE support

### Query Shortcuts (SSMS-style)

| Shortcut | Default Query | Description |
|----------|--------------|-------------|
| `Alt+F1` | `EXEC sp_help '@WORD'` | Object info |
| `Ctrl+1` | `EXEC sp_who` | Active sessions |
| `Ctrl+2` | `EXEC sp_lock` | Locks |
| `Ctrl+3` | `SELECT TOP 100 * FROM @WORD` | Quick data preview |

### SQL Snippets

| Shortcut | Result |
|----------|--------|
| `loj` | LEFT OUTER JOIN ... ON |
| `lj` | LEFT JOIN ... ON |
| `ij` | INNER JOIN ... ON |
| `rj` | RIGHT JOIN ... ON |
| `cj` | CROSS JOIN ... |
| `st` | SELECT TOP 100 * FROM ... |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `tsql-intellisense.connections` | `[]` | Saved connection profiles |
| `tsql-intellisense.autoRefreshMinutes` | `30` | Schema cache refresh interval (0 to disable) |
| `tsql-intellisense.resultDisplayMode` | `stacked` | Result display: `tabs` or `stacked` |
| `tsql-intellisense.queryShortcuts` | SSMS defaults | Query shortcut definitions |
| `tsql-intellisense.snippetFolder` | `""` | Redgate SQL Prompt snippet folder path |

## Getting Started

1. Install the extension
2. Open a `.sql` file
3. Run `T-SQL IntelliSense: Connect to Database` from Command Palette
4. Start typing — IntelliSense will suggest tables, columns, and more

## License

MIT
