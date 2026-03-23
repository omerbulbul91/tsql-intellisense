## Run Queries

Execute SQL queries directly from VS Code with full result grid support.

### How to Run

- Press **F5** to execute the current query
- Or click the **▶ Run Query** button in the editor toolbar
- Select text to run only a portion of your script

### Features

- **GO batch separator** support — run multi-batch scripts
- **Multiple result sets** — sp_help and similar SPs show all grids
- **Display modes**: Tabs (switch between results) or Stacked (all visible)
- **Export**: CSV or JSON export from any result grid
- **Sortable columns**: Click column headers to sort

### SSMS-Style Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+F1` | sp_help for object under cursor |
| `Ctrl+1` | sp_who (active sessions) |
| `Ctrl+2` | sp_lock (locks) |
| `Ctrl+3` | SELECT TOP 100 from table under cursor |

> **Tip**: Customize shortcuts in Settings → `tsql-intellisense.queryShortcuts`
