# SQL Formatter Enhancement Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full stored procedure formatting — block indentation, statement separation, EXEC param wrapping, string concat alignment, DECLARE formatting — to the existing SQL formatter.

**Architecture:** New `statementRule.ts` inserts into the pipeline between casing and layout. It receives Token[], outputs a string. Three layers run in sequence: statement separation → block indentation → detail formatting. Style config expanded with whitespace, controlFlow, dataDml, schemaDdl, variables sections.

**Tech Stack:** TypeScript, esbuild bundler, existing tokenizer (`sqlTokenizer.ts`)

**Spec:** `docs/superpowers/specs/2026-03-19-formatter-enhancement-design.md`

---

## Task 1: Extend StyleLoader with new config sections

**Files:**
- Modify: `src/formatter/styleLoader.ts`
- Test: `test/formatter.test.ts` (add config tests at end)

- [ ] **Step 1: Define interfaces for new config sections**

Add after the existing imports and before `SqlStyle`:

```typescript
// src/formatter/styleLoader.ts — new interfaces

export interface WhitespaceOptions {
    spacesOrTabs: 'spaces' | 'tabs';
    numberOfSpacesInTabs: number;
    wrapLinesLongerThan: number;
    emptyLinesBetweenStatements: number;
    emptyLinesAfterBatchSeparator: number;
    preserveExistingEmptyLinesBetweenStatements: boolean;
    preserveExistingEmptyLinesWithinStatements: boolean;
    alignGroupsOfSingleLineComments: boolean;
    alignMultilineCommentsMatchingCommonPatterns: boolean;
}

export interface ControlFlowOptions {
    placeBeginOnNewLine: boolean;
    indentBeginEndKeywords: boolean;
    indentContentsOfStatements: boolean;
    collapseShortStatements: boolean;
    collapseShortStatementsShorterThan: number;
}

export interface VariablesOptions {
    declareAlignDataTypesAndValues: boolean;
    declareAddSpaceBetweenTypeAndPrecision: boolean;
    setPlaceAssignedValueOnNewLine: boolean;
    setPlaceEqualsSignOnNewLine: boolean;
}

export interface DataDmlOptions {
    clauseAlignment: 'toStatement' | 'toKeyword';
    clauseIndentation: number;
    placeFromTableOnNewLine: 'never' | 'always' | 'ifLong';
    placeWhereConditionOnNewLine: 'never' | 'always' | 'ifLong';
    placeGroupByOrderByExpressionOnNewLine: 'never' | 'always' | 'ifLong';
    placeInsertTableOnNewLine: boolean;
    placeDistinctTopOnNewLine: boolean;
    addNewLineAfterDistinctTop: boolean;
    collapseShortDmlStatements: boolean;
    collapseShortDmlShorterThan: number;
    collapseSubqueriesShorterThan: number;
}

export interface SchemaDdlOptions {
    parenthesesStyle: 'openAtEnd' | 'openOnNewLine' | 'openInline';
    indentParenthesesContents: boolean;
    alignDataTypesAndConstraints: boolean;
    placeConstraintsOnNewLines: boolean;
    placeConstraintColumnsOnNewLines: 'never' | 'always' | 'ifLongerOrMultiple';
    indentClauses: boolean;
    placeFirstProcedureParameterOnNewLine: 'never' | 'always' | 'ifMultiple';
    collapseShortDdlStatements: boolean;
    collapseShortDdlShorterThan: number;
}
```

- [ ] **Step 2: Add defaults**

