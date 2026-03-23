## Object Explorer

Browse your database objects in a familiar tree view — just like SSMS.

### Tree Structure

```
📁 Server\Instance
  📁 DatabaseName
    📁 Tables
    📁 Views
    📁 Stored Procedures
    📁 Functions
    📁 Triggers
```

### Actions

- **Right-click** any object for context menu:
  - Script As → CREATE, ALTER, DROP, SELECT, INSERT...
  - Select Top 1000
  - New Query
  - Open in Explorer (for project-synced files)
- **Filter**: Click the filter icon to search within folders
- **Refresh**: Sync with latest database changes

### Query History

The Query History panel (below connections) tracks your executed queries with timestamps, so you can easily re-run or review past work.

> **Tip**: Right-click a stored procedure → **EXEC with Params** to auto-generate an EXEC call with all parameters.
