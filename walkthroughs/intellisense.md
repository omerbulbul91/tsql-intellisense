## Smart IntelliSense

T-SQL IntelliSense provides context-aware completions — just like SQL Prompt.

### What You Get

| Context | Suggestions |
|---------|-------------|
| `FROM` / `JOIN` | Tables & views with auto-alias |
| `alias.` | Columns with type info (🔑 PK, 🔗 FK) |
| `SELECT` | Columns + SQL functions (COUNT, SUM, ROW_NUMBER...) |
| `EXEC` | Stored procedures with parameter fill |
| `JOIN ... ON` | FK matches + same-name columns |
| `ORDER BY col` | ASC / DESC |
| `GROUP BY` | Non-aggregated columns snippet |

### Documentation Popups

Select a table or view in the completion list to see:
- **Tables**: CREATE script, PKs, indexes, FKs, triggers
- **Views**: Full CREATE VIEW definition
- **Columns**: Data type, nullability, constraints

> **Tip**: Type `loj` + Tab for LEFT OUTER JOIN snippet, `st` for SELECT TOP 100.