```typescript
const DEFAULT_WHITESPACE: WhitespaceOptions = {
    spacesOrTabs: 'spaces',
    numberOfSpacesInTabs: 4,
    wrapLinesLongerThan: 120,
    emptyLinesBetweenStatements: 1,
    emptyLinesAfterBatchSeparator: 1,
    preserveExistingEmptyLinesBetweenStatements: false,
    preserveExistingEmptyLinesWithinStatements: false,
    alignGroupsOfSingleLineComments: true,
    alignMultilineCommentsMatchingCommonPatterns: true,
};

const DEFAULT_CONTROL_FLOW: ControlFlowOptions = {
    placeBeginOnNewLine: false,
    indentBeginEndKeywords: false,
    indentContentsOfStatements: true,
    collapseShortStatements: false,
    collapseShortStatementsShorterThan: 78,
};

const DEFAULT_VARIABLES: VariablesOptions = {
    declareAlignDataTypesAndValues: false,
    declareAddSpaceBetweenTypeAndPrecision: false,
    setPlaceAssignedValueOnNewLine: false,
    setPlaceEqualsSignOnNewLine: true,
};

const DEFAULT_DATA_DML: DataDmlOptions = {
    clauseAlignment: 'toStatement',
    clauseIndentation: 0,
    placeFromTableOnNewLine: 'never',
    placeWhereConditionOnNewLine: 'never',
    placeGroupByOrderByExpressionOnNewLine: 'never',
    placeInsertTableOnNewLine: false,
    placeDistinctTopOnNewLine: false,
    addNewLineAfterDistinctTop: true,
    collapseShortDmlStatements: true,
    collapseShortDmlShorterThan: 120,
    collapseSubqueriesShorterThan: 120,
};

const DEFAULT_SCHEMA_DDL: SchemaDdlOptions = {
    parenthesesStyle: 'openAtEnd',
    indentParenthesesContents: true,
    alignDataTypesAndConstraints: true,
    placeConstraintsOnNewLines: true,
    placeConstraintColumnsOnNewLines: 'ifLongerOrMultiple',
    indentClauses: false,
    placeFirstProcedureParameterOnNewLine: 'always',
    collapseShortDdlStatements: true,
    collapseShortDdlShorterThan: 120,
};
```

- [ ] **Step 3: Add fields + getter methods to StyleLoader class**

Add private fields and public getters:

```typescript
// In StyleLoader class — new private fields
private whitespaceOptions: WhitespaceOptions = { ...DEFAULT_WHITESPACE };
private controlFlowOptions: ControlFlowOptions = { ...DEFAULT_CONTROL_FLOW };
private variablesOptions: VariablesOptions = { ...DEFAULT_VARIABLES };
private dataDmlOptions: DataDmlOptions = { ...DEFAULT_DATA_DML };
private schemaDdlOptions: SchemaDdlOptions = { ...DEFAULT_SCHEMA_DDL };

// New getters (add after existing getters)
getWhitespaceOptions(): WhitespaceOptions { return this.whitespaceOptions; }
getControlFlowOptions(): ControlFlowOptions { return this.controlFlowOptions; }
getVariablesOptions(): VariablesOptions { return this.variablesOptions; }
getDataDmlOptions(): DataDmlOptions { return this.dataDmlOptions; }
getSchemaDdlOptions(): SchemaDdlOptions { return this.schemaDdlOptions; }
```

Also update `loadFromFile()` and `applyOverrides()` to reset these to defaults, and to parse them from the style JSON if present. Extend the `SqlStyle` interface to include the new sections.

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: Success

- [ ] **Step 5: Commit**

```bash
git add src/formatter/styleLoader.ts
git commit -m "feat(formatter): add whitespace, controlFlow, variables, dataDml, schemaDdl config to StyleLoader"
```

---

## Task 2: Statement Separation (Layer 2)

This is Layer 2 in the spec but implemented first because it's simpler and block indentation builds on separated statements.

**Files:**
- Create: `src/formatter/statementRule.ts`
- Create: `test/statementRule.test.ts`

- [ ] **Step 1: Write failing tests for statement separation**

