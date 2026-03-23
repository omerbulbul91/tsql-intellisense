## Go to Definition & Rename

Navigate your database code like application code.

### Go to Definition (F12)

Place your cursor on any database object and press **F12**:

| Object | Result |
|--------|--------|
| Stored Procedure | CREATE PROCEDURE script in new tab |
| Function | CREATE FUNCTION script in new tab |
| View | CREATE VIEW script in new tab |
| Table | CREATE TABLE + PK + Index + FK + Trigger script |

### Rename (F2)

Press **F2** on any alias to rename it across the entire query:
- Works from both definition (`FROM Table alias`) and usage (`alias.Column`)
- All references update simultaneously

### ALTER Procedure

Use Command Palette → **ALTER Procedure** to browse and open any stored procedure's source code with Quick Pick search.

> **Tip**: Combined with SQL Project sync, F12 definitions are saved to your project folder automatically.
