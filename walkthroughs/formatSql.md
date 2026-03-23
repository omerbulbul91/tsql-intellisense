## Format SQL

Auto-format your SQL with a Redgate SQL Prompt-compatible formatter.

### How to Format

- Right-click → **Format Document**
- Or press `Shift+Alt+F`

### What It Does

- **Keyword casing**: UPPERCASE, lowercase, or UpperCamelCase
- **Clause alignment**: SELECT, FROM, WHERE aligned to tab stops
- **JOIN formatting**: Conditions on new line, aligned
- **Block indentation**: BEGIN/END, IF/ELSE properly indented
- **Spacing**: Operators and commas properly spaced
- **CREATE OR ALTER**: Automatically converts ALTER to CREATE OR ALTER
- **dbo. prefix**: Adds schema qualifier to unqualified objects

### Customization

Import your existing Redgate SQL Prompt `.sqlsettings` style file:
- Settings → `tsql-intellisense.styleFile` → point to your file
- Or use Command Palette → **SQL Prompt Options** for visual settings

> **Tip**: The formatter respects your existing Redgate style files — no need to reconfigure.