```typescript
// test/statementRule.test.ts
import { applyStatementFormatting } from '../src/formatter/statementRule';
import { tokenize } from '../src/formatter/sqlTokenizer';
import { WhitespaceOptions, ControlFlowOptions, VariablesOptions } from '../src/formatter/styleLoader';

// Use defaults matching spec
const ws: WhitespaceOptions = {
    spacesOrTabs: 'spaces', numberOfSpacesInTabs: 4, wrapLinesLongerThan: 120,
    emptyLinesBetweenStatements: 0, emptyLinesAfterBatchSeparator: 1,
    preserveExistingEmptyLinesBetweenStatements: false,
    preserveExistingEmptyLinesWithinStatements: false,
    alignGroupsOfSingleLineComments: true,
    alignMultilineCommentsMatchingCommonPatterns: true,
};
const cf: ControlFlowOptions = {
    placeBeginOnNewLine: false, indentBeginEndKeywords: false,
    indentContentsOfStatements: true, collapseShortStatements: false,
    collapseShortStatementsShorterThan: 78,
};
const vars: VariablesOptions = {
    declareAlignDataTypesAndValues: false,
    declareAddSpaceBetweenTypeAndPrecision: false,
    setPlaceAssignedValueOnNewLine: false,
    setPlaceEqualsSignOnNewLine: true,
};

function fmt(sql: string): string {
    const tokens = tokenize(sql);
    return applyStatementFormatting(tokens, ws, cf, vars);
}

// Test: two SET statements on one line → separated
const t1 = fmt('Set @x = 1 Set @y = 2');
console.assert(t1 === 'Set @x = 1\nSet @y = 2', 'two SETs separated: ' + JSON.stringify(t1));

// Test: statement inside parens NOT separated
const t2 = fmt('Set @x = (Select Count(*) From T)');
console.assert(!t2.includes('\nSelect'), 'subquery not separated: ' + JSON.stringify(t2));

// Test: GO gets empty line after
const t3 = fmt('Select 1\nGo\nSelect 2');
console.assert(t3.includes('Go\n\nSelect'), 'GO empty line: ' + JSON.stringify(t3));

// Test: SELECT followed by ORDER BY → NOT separated
const t4 = fmt('Select Col1 From T Order By Col1');
console.assert(!t4.includes('\nOrder'), 'ORDER BY not separated: ' + JSON.stringify(t4));

console.log('Statement separation tests: all passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ts-node test/statementRule.test.ts`
Expected: FAIL — `applyStatementFormatting` not found

- [ ] **Step 3: Implement statement separation**

Create `src/formatter/statementRule.ts`:

```typescript
import { Token } from './sqlTokenizer';
import { WhitespaceOptions, ControlFlowOptions, VariablesOptions } from './styleLoader';

const STATEMENT_STARTERS = new Set([
    'SET', 'IF', 'ELSE', 'WHILE', 'PRINT', 'EXEC', 'EXECUTE',
    'DECLARE', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE',
    'RETURN', 'THROW', 'RAISERROR', 'BEGIN', 'END',
    'GO', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
    'GRANT', 'DENY', 'REVOKE', 'USE', 'WAITFOR', 'WITH',
    'OPEN', 'CLOSE', 'FETCH', 'DEALLOCATE',
    'COMMIT', 'ROLLBACK', 'BREAK', 'CONTINUE', 'SAVE',
]);

// Keywords that continue a SELECT clause chain (not new statements)
const SELECT_CONTINUATIONS = new Set([
    'FROM', 'WHERE', 'HAVING', 'ORDER', 'GROUP', 'AND', 'OR', 'ON', 'INTO',
]);

export function applyStatementFormatting(
    tokens: Token[],
    ws: WhitespaceOptions,
    cf: ControlFlowOptions,
    vars: VariablesOptions,
): string {
    // Phase 1: Statement separation — insert newlines between statements
    const separated = separateStatements(tokens, ws);
    // Phase 2: Block indentation (Task 3)
    // Phase 3: Detail formatting (Task 4)
    return separated;
}

function separateStatements(tokens: Token[], ws: WhitespaceOptions): string {
    const parts: string[] = [];
    let depth = 0; // parenthesis depth
    let inString = false;
    let inComment = false;
    let inSelectChain = false;
    let prevStatementEnd = -1;

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];

        // Track parenthesis depth
        if (t.type === 'punctuation' && t.value === '(') depth++;
        if (t.type === 'punctuation' && t.value === ')') depth = Math.max(0, depth - 1);

        // Only detect boundaries at depth 0, outside strings/comments
        if (depth === 0 && t.type === 'keyword') {
            const upper = t.value.toUpperCase();

            if (upper === 'SELECT') {
                inSelectChain = true;
            }

            // Check if this is a continuation of SELECT chain
            if (inSelectChain && SELECT_CONTINUATIONS.has(upper)) {
                parts.push(t.value);
                continue;
            }

            // Compound: BEGIN TRY, BEGIN CATCH, END TRY, END CATCH
            if ((upper === 'BEGIN' || upper === 'END') && i + 1 < tokens.length) {
                let j = i + 1;
                while (j < tokens.length && tokens[j].type === 'whitespace') j++;
                if (j < tokens.length && tokens[j].type === 'keyword') {
                    const nextUpper = tokens[j].value.toUpperCase();
                    if (nextUpper === 'TRY' || nextUpper === 'CATCH') {
                        // This is BEGIN TRY / END TRY etc — treat as statement starter
                        if (inSelectChain) inSelectChain = false;
                        if (parts.length > 0 && !endsWithNewline(parts)) {
                            parts.push('\n');
                        }
                        parts.push(t.value);
                        continue;
                    }
                }
            }

            // GO — batch separator
            if (upper === 'GO') {
                inSelectChain = false;
                if (parts.length > 0 && !endsWithNewline(parts)) {
                    parts.push('\n');
                }
                parts.push(t.value);
                // Add empty lines after GO
                const emptyLines = '\n'.repeat(ws.emptyLinesAfterBatchSeparator + 1);
                parts.push(emptyLines);
                // Skip whitespace after GO
                while (i + 1 < tokens.length && tokens[i + 1].type === 'whitespace') i++;
                continue;
            }

            // Check for UPDATE ... SET (SET is continuation of UPDATE)
            if (upper === 'SET' && inUpdateContext(tokens, i)) {
                parts.push(t.value);
                continue;
            }

            // Statement starter detected
            if (STATEMENT_STARTERS.has(upper)) {
                if (upper !== 'SELECT' && upper !== 'FROM' && upper !== 'WHERE') {
                    inSelectChain = false;
                }
                // Insert newline before this statement if not at start
                if (parts.length > 0 && !endsWithNewline(parts)) {
                    parts.push('\n');
                }
            }
        }

        parts.push(t.value);
    }

    return parts.join('');
}

function endsWithNewline(parts: string[]): boolean {
    for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p.trim() === '') {
            if (p.includes('\n')) return true;
            continue;
        }
        return p.endsWith('\n');
    }
    return true;
}

function inUpdateContext(tokens: Token[], setIndex: number): boolean {
    // Walk backwards to find if there's an UPDATE before any other statement starter
    for (let i = setIndex - 1; i >= 0; i--) {
        if (tokens[i].type !== 'keyword') continue;
        const upper = tokens[i].value.toUpperCase();
        if (upper === 'UPDATE') return true;
        if (STATEMENT_STARTERS.has(upper) && upper !== 'UPDATE') return false;
    }
    return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ts-node test/statementRule.test.ts`
Expected: All assertions pass

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: Success

- [ ] **Step 6: Commit**

```bash
git add src/formatter/statementRule.ts test/statementRule.test.ts
git commit -m "feat(formatter): Layer 2 — statement separation"
```

---

## Task 3: Block Indentation (Layer 1)

**Files:**
- Modify: `src/formatter/statementRule.ts`
- Modify: `test/statementRule.test.ts`

- [ ] **Step 1: Write failing tests for block indentation**

Add to `test/statementRule.test.ts`:

```typescript
// Test: simple BEGIN/END → contents indented
const t5 = fmt('Begin\nSet @x = 1\nEnd');
console.assert(t5.includes('    Set @x = 1'), 'BEGIN/END indent: ' + JSON.stringify(t5));

// Test: nested BEGIN TRY/CATCH
const t6 = fmt('Begin\nBegin Try\nSet @x = 1\nEnd Try\nBegin Catch\nPrint @e\nEnd Catch\nEnd');
console.assert(t6.includes('        Set @x = 1'), 'nested TRY indent (depth 2): ' + JSON.stringify(t6));
console.assert(t6.includes('    Begin Try'), 'BEGIN TRY at depth 1: ' + JSON.stringify(t6));

// Test: IF without BEGIN → single statement indented
const t7 = fmt('If @x = 1\nSet @y = 2\nSet @z = 3');
console.assert(t7.includes('    Set @y = 2'), 'IF single body indented: ' + JSON.stringify(t7));
console.assert(!t7.includes('    Set @z = 3'), 'after IF body not indented: ' + JSON.stringify(t7));

// Test: IF ... BEGIN on same line
const t8 = fmt('If @x = 1 Begin\nSet @y = 2\nEnd');
console.assert(t8.includes('    Set @y = 2'), 'IF BEGIN indent: ' + JSON.stringify(t8));

// Test: ELSE without BEGIN
const t9 = fmt('If @x = 1\nSet @y = 2\nElse\nSet @y = 3\nSet @z = 4');
console.assert(t9.includes('    Set @y = 3'), 'ELSE body indented: ' + JSON.stringify(t9));
console.assert(!t9.includes('    Set @z = 4'), 'after ELSE not indented: ' + JSON.stringify(t9));

console.log('Block indentation tests: all passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ts-node test/statementRule.test.ts`
Expected: Indentation assertions FAIL

