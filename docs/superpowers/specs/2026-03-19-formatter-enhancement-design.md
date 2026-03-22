# SQL Formatter Enhancement — Full Stored Procedure Formatting

## Problem

The current formatter only handles casing (keyword/function/datatype case transformation), SELECT clause layout (comma placement, line wrapping, tab stops), CASE expression formatting, and ALTER → CREATE OR ALTER conversion. It does not format the structure of stored procedures: statement separation, block indentation, EXEC parameter wrapping, string concatenation alignment, or DECLARE variable formatting. Statements crammed onto a single line stay crammed.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Indent unit | From config (`numberOfSpacesInTabs`, default 4) | Matches Redgate SQL Prompt whitespace config |
| Approach | Layered (3 phases) | Each layer independently testable, builds on previous |
| EXEC params | < 3 params single line, >= 3 wrap at maxLineLength | Balances readability vs compactness |
| String concat | Wrap at maxLineLength | Consistent with general wrapping rule |
| DECLARE | Preserve user structure (merged vs separate) | Respect intent — only apply indent + casing + alignment |
| Empty lines | From style config (not preserved by default) | `emptyLinesBetweenStatements: 1`, configurable |
| Block indentation | +indentUnit per nesting level | BEGIN/END, IF/ELSE, TRY/CATCH |

## Architecture

### Pipeline (sqlFormatter.ts)

```
tokenize → casing → createOrAlter → statementRule → layout → case
                                     ^^^^^^^^^^^
                                     NEW: phases 1-3
```

The new `statementRule` runs after casing (so tokens have correct case) and before `layoutRule` (which handles SELECT/FROM/WHERE clause-level formatting).

**Data flow:** `statementRule` receives Token[] and returns a **string**. This string is then re-tokenized by `layoutRule` (which already re-tokenizes its input via `splitStatements`). The existing `layoutRule` trailing blank-line normalization (`replace(/\n{3,}/g, '\n\n')`) will be removed — blank line normalization is now owned by `statementRule`.

### New Files

| File | Responsibility |
|------|---------------|
| `src/formatter/statementRule.ts` | Statement separation + block indentation + EXEC/DECLARE/concat formatting |
| `test/statementRule.test.ts` | Unit tests for all 3 layers |

### Existing Files (unchanged)

| File | Responsibility |
|------|---------------|
| `src/formatter/casingRule.ts` | Keyword/function/datatype casing |
| `src/formatter/sqlTokenizer.ts` | Lexical analysis |

### Modified Files

| File | Change |
|------|--------|
| `src/formatter/sqlFormatter.ts` | Add statementRule to pipeline |
| `src/formatter/styleLoader.ts` | Add whitespace + controlFlow config loading |
| `src/formatter/layoutRule.ts` | Remove trailing blank-line normalization (owned by statementRule now) |
| `src/formatter/caseRule.ts` | Update `getLeadingWhitespace` to detect actual indentation |

## Style Configuration

### New Fields in Style JSON

