# Changelog

## [0.5.5] - 2026-03-29

### Fixed
- **Export Schema: DEFAULT values** — `/*...*/` placeholder yerine gerçek DEFAULT değerleri yazılıyor (#18)
- **Export Schema: CRLF line endings** — UTF-8 BOM + CRLF + trailing blank line (SSDT standardı) (#17)
- **Export Schema: idempotent write** — BOM, LF/CRLF ve trailing newline farkları yoksayılıyor

### Added
- **SSDT-compatible table export** — UPPERCASE datatypes, precision (`DATETIME2 (7)`), inline PK/FK, cascade info, named DEFAULT constraints, computed columns, filtered index WHERE clause, column alignment
- **Schema cache refresh** — export öncesi cache tamamen yenileniyor (her zaman güncel DB verisi)
- **Index order preservation** — mevcut dosyadaki index sırası korunuyor
- **26 yeni test** — SSDT format kuralları (datatype, constraint, computed, cascade, BOM, normalization)

## [0.5.4] - 2026-03-28

### Added
- **Export Schema** — `T-SQL: Export Schema` command exports all DB objects (Tables, Views, SPs, Functions, Triggers) to folder as `.sql` files
- **Cache-first export** — all scripts generated from schema cache, ~1s for 1700+ objects
- **Idempotent write** — unchanged files are not rewritten (no git diff noise)
- **CRLF normalize** — exported files use LF line endings with trailing whitespace trimmed
- **Bulk object definitions** — `loadObjectDefinitions()` caches all SP/View/Function/Trigger definitions in one query
- **Auto-connect from tree** — tree context menu commands auto-connect `connectionManager` if not connected
- **Export logging** — start/end timestamps and results logged to `T-SQL Connection` output channel

## [0.5.3] - 2026-03-24

### Added
- **Query cancel** — F5 and query shortcuts now show Cancel button; cancels the running TDS request
- **Connection cancel** — connection progress notification supports Cancel button
- **Connection dedup** — duplicate connect calls to the same profile reuse the pending connection
- **Schema cache logging** — all cache operations (objects, columns, FK, triggers, indexes, views) logged with timing to T-SQL Connection output channel
- **Query history seqNo** — entries display `#N` sequence numbers per file name
- **Query history rich tooltip** — hover shows connection, database, date, and full SQL (4000 chars)
- **Query history batch delete** — file group delete removes all entries with confirmation
- **Query history dedup** — re-running the same SQL from the same file replaces the old entry
- **Snippet Manager from context menu** — "Add Snippet" opens Snippet Manager (not Style Form)
- **Table doc popup** — completion hover for TABLE shows full CREATE TABLE script via `buildTableScript()`
- **Query shortcut logging** — Alt+F1, Ctrl+1..9 shortcuts logged to output channel

### Changed
- **Context menu order** — Snippet Manager inserted at position 3, other items shifted down
- **Snippet label** — "SQL Prompt" branding replaced with "T-SQL IntelliSense"
- **Built-in snippets removed** — `contributes.snippets` emptied to prevent duplicates with snippet folder
- **History single-click** — no longer opens preview; tooltip shows on hover instead
- **History double-click** — promotes preview tab to pinned; auto-connects to the entry's database
- **Clear history** — now requires confirmation dialog
- **Delete history entry** — now requires confirmation dialog
- **Extension page** — uses `workbench.extensions.search` instead of `extension.open`

### Fixed
- **Schema cache console.log** — replaced stray `console.log` calls with OutputChannel logging
- **resolveCompletionItem detail prefix** — strips `T-SQL • ` prefix before matching object type
- **History header stripping** — removes `-- #N |...` header from SQL before storage/comparison

## [0.5.2] - 2026-03-23

### Added
- **Star expand multi-table** — `*` expand now includes columns from all JOIN'ed tables with alias prefix
- **Star expand auto-trigger** — cursor landing after `*` in SELECT context auto-opens suggestions
- **Star expand unavailable warning** — shows reason when table not found in schema
- **Multi-line SELECT context** — `SELECT` on one line, columns on next line now detected correctly
- **Ctrl+F1 query shortcut** — new configurable shortcut, parity with settings UI
- **Alias-less table expand** — `*` expand works without aliases, uses table name as prefix

### Changed
- **F12 Go to Definition** — table scripts now fetched live from DB (IDENTITY, computed columns, CHECK/DEFAULT constraints included)
- **F12 cache refresh** — after F12, column cache is refreshed for the navigated object

### Fixed
- **Star expand position** — `*` expand suggestion appears only when `*` is typed, not in general SELECT context
- **Selection listener guard** — auto-trigger skips multiplication `*` (e.g. `price * quantity`)
- **F2 rename** — alias rename excludes FROM/JOIN table name positions when alias matches table name

## [0.3.0] - 2026-03-18

### Added
- **Sidebar Connection Tree** — T-SQL Explorer panel in Activity Bar with Server → Databases → Objects hierarchy
- **Object Explorer** — Tables, Views, Stored Procedures, Functions folders with item counts
- **Column Explorer** — expand tables/views to see columns with PK/FK icons and type info
- **Connection Form** — webview tab with Connection Properties and Connection String tabs
- **Connection String Parser** — paste a connection string, form fields auto-fill as you type (two-way sync)
- **Saved Connections** sidebar in connection form
- **Recent Connections** tracking (last 10, stored in globalState)
- **Encrypt dropdown** — Optional (default) / Mandatory / Strict per connection
- **Password visibility toggle** — eye button on password field
- **Server,Port format support** — `192.168.1.100,1433` auto-parsed for tedious
- **Database switching** — click any DB in the tree to switch without reconnecting the server
- **Per-database project paths** — each database has its own SQL project folder (`databaseProjects` map)
- **New Query from DB** — opens SQL file bound to that database, F5 auto-switches if needed
- **New Query from Server** — opens SQL file with no DB, F5 shows database picker
- **Context menus** — right-click actions: SELECT TOP 100, Copy/Open Script, ALTER PROC, EXEC with Params
- **Inline icons** — hover over connection/database rows for quick actions (New Query, Edit, Refresh, Delete)
- **Test Connection** button in connection form
- Content Security Policy for webview forms

### Fixed
- Connect timeout increased to 30s for remote servers
- `encrypt: false` as default (Optional) for compatibility with older SQL Servers
- SQL injection protection in SELECT TOP 100 (bracket-escape `]` characters)
- `openTableScript` now works for functions (falls back to OBJECT_DEFINITION)

## [0.2.0] - 2026-03-18

### Added
- Redgate SQL Prompt snippet loader (folder-based, `$CURSOR$`/`$PASTE$`/`$table_name$` placeholders)
- Set Snippet Folder command with folder picker (`Ctrl+Alt+S` → new SQL file)
- New SQL File command (`Ctrl+Alt+S`)
- Run Query button in editor toolbar
- F5 priority over mssql extension when active
- Beta label in display name and description
- Marketplace badges and roadmap in README

### Fixed
- `CREATE OR ALTER` syntax now detected by Project Sync
- `ALTER TABLE` completion no longer opens CREATE script
- Request queue for tedious connection — prevents "SentClientRequest" error on concurrent queries

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