- [ ] **Step 3: Implement block indentation**

Add `applyBlockIndentation()` to `statementRule.ts` and call it from `applyStatementFormatting` after `separateStatements`:

The algorithm:
1. Split the separated string into lines
2. For each line, determine keywords present (BEGIN, END, IF, ELSE, WHILE, etc.)
3. Track depth with a stack
4. Handle: BEGIN → push, END → pop, IF/ELSE/WHILE without BEGIN → pendingSingleIndent flag
5. Apply `depth * indentUnit` spaces prefix to each line
6. Return re-joined string

```typescript
function applyBlockIndentation(text: string, ws: WhitespaceOptions, cf: ControlFlowOptions): string {
    const indentUnit = ws.numberOfSpacesInTabs;
    const lines = text.split('\n');
    const result: string[] = [];
    let depth = 0;
    let pendingSingleIndent = false; // for IF/ELSE without BEGIN

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) { result.push(''); continue; }

        const upperTrimmed = trimmed.toUpperCase();
        const firstWord = upperTrimmed.split(/\s/)[0];

        // Detect block closers — reduce depth BEFORE applying
        if (firstWord === 'END') {
            if (pendingSingleIndent) pendingSingleIndent = false;
            depth = Math.max(0, depth - 1);
        }

        // If we had a pending single indent (IF/ELSE without BEGIN), apply it
        let lineDepth = depth;
        if (pendingSingleIndent) {
            lineDepth = depth + 1;
            pendingSingleIndent = false; // consumed
        }

        // Apply indent
        const indent = ' '.repeat(lineDepth * indentUnit);
        result.push(indent + trimmed);

        // Detect block openers — increase depth AFTER applying
        if (upperTrimmed.endsWith('BEGIN') || firstWord === 'BEGIN') {
            // Check if it's BEGIN TRY or BEGIN CATCH (compound)
            if (upperTrimmed === 'BEGIN TRY' || upperTrimmed === 'BEGIN CATCH'
                || upperTrimmed.startsWith('BEGIN') && !upperTrimmed.includes(' TRY') && !upperTrimmed.includes(' CATCH')) {
                depth++;
            }
            if (upperTrimmed === 'BEGIN TRY' || upperTrimmed === 'BEGIN CATCH') {
                depth++;
            }
        }

        // IF/ELSE/WHILE without BEGIN → next statement gets +1 indent
        if ((firstWord === 'IF' || firstWord === 'ELSE' || firstWord === 'WHILE')
            && !upperTrimmed.includes('BEGIN')) {
            pendingSingleIndent = true;
        }
    }

    return result.join('\n');
}
```

Note: This is a simplified starting implementation. The actual BEGIN detection needs to be careful about `IF @x = 1 Begin` (BEGIN at end of line) vs `Begin` on its own line. Iterate on edge cases with tests.

- [ ] **Step 4: Run tests**

Run: `npx ts-node test/statementRule.test.ts`
Expected: All assertions pass (iterate on implementation if some fail)

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: Success

- [ ] **Step 6: Commit**

```bash
git add src/formatter/statementRule.ts test/statementRule.test.ts
git commit -m "feat(formatter): Layer 1 — block indentation (BEGIN/END, IF/ELSE, TRY/CATCH)"
```

---

## Task 4: Detail Formatting (Layer 3) — EXEC, DECLARE, String Concat

**Files:**
- Modify: `src/formatter/statementRule.ts`
- Modify: `test/statementRule.test.ts`