```json
{
  "whitespace": {
    "spacesOrTabs": "spaces",
    "numberOfSpacesInTabs": 4,
    "wrapLinesLongerThan": 120,
    "emptyLinesBetweenStatements": 1,
    "emptyLinesAfterBatchSeparator": 1,
    "preserveExistingEmptyLinesBetweenStatements": false,
    "preserveExistingEmptyLinesWithinStatements": false,
    "alignGroupsOfSingleLineComments": true,
    "alignMultilineCommentsMatchingCommonPatterns": true
  },
  "dataDml": {
    "clauseAlignment": "toStatement",
    "clauseIndentation": 0,
    "placeFromTableOnNewLine": "never",
    "placeWhereConditionOnNewLine": "never",
    "placeGroupByOrderByExpressionOnNewLine": "never",
    "placeInsertTableOnNewLine": false,
    "placeDistinctTopOnNewLine": false,
    "addNewLineAfterDistinctTop": true,
    "collapseShortDmlStatements": true,
    "collapseShortDmlShorterThan": 120,
    "collapseSubqueriesShorterThan": 120
  },
  "schemaDdl": {
    "parenthesesStyle": "openAtEnd",
    "indentParenthesesContents": true,
    "alignDataTypesAndConstraints": true,
    "placeConstraintsOnNewLines": true,
    "placeConstraintColumnsOnNewLines": "ifLongerOrMultiple",
    "indentClauses": false,
    "placeFirstProcedureParameterOnNewLine": "always",
    "collapseShortDdlStatements": true,
    "collapseShortDdlShorterThan": 120
  },
  "variables": {
    "declareAlignDataTypesAndValues": false,
    "declareAddSpaceBetweenTypeAndPrecision": false,
    "setPlaceAssignedValueOnNewLine": false,
    "setPlaceEqualsSignOnNewLine": true
  },
  "controlFlow": {
    "placeBeginOnNewLine": false,
    "indentBeginEndKeywords": false,
    "indentContentsOfStatements": true,
    "collapseShortStatements": false,
    "collapseShortStatementsShorterThan": 78
  }
}
```

### Config Priority

`wrapLinesLongerThan` from the whitespace config takes precedence over the existing `maxLineLength` setting. If `wrapLinesLongerThan` is not set, fall back to `maxLineLength`. The indent unit is always `numberOfSpacesInTabs` (not hardcoded to 4).

### Integration with StyleLoader

`styleLoader.ts` gets five new methods:
- `getWhitespaceOptions()` — returns whitespace config with defaults
- `getDataDmlOptions()` — returns DML formatting config with defaults
- `getSchemaDdlOptions()` — returns DDL formatting config with defaults
- `getVariablesOptions()` — returns DECLARE/SET config with defaults
- `getControlFlowOptions()` — returns control flow config with defaults

All defaults match the Redgate SQL Prompt RENIUMSTYLE configuration shown above.

## Layer 1: Block Indentation

### Block Types

| Open | Close | Notes |
|------|-------|-------|
| `BEGIN` | `END` | General block |
| `BEGIN TRY` | `END TRY` | Try block |
| `BEGIN CATCH` | `END CATCH` | Catch block |
| `IF ... BEGIN` | `END` | Conditional block (when `placeBeginOnNewLine` is OFF) |
| `ELSE BEGIN` | `END` | Else block |
| `WHILE ... BEGIN` | `END` | Loop block |

### Algorithm

1. Parse token stream into lines
2. Track block depth using a stack
3. For each line, determine its depth before processing:
   - Block closer (`END`, `END TRY`, `END CATCH`) → pop stack, use new depth
   - Block opener (`BEGIN`, `BEGIN TRY`, `BEGIN CATCH`) → use current depth, push stack
4. Apply `depth * indentUnit` spaces as prefix to each line
5. If `indentBeginEndKeywords` is ON, BEGIN/END themselves get +1 indent relative to their parent
6. If `indentContentsOfStatements` is ON (default), block contents get +1 indent

### Control Flow: IF/ELSE Without BEGIN

When IF or ELSE is not followed by BEGIN, the **single next statement** gets +1 indent, then depth returns to the IF's depth.

**Detection algorithm:** After encountering IF (or ELSE) without BEGIN on the same line, set a flag `pendingSingleIndent`. The very next statement-starting line gets +1 indent. The line after that returns to original depth. This handles:

```sql
While @@ROWCOUNT > 20
Begin
        If @BusinessEntityID > 0                    -- depth 2
                Delete From dbo.Table Where ...;    -- depth 3 (single-statement body)
        Else                                        -- depth 2
                Break;                              -- depth 3 (single-statement body)

        If @OldId < 2000                            -- depth 2
                Return @OldId;                      -- depth 3 (single-statement body)
End;                                                -- depth 1
```

