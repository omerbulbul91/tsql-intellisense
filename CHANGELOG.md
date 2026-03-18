# Changelog

## [0.1.0] - 2026-03-18

### Added
- IntelliSense: Table/View completion after FROM/JOIN with auto-alias
- IntelliSense: Column completion after `alias.` with PK/FK icons and type info
- IntelliSense: SP completion after EXEC with automatic parameter fill
- IntelliSense: JOIN ON condition suggestions (FK matches + same-name columns)
- IntelliSense: GROUP BY "All non-aggregated columns" snippet
- IntelliSense: SQL function snippets (COUNT, SUM, ROW_NUMBER, CAST, etc.)
- IntelliSense: Keyword suggestions after table names
- IntelliSense: SELECT * expand to all aliased columns
- IntelliSense: ALTER/CREATE object completion (PROC, TABLE, VIEW, FUNCTION, TRIGGER)
- Documentation popups for tables (CREATE script, PK, indexes, FK, triggers)
- Documentation popups for views (CREATE VIEW definition from DB)
- Copy Script / Open Script links in doc popups
- Go to Definition (F12) for SP, Function, View, and Table
- SP parameter completion with DECLARE for OUTPUT params
- Alias rename (F2) across all usages
- SQL snippets: loj, lj, ij, rj, cj, st
- Redgate SQL Prompt snippet loader (folder-based, with placeholder conversion)
- Set Snippet Folder command with folder picker
- $CURSOR$, $PASTE$, $table_name$ placeholder support
- Query execution with F5 (prioritized over mssql extension)
- Run Query button in editor toolbar
- GO batch separator support
- Multiple result set support (tabs/stacked view)
- CSV/JSON export
- SSMS-style query shortcuts (Alt+F1, Ctrl+1/2/3)
- Project Sync: auto-sync DDL changes to SQL Database Projects
- CREATE OR ALTER syntax support for Project Sync
- Schema cache with 30-minute auto refresh
- Connection management with saved profiles