- [ ] **Step 1: Write failing tests for EXEC wrapping**

```typescript
// EXEC with 2 params → single line
const e1 = fmt('Exec dbo.SpName @P1 = 1, @P2 = 2');
console.assert(!e1.includes('\n'), 'EXEC 2 params single line: ' + JSON.stringify(e1));

// EXEC with 5 params → wrapped (use short maxLineLength for test)
const wsShort = { ...ws, wrapLinesLongerThan: 50 };
function fmtShort(sql: string): string {
    const tokens = tokenize(sql);
    return applyStatementFormatting(tokens, wsShort, cf, vars);
}
const e2 = fmtShort('Exec dbo.SpName @P1 = 1, @P2 = 2, @P3 = 3, @P4 = 4, @P5 = 5');
console.assert(e2.includes(', @P3'), 'EXEC wrapped: ' + JSON.stringify(e2));
```

- [ ] **Step 2: Write failing tests for DECLARE formatting**

```typescript
// DECLARE merged — comma alignment
const d1 = fmt('Declare @x Int, @y NVarchar(50), @z DateTime');
console.assert(d1.includes('      , @y'), 'DECLARE comma alignment: ' + JSON.stringify(d1));
```

- [ ] **Step 3: Write failing tests for string concat**

```typescript
// String concat short → single line
const s1 = fmt("Print N'hello ' + @name");
console.assert(!s1.includes('\n'), 'short concat single line: ' + JSON.stringify(s1));

// String concat long → wrapped
const s2 = fmtShort("Set @x = @y + N'very long string that exceeds max line length absolutely'");
console.assert(s2.includes('\n'), 'long concat wrapped: ' + JSON.stringify(s2));
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx ts-node test/statementRule.test.ts`
Expected: New assertions FAIL

- [ ] **Step 5: Implement EXEC parameter wrapping**

Add `formatExecParams()` to `statementRule.ts`:

- After statement separation, find EXEC lines
- Count params (split on `,` at depth 0)
- If < 3 and fits in maxLineLength → leave
- Otherwise: keep first params on EXEC line up to maxLineLength, wrap rest with comma-before aligned to `Exec dbo.SpName ` width

- [ ] **Step 6: Implement DECLARE comma alignment**

Add `formatDeclare()`:

- Detect merged DECLARE (multiple variables in one DECLARE)
- Split on commas at depth 0
- First variable on DECLARE line
- Subsequent: `'      , '` + variable (6 spaces + comma + space = 8 chars = `Declare ` width)

- [ ] **Step 7: Implement string concat wrapping**

Add `formatStringConcat()`:

- Find `SET @var = expr + expr` patterns where line > maxLineLength
- Break at `+` operators
- Align `+` to the right-hand-side start column (position after `= `)

- [ ] **Step 8: Run all tests**

Run: `npx ts-node test/statementRule.test.ts`
Expected: All pass

- [ ] **Step 9: Build**

Run: `npm run build`
Expected: Success

- [ ] **Step 10: Commit**

```bash
git add src/formatter/statementRule.ts test/statementRule.test.ts
git commit -m "feat(formatter): Layer 3 — EXEC wrapping, DECLARE alignment, string concat"
```

---

## Task 5: Pipeline Integration

**Files:**
- Modify: `src/formatter/sqlFormatter.ts`
- Modify: `src/formatter/layoutRule.ts` (remove blank-line normalization)

- [ ] **Step 1: Update sqlFormatter.ts pipeline**

```typescript
import { tokenize, Token } from './sqlTokenizer';
import { applyCasingInPlace } from './casingRule';
import { applyLayout } from './layoutRule';
import { applyCaseFormatting } from './caseRule';
import { applyStatementFormatting } from './statementRule';
import { StyleLoader } from './styleLoader';

export class SqlFormatter {
    constructor(private styleLoader: StyleLoader) {}

    format(sql: string): string {
        const tokens = tokenize(sql);
        applyCasingInPlace(tokens, this.styleLoader.getCasingOptions());
        SqlFormatter.applyCreateOrAlter(tokens);

        // NEW: statement formatting (separation + indentation + detail)
        const statementResult = applyStatementFormatting(
            tokens,
            this.styleLoader.getWhitespaceOptions(),
            this.styleLoader.getControlFlowOptions(),
            this.styleLoader.getVariablesOptions(),
        );

        // Re-tokenize for layout (SELECT clause formatting)
        const layoutTokens = tokenize(statementResult);
        const layoutResult = applyLayout(layoutTokens, this.styleLoader.getLayoutOptions());

        // Re-tokenize for CASE formatting
        const casedTokens = tokenize(layoutResult);
        return applyCaseFormatting(layoutResult, this.styleLoader.getCaseOptions(), casedTokens);
    }

    // ... existing applyCreateOrAlter stays as-is
}
```