**Nested single-line IFs:** Each nested IF without BEGIN adds +1 depth:
```sql
If @x = 1                  -- depth N
        If @y = 2          -- depth N+1 (single body of outer IF)
                Set @z = 3 -- depth N+2 (single body of inner IF)
```

### Control Flow: placeBeginOnNewLine

When `placeBeginOnNewLine` is OFF (default — from Redgate config):
```sql
If @x = 0 Begin
    Print 'zero'
End
```

When `placeBeginOnNewLine` is ON:
```sql
If @x = 0
Begin
    Print 'zero'
End
```

### Short Control Flow Statements

When `collapseShortStatements` is ON and total length < `collapseShortStatementsShorterThan` (default 78):
```sql
If @x = 1 Set @y = 2
```

When OFF (default): always expand to separate lines.

### Procedure Structure

```
Create Or Alter Procedure dbo.SpName    -- depth 0
    @Param1 Int, @Param2 NVarchar(50)  -- depth 0 (param indent is cosmetic)
As                                      -- depth 0
Set NoCount On                          -- depth 0

Begin                                   -- depth 0
    Begin Try                           -- depth 1
        Declare @x Int                  -- depth 2
        Set @x = 1                      -- depth 2
        If @x = 0 Begin                -- depth 2
            Print 'zero'               -- depth 3
        End                             -- depth 2
        If @x = 1                       -- depth 2
            Print 'one'                -- depth 3 (single-statement body)
        Else                            -- depth 2
            Print 'not one'            -- depth 3 (single-statement body)
    End Try                             -- depth 1
    Begin Catch                         -- depth 1
        Print ERROR_MESSAGE()           -- depth 2
    End Catch                           -- depth 1
End                                     -- depth 0
```

## Layer 2: Statement Separation

### Statement-Starting Keywords

These keywords signal a new statement and must start on a new line:

`SET`, `IF`, `ELSE`, `WHILE`, `PRINT`, `EXEC`, `EXECUTE`, `DECLARE`, `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `RETURN`, `THROW`, `RAISERROR`, `BEGIN`, `END`, `BEGIN TRY`, `END TRY`, `BEGIN CATCH`, `END CATCH`, `GO`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `DENY`, `REVOKE`, `USE`, `WAITFOR`, `WITH`, `OPEN`, `CLOSE`, `FETCH`, `DEALLOCATE`, `COMMIT`, `ROLLBACK`, `BREAK`, `CONTINUE`, `SAVE`

### Context-Aware Statement Detection

A "statement boundary" is detected by:
- A statement-starting keyword at parenthesis depth 0
- Not inside a string literal or comment
- Not a compound keyword continuation — specifically:
  - `ORDER BY`, `GROUP BY`, `HAVING` are continuations of SELECT (not new statements) when inside a SELECT clause chain
  - `FROM`, `WHERE`, `AND`, `OR` are continuations when inside SELECT/UPDATE/DELETE
  - `ON` is continuation of JOIN
  - `SET` after `UPDATE ... SET` is continuation, not new statement
  - `INTO` after `INSERT INTO` is continuation

**Implementation:** Track whether we're inside a SELECT clause chain (set when we see SELECT at depth 0, cleared when we see a statement-starting keyword that isn't a clause continuation). This prevents `ORDER BY` after SELECT from being treated as a new statement, while `SET` after `END` is correctly detected as new.

### Empty Line Rules

1. When `preserveExistingEmptyLinesBetweenStatements` is OFF: normalize gap between statements to `emptyLinesBetweenStatements` (default 0 — no extra blank line, just newline)
2. When ON: keep existing empty lines as-is
3. `emptyLinesAfterBatchSeparator` (default 1) after GO
4. When `preserveExistingEmptyLinesWithinStatements` is OFF: collapse multiple empty lines within a statement to 0
5. Comments between statements: empty line before comment block if there isn't one already

## Layer 3: Detail Formatting

### EXEC Parameter Wrapping

```
if paramCount < 3 AND total line length < maxLineLength:
    single line: Exec dbo.SpName @P1 = 1, @P2 = 'x'
else:
    first params on same line as EXEC (up to maxLineLength)
    wrap remaining with comma-before, aligned to first param:

    Exec dbo.Sp_Rn_Sys_CreateWorkerTask @WorkerTaskTypeId = 1, @TaskName = N'Test'
                                      , @ExecuteAfter = @Now, @IsRepetitive = 0
                                      , @Subject = @Subject, @Body = @Body2
```

**Column calculation:** Continuation lines start at `spaces(prefixLen - 2) + ', '` where `prefixLen` = length of `'Exec dbo.SpName '` (including trailing space). So if `Exec dbo.SpName ` is 24 chars, continuation is 22 spaces + `, `.

### String Concatenation

When a `SET @var = expr + expr + ...` line exceeds maxLineLength:

1. Find the `=` position and the right-hand-side start position
2. Break at `+` operators
3. Align subsequent `+` to the right-hand-side start column

```sql
Set @Body2 = @Body2
             + N'long string...'
```

When the line is short enough (< maxLineLength): keep on single line.
```sql
Print N'  Sunucu     : ' + @ServerName
```

Multi-line string literals (containing actual newlines inside `N'...'`): always break the `+` onto new line regardless of length — the string content itself spans multiple lines.

### DECLARE Formatting

- Preserve user's merge/split choice
- For merged DECLARE (comma-separated): align commas to `Declare ` width (8 chars including space)
- Apply indent based on block depth
- Casing already handled by casing rule

```sql
Declare @DbName NVarchar(128) = DB_NAME()
      , @ServerName NVarchar(128) = CONVERT(NVarchar(128), SERVERPROPERTY('Servername'))
      , @Body2 NVarchar(Max)
```

### Comment Alignment

When `alignGroupsOfSingleLineComments` is ON:
- Find consecutive lines ending with `-- comment`
- Align the `--` to the same column (max content width in group + 1 space)

When `alignMultilineCommentsMatchingCommonPatterns` is ON:
- Detect common block comment patterns (`/* ... */`) and preserve their internal alignment

## Test Plan

### Unit Tests (test/statementRule.test.ts)

**Layer 1 — Block Indentation:**
- Simple BEGIN/END block → contents indented
- Nested BEGIN/END (2+ levels) → correct depth
- BEGIN TRY / END TRY / BEGIN CATCH / END CATCH → symmetric
- IF ... BEGIN / END → BEGIN on same line, contents indented
- IF without BEGIN → single next statement indented, then returns
- ELSE without BEGIN → single next statement indented
- Nested single-line IF → cumulative indentation
- Procedure with AS + outer BEGIN/END → full structure
- placeBeginOnNewLine ON → BEGIN on separate line
- collapseShortStatements ON → short IF collapsed

**Layer 2 — Statement Separation:**
- Two SET statements crammed on one line → separated
- Empty lines normalized to config value
- GO batch separator → correct empty lines after
- Comments between statements → preserved, attached to next statement
- Statements inside parentheses NOT separated (subqueries)
- SELECT followed by ORDER BY → not separated (continuation)
- UPDATE ... SET → not treated as new statement boundary

**Layer 3 — Detail Formatting:**
- EXEC with 1-2 params → single line
- EXEC with 5+ params → wrapped, comma-before, aligned to prefix width
- String concat short → single line
- String concat exceeding maxLineLength → wrapped at `+`, aligned to `=` RHS
- Multi-line string literal → always wrapped
- DECLARE merged with comma alignment at col 8
- DECLARE separate → each on own line with indent
- Comment alignment in consecutive lines ending with `--`

**Integration Test:**
- Full SP from user's before/after example: crammed input → correctly formatted output
- Verify all 3 layers work together without conflicts
- Verify statementRule output feeds correctly into layoutRule (SELECT clauses still formatted)
- Verify caseRule respects new indentation (CASE inside indented block)