- [ ] **Step 2: Remove blank-line normalization from layoutRule.ts**

In `layoutRule.ts` line 109, change:
```typescript
return results.join('').replace(/\n{3,}/g, '\n\n').replace(/\n\n(Go\b)/gi, '\n$1');
```
to:
```typescript
return results.join('');
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: Success

- [ ] **Step 4: Run ALL existing tests**

Run: `npm test`
Expected: All existing tests still pass (casing, layout, CASE formatting)

- [ ] **Step 5: Commit**

```bash
git add src/formatter/sqlFormatter.ts src/formatter/layoutRule.ts
git commit -m "feat(formatter): integrate statementRule into formatting pipeline"
```

---

## Task 6: Integration Test — Full SP

**Files:**
- Modify: `test/statementRule.test.ts`

- [ ] **Step 1: Add full SP integration test**

Use the user's before/after SP example as a test case. Input: crammed single-line version. Expected: properly formatted with indentation, statement separation, EXEC wrapping.

```typescript
// Integration test: full SP formatting
const spInput = `Begin Begin Try Declare @x Int Set @x = 1 If @x = 0 Begin Print 'zero' End End Try Begin Catch Print ERROR_MESSAGE() End Catch End`;
const spResult = fmt(spInput);
// Verify key formatting properties
console.assert(spResult.includes('    Begin Try'), 'SP: BEGIN TRY indented');
console.assert(spResult.includes('        Declare @x Int'), 'SP: DECLARE at depth 2');
console.assert(spResult.includes('        Set @x = 1'), 'SP: SET at depth 2');
console.assert(spResult.includes('            Print'), 'SP: PRINT inside IF BEGIN at depth 3');
console.assert(spResult.includes('    Begin Catch'), 'SP: BEGIN CATCH at depth 1');
console.assert(spResult.includes('End'), 'SP: outer END at depth 0');

console.log('Integration test: passed');
```

- [ ] **Step 2: Run test**

Run: `npx ts-node test/statementRule.test.ts`
Expected: All pass

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add test/statementRule.test.ts
git commit -m "test(formatter): add full SP integration test for statement formatting"
```

---

## Task 7: Style Form UI — Whitespace/ControlFlow/Variables Sections

**Files:**
- Modify: `src/providers/styleFormProvider.ts`
- Modify: `src/providers/styleFormTranslations.ts`

This task adds the Whitespace, Control Flow, and Variables config sections to the SQL Prompt Options webview panel, so users can configure the new formatting options from the UI.

- [ ] **Step 1: Add sidebar menu items for Whitespace, Control Flow, Variables under Format group**

In `styleFormProvider.ts`, add the new menu items within the Format section-group, before the existing sub-titles for Statements/Clauses/Expressions.

- [ ] **Step 2: Add section HTML for each new config area**

Each section has form rows with checkboxes, dropdowns, and number inputs matching the Redgate SQL Prompt UI screenshots.

- [ ] **Step 3: Add translations for new UI strings**

Add English and Turkish translations for all new labels in `styleFormTranslations.ts`.

- [ ] **Step 4: Wire up save/load to StyleLoader**

The save handler collects the new config values and passes them to `styleLoader.applyOverrides()`. The load handler populates the form from the loaded style.

- [ ] **Step 5: Build and test**

Run: `npm run build && npm test`
Expected: Success

- [ ] **Step 6: Commit**

```bash
git add src/providers/styleFormProvider.ts src/providers/styleFormTranslations.ts
git commit -m "feat(ui): add Whitespace, Control Flow, Variables sections to SQL Prompt Options"
```
