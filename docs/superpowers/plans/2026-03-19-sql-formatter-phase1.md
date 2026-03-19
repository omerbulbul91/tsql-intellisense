# SQL Formatter Faz 1 (Casing) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redgate SQL Prompt stil dosyası desteğiyle SQL casing formatlaması (keyword, function, datatype).

**Architecture:** Tokenizer SQL metni token dizisine ayırır, casingRule stil dosyasına göre casing uygular, formatterProvider VS Code API'ye bağlar. StyleLoader snippetProvider ile aynı pattern'i izler.

**Tech Stack:** TypeScript, VS Code Extension API (DocumentFormattingEditProvider, DocumentRangeFormattingEditProvider), esbuild bundler.

**Spec:** `docs/superpowers/specs/2026-03-19-sql-formatter-design.md`

---

## Chunk 1: Tokenizer + Casing Rule + Tests

### Task 1: SQL Tokenizer — Test Dosyası

**Files:**
- Create: `test/formatter.test.ts`

- [ ] **Step 1: Write tokenizer test file**

```typescript
// test/formatter.test.ts
import { tokenize, Token, TokenType } from '../src/formatter/sqlTokenizer';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${testName}`);
    } else {
        failed++;
        console.error(`  ❌ ${testName}`);
    }
}

function assertTokenTypes(sql: string, expected: TokenType[], testName: string) {
    const tokens = tokenize(sql).filter(t => t.type !== 'whitespace');
    const types = tokens.map(t => t.type);
    assert(
        JSON.stringify(types) === JSON.stringify(expected),
        `${testName} — got [${types}]`
    );
}

function assertTokenValues(sql: string, expected: string[], testName: string) {
    const tokens = tokenize(sql).filter(t => t.type !== 'whitespace');
    const values = tokens.map(t => t.value);
    assert(
        JSON.stringify(values) === JSON.stringify(expected),
        `${testName} — got [${values}]`
    );
}

console.log('\n=== Tokenizer Tests ===\n');

// --- Basic keyword detection ---
assertTokenTypes('SELECT * FROM T', ['keyword', 'operator', 'keyword', 'identifier'], 'keywords and identifier');
assertTokenTypes('select * from T', ['keyword', 'operator', 'keyword', 'identifier'], 'lowercase keywords');

// --- Function detection ---
assertTokenTypes('COUNT(ID)', ['function', 'punctuation', 'identifier', 'punctuation'], 'function token');
assertTokenTypes('GETDATE()', ['function', 'punctuation', 'punctuation'], 'function no args');

// --- Datatype detection ---
assertTokenTypes('DECLARE @x INT', ['keyword', 'identifier', 'datatype'], 'datatype token');
assertTokenTypes('CAST(x AS VARCHAR)', ['function', 'punctuation', 'identifier', 'keyword', 'datatype', 'punctuation'], 'CAST with datatype');

// --- String literals ---
assertTokenTypes("SELECT 'hello'", ['keyword', 'string'], 'string literal');
assertTokenTypes("SELECT N'unicode'", ['keyword', 'string'], 'N-prefixed string');
assertTokenTypes("SELECT ''''", ['keyword', 'string'], 'escaped quote string');
assertTokenTypes("SELECT 'it''s'", ['keyword', 'string'], 'escaped quote mid-string');

// --- Comments ---
assertTokenTypes('SELECT -- comment\n1', ['keyword', 'comment', 'number'], 'line comment');
assertTokenTypes('SELECT /* block */ 1', ['keyword', 'comment', 'number'], 'block comment');
assertTokenTypes('/* multi\nline\ncomment */', ['comment'], 'multiline block comment');

// --- Bracketed identifiers ---
assertTokenTypes('SELECT [select] FROM [from]', ['keyword', 'identifier', 'keyword', 'identifier'], 'bracketed identifiers');

// --- Numbers ---
assertTokenTypes('WHERE x = 42', ['keyword', 'identifier', 'operator', 'number'], 'integer');
assertTokenTypes('WHERE x = 3.14', ['keyword', 'identifier', 'operator', 'number'], 'decimal number');
assertTokenTypes('WHERE x = 0x1F', ['keyword', 'identifier', 'operator', 'number'], 'hex number');

// --- Operators ---
assertTokenTypes('a <> b', ['identifier', 'operator', 'identifier'], '<> operator');
assertTokenTypes('a >= b', ['identifier', 'operator', 'identifier'], '>= operator');
assertTokenTypes('a != b', ['identifier', 'operator', 'identifier'], '!= operator');

// --- Punctuation ---
assertTokenTypes('(a, b)', ['punctuation', 'identifier', 'punctuation', 'identifier', 'punctuation'], 'parens and comma');

// --- @@ system variables ---
assertTokenTypes('SELECT @@ROWCOUNT', ['keyword', 'function'], '@@ROWCOUNT as function');
assertTokenTypes('SELECT @@IDENTITY', ['keyword', 'function'], '@@IDENTITY as function');

// --- @ variables (not functions) ---
assertTokenTypes('SET @x = 1', ['keyword', 'identifier', 'operator', 'number'], '@variable as identifier');

// --- Offset tracking ---
{
    const tokens = tokenize('SELECT 1');
    assert(tokens[0].offset === 0, 'first token offset is 0');
    assert(tokens[0].value === 'SELECT', 'first token value');
}

// --- Roundtrip: tokens reconstruct original ---
{
    const sql = "SELECT t.[Name], COUNT(*) FROM dbo.Table1 t -- comment\nWHERE t.ID > 0";
    const tokens = tokenize(sql);
    const reconstructed = tokens.map(t => t.value).join('');
    assert(reconstructed === sql, 'roundtrip reconstruction');
}

console.log(`\nTokenizer: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ts-node test/formatter.test.ts`
Expected: FAIL — cannot find module `../src/formatter/sqlTokenizer`

---

### Task 2: SQL Tokenizer — Implementation

**Files:**
- Create: `src/formatter/sqlTokenizer.ts`

- [ ] **Step 3: Create the tokenizer**

```typescript
// src/formatter/sqlTokenizer.ts

export type TokenType =
    | 'keyword' | 'function' | 'datatype' | 'identifier'
    | 'string' | 'comment' | 'number' | 'operator'
    | 'punctuation' | 'whitespace';

export interface Token {
    type: TokenType;
    value: string;
    offset: number;
}

const KEYWORDS = new Set([
    'SELECT', 'FROM', 'WHERE', 'JOIN', 'ON', 'AND', 'OR', 'NOT', 'IN', 'EXISTS',
    'BETWEEN', 'LIKE', 'IS', 'NULL', 'AS', 'BY', 'ORDER', 'GROUP', 'HAVING',
    'DISTINCT', 'TOP', 'INTO', 'VALUES', 'UNION', 'ALL', 'ANY', 'SOME',
    'CROSS', 'FULL', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'WITH', 'OVER', 'PARTITION',
    'INSERT', 'UPDATE', 'DELETE', 'SET', 'EXEC', 'EXECUTE',
    'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
    'DECLARE', 'BEGIN', 'END', 'IF', 'ELSE', 'WHILE', 'RETURN', 'BREAK', 'CONTINUE',
    'TRY', 'CATCH', 'THROW', 'RAISERROR',
    'CASE', 'WHEN', 'THEN',
    'GO', 'PRINT', 'USE',
    'TRANSACTION', 'COMMIT', 'ROLLBACK', 'SAVE',
    'PROCEDURE', 'PROC', 'FUNCTION', 'TABLE', 'VIEW', 'INDEX', 'TRIGGER',
    'DATABASE', 'SCHEMA',
    'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT', 'DEFAULT', 'CHECK', 'UNIQUE',
    'CLUSTERED', 'NONCLUSTERED', 'ASC', 'DESC',
    'OUTPUT', 'RETURNS', 'READONLY',
    'PIVOT', 'UNPIVOT', 'EXCEPT', 'INTERSECT',
    'MERGE', 'MATCHED', 'SOURCE', 'TARGET',
    'GRANT', 'REVOKE', 'DENY',
    'CURSOR', 'OPEN', 'CLOSE', 'FETCH', 'NEXT', 'DEALLOCATE',
    'NOLOCK', 'HOLDLOCK', 'UPDLOCK', 'ROWLOCK', 'TABLOCK',
    'READUNCOMMITTED', 'READCOMMITTED',
    'OPTION', 'RECOMPILE', 'MAXDOP',
    'EXISTS', 'APPLY', 'TABLESAMPLE', 'PERCENT',
    'WAITFOR', 'DELAY', 'GOTO', 'LABEL',
    'TRAN', 'WORK', 'DISTRIBUTED',
    'IDENTITY', 'ROWGUIDCOL', 'NOT', 'FOR', 'AFTER', 'INSTEAD', 'OF',
    'ENABLE', 'DISABLE', 'REBUILD', 'REORGANIZE',
    'ADD', 'COLUMN', 'MODIFY', 'TYPE',
    'AUTHORIZATION', 'ENCRYPTION', 'ANSI_NULLS', 'QUOTED_IDENTIFIER',
    'NOCOUNT', 'XACT_ABORT', 'ARITHABORT', 'CONCAT_NULL_YIELDS_NULL',
]);

const FUNCTIONS = new Set([
    // Aggregate
    'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'STRING_AGG', 'CHECKSUM_AGG', 'COUNT_BIG',
    'STDEV', 'STDEVP', 'VAR', 'VARP',
    // Window
    'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'LAG', 'LEAD',
    'FIRST_VALUE', 'LAST_VALUE', 'PERCENT_RANK', 'CUME_DIST',
    // Conversion
    'CAST', 'CONVERT', 'TRY_CAST', 'TRY_CONVERT', 'PARSE', 'TRY_PARSE',
    // String
    'LEN', 'DATALENGTH', 'SUBSTRING', 'CHARINDEX', 'PATINDEX',
    'REPLACE', 'STUFF', 'TRIM', 'LTRIM', 'RTRIM', 'UPPER', 'LOWER', 'REVERSE',
    'REPLICATE', 'SPACE', 'CONCAT', 'CONCAT_WS', 'STRING_SPLIT', 'QUOTENAME',
    'CHAR', 'ASCII', 'UNICODE', 'NCHAR', 'FORMAT',
    // Date/Time
    'GETDATE', 'GETUTCDATE', 'SYSDATETIME', 'SYSUTCDATETIME',
    'DATEADD', 'DATEDIFF', 'DATEDIFF_BIG', 'DATENAME', 'DATEPART',
    'YEAR', 'MONTH', 'DAY', 'EOMONTH', 'DATEFROMPARTS', 'DATETIME2FROMPARTS',
    'ISDATE', 'SWITCHOFFSET', 'TODATETIMEOFFSET',
    // Math
    'ABS', 'CEILING', 'FLOOR', 'ROUND', 'POWER', 'SQRT', 'SIGN', 'LOG', 'LOG10', 'EXP',
    'RAND', 'PI', 'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'ATN2',
    // NULL handling
    'ISNULL', 'COALESCE', 'NULLIF', 'IIF', 'CHOOSE',
    // System
    'NEWID', 'NEWSEQUENTIALID', 'SCOPE_IDENTITY', 'IDENT_CURRENT',
    '@@IDENTITY', '@@ROWCOUNT', '@@ERROR', '@@TRANCOUNT',
    '@@FETCH_STATUS', '@@CURSOR_ROWS', '@@SPID', '@@SERVERNAME', '@@VERSION',
    'OBJECT_ID', 'OBJECT_NAME', 'OBJECT_DEFINITION', 'DB_ID', 'DB_NAME',
    'SCHEMA_ID', 'SCHEMA_NAME', 'TYPE_ID', 'TYPE_NAME',
    'COL_NAME', 'COL_LENGTH', 'COLUMNPROPERTY',
    'USER_NAME', 'SUSER_SNAME', 'SYSTEM_USER', 'SESSION_USER',
    'HOST_NAME', 'APP_NAME', 'ERROR_MESSAGE', 'ERROR_NUMBER', 'ERROR_SEVERITY',
    'ERROR_STATE', 'ERROR_LINE', 'ERROR_PROCEDURE',
    // JSON
    'JSON_VALUE', 'JSON_QUERY', 'JSON_MODIFY', 'ISJSON', 'OPENJSON',
    // XML
    'NODES', 'VALUE', 'QUERY', 'EXIST',
]);

// Words that are ONLY functions when followed by '(' — otherwise keyword
const AMBIGUOUS_FUNCTION_KEYWORDS = new Set([
    'LEFT', 'RIGHT',
]);

const DATATYPES = new Set([
    'INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'BIT',
    'DECIMAL', 'NUMERIC', 'FLOAT', 'REAL', 'MONEY', 'SMALLMONEY',
    'CHAR', 'VARCHAR', 'NCHAR', 'NVARCHAR', 'TEXT', 'NTEXT',
    'DATE', 'DATETIME', 'DATETIME2', 'SMALLDATETIME', 'TIME', 'DATETIMEOFFSET',
    'UNIQUEIDENTIFIER', 'XML', 'SQL_VARIANT',
    'BINARY', 'VARBINARY', 'IMAGE', 'TIMESTAMP', 'ROWVERSION',
    'GEOGRAPHY', 'GEOMETRY', 'HIERARCHYID',
    'SYSNAME',
]);

// Words that are both keyword and datatype — datatype takes priority (per spec)
const AMBIGUOUS_KEYWORD_DATATYPES = new Set(['CURSOR', 'TABLE']);

export function tokenize(sql: string): Token[] {
    const tokens: Token[] = [];
    let pos = 0;
    const len = sql.length;

    while (pos < len) {
        const ch = sql[pos];

        // 1. String: '...' or N'...'
        if (ch === "'" || (ch.toUpperCase() === 'N' && pos + 1 < len && sql[pos + 1] === "'")) {
            const start = pos;
            if (ch.toUpperCase() === 'N') pos++; // skip N
            pos++; // skip opening quote
            while (pos < len) {
                if (sql[pos] === "'" && pos + 1 < len && sql[pos + 1] === "'") {
                    pos += 2; // escaped quote
                } else if (sql[pos] === "'") {
                    pos++; // closing quote
                    break;
                } else {
                    pos++;
                }
            }
            tokens.push({ type: 'string', value: sql.slice(start, pos), offset: start });
            continue;
        }

        // 2. Line comment: --
        if (ch === '-' && pos + 1 < len && sql[pos + 1] === '-') {
            const start = pos;
            pos += 2;
            while (pos < len && sql[pos] !== '\n') pos++;
            if (pos < len) pos++; // include \n
            tokens.push({ type: 'comment', value: sql.slice(start, pos), offset: start });
            continue;
        }

        // 2b. Block comment: /* ... */
        if (ch === '/' && pos + 1 < len && sql[pos + 1] === '*') {
            const start = pos;
            pos += 2;
            while (pos < len) {
                if (sql[pos] === '*' && pos + 1 < len && sql[pos + 1] === '/') {
                    pos += 2;
                    break;
                }
                pos++;
            }
            tokens.push({ type: 'comment', value: sql.slice(start, pos), offset: start });
            continue;
        }

        // 3. Bracketed identifier: [...]
        if (ch === '[') {
            const start = pos;
            pos++;
            while (pos < len && sql[pos] !== ']') pos++;
            if (pos < len) pos++; // skip ]
            tokens.push({ type: 'identifier', value: sql.slice(start, pos), offset: start });
            continue;
        }

        // 4. Number: digits, hex
        if (/[0-9]/.test(ch) || (ch === '0' && pos + 1 < len && sql[pos + 1].toLowerCase() === 'x')) {
            const start = pos;
            if (ch === '0' && pos + 1 < len && sql[pos + 1].toLowerCase() === 'x') {
                pos += 2;
                while (pos < len && /[0-9a-fA-F]/.test(sql[pos])) pos++;
            } else {
                while (pos < len && /[0-9]/.test(sql[pos])) pos++;
                if (pos < len && sql[pos] === '.' && pos + 1 < len && /[0-9]/.test(sql[pos + 1])) {
                    pos++;
                    while (pos < len && /[0-9]/.test(sql[pos])) pos++;
                }
            }
            tokens.push({ type: 'number', value: sql.slice(start, pos), offset: start });
            continue;
        }

        // 5. Multi-char operators
        if (pos + 1 < len) {
            const two = sql.slice(pos, pos + 2);
            if (two === '<>' || two === '>=' || two === '<=' || two === '!=' || two === '+=') {
                tokens.push({ type: 'operator', value: two, offset: pos });
                pos += 2;
                continue;
            }
        }

        // 5b. Single-char operators
        if ('=<>+-*/%'.includes(ch)) {
            tokens.push({ type: 'operator', value: ch, offset: pos });
            pos++;
            continue;
        }

        // 6. Punctuation
        if ('(),;.'.includes(ch)) {
            tokens.push({ type: 'punctuation', value: ch, offset: pos });
            pos++;
            continue;
        }

        // 7. Whitespace
        if (/\s/.test(ch)) {
            const start = pos;
            while (pos < len && /\s/.test(sql[pos])) pos++;
            tokens.push({ type: 'whitespace', value: sql.slice(start, pos), offset: start });
            continue;
        }

        // 8. Word: identifier/keyword/function/datatype
        if (/[a-zA-Z_@#]/.test(ch)) {
            const start = pos;
            while (pos < len && /[a-zA-Z0-9_@#]/.test(sql[pos])) pos++;
            const word = sql.slice(start, pos);
            const upper = word.toUpperCase();

            let type: TokenType;
            if (FUNCTIONS.has(upper) && !AMBIGUOUS_FUNCTION_KEYWORDS.has(upper)) {
                type = 'function';
            } else if (AMBIGUOUS_FUNCTION_KEYWORDS.has(upper)) {
                // Resolved in post-processing pass
                type = 'keyword';
            } else if (DATATYPES.has(upper) && !AMBIGUOUS_KEYWORD_DATATYPES.has(upper)) {
                type = 'datatype';
            } else if (AMBIGUOUS_KEYWORD_DATATYPES.has(upper)) {
                type = 'datatype'; // CURSOR, TABLE — datatype priority per spec
            } else if (KEYWORDS.has(upper)) {
                type = 'keyword';
            } else {
                type = 'identifier';
            }

            tokens.push({ type, value: word, offset: start });
            continue;
        }

        // Unknown character — emit as punctuation
        tokens.push({ type: 'punctuation', value: ch, offset: pos });
        pos++;
    }

    // Post-processing: disambiguate words that are both function and keyword
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type !== 'keyword') continue;
        const upper = t.value.toUpperCase();
        if (!AMBIGUOUS_FUNCTION_KEYWORDS.has(upper)) continue;

        // Look ahead for '(' — skip whitespace
        let next: Token | undefined;
        for (let j = i + 1; j < tokens.length; j++) {
            if (tokens[j].type !== 'whitespace') { next = tokens[j]; break; }
        }
        if (next && next.type === 'punctuation' && next.value === '(') {
            t.type = 'function';
        }
        // else remains keyword
    }

    return tokens;
}

export { KEYWORDS, FUNCTIONS, DATATYPES };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx ts-node test/formatter.test.ts`
Expected: All tokenizer tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/formatter/sqlTokenizer.ts test/formatter.test.ts
git commit -m "feat(formatter): add SQL tokenizer with keyword/function/datatype classification"
```

---

### Task 3: Casing Rule — Tests + Implementation

**Files:**
- Modify: `test/formatter.test.ts` (append casing tests)
- Create: `src/formatter/casingRule.ts`

- [ ] **Step 6: Append casing tests to formatter.test.ts**

Add the following after the tokenizer tests section:

```typescript
import { applyCasing, CasingMode } from '../src/formatter/casingRule';

// Reset counters for this section
let casingPassed = 0;
let casingFailed = 0;

function assertCasing(input: string, expected: string, keywordMode: CasingMode, functionMode: CasingMode, datatypeMode: CasingMode, testName: string) {
    const tokens = tokenize(input);
    const result = applyCasing(tokens, { reservedKeywords: keywordMode, builtInFunctions: functionMode, builtInDataTypes: datatypeMode });
    if (result === expected) {
        casingPassed++;
        console.log(`  ✅ ${testName}`);
    } else {
        casingFailed++;
        console.error(`  ❌ ${testName} — expected "${expected}", got "${result}"`);
    }
}

console.log('\n=== Casing Rule Tests ===\n');

// --- uppercase ---
assertCasing('select * from T', 'SELECT * FROM T', 'uppercase', 'uppercase', 'uppercase', 'keywords to uppercase');
assertCasing('Select From', 'SELECT FROM', 'uppercase', 'uppercase', 'uppercase', 'mixed case keywords to uppercase');

// --- lowercase ---
assertCasing('SELECT * FROM T', 'select * from T', 'lowercase', 'lowercase', 'lowercase', 'keywords to lowercase');

// --- upperCamelCase ---
assertCasing('SELECT * FROM T', 'Select * From T', 'upperCamelCase', 'uppercase', 'upperCamelCase', 'keywords to upperCamelCase');
assertCasing('select * from T', 'Select * From T', 'upperCamelCase', 'uppercase', 'upperCamelCase', 'lowercase keywords to upperCamelCase');
assertCasing('ORDER BY col', 'Order By col', 'upperCamelCase', 'uppercase', 'upperCamelCase', 'multi-word keyword upperCamelCase');

// --- leaveAsIs ---
assertCasing('select FROM Where', 'select FROM Where', 'leaveAsIs', 'leaveAsIs', 'leaveAsIs', 'leaveAsIs no change');

// --- Function casing ---
assertCasing('select count(id) from T', 'Select COUNT(id) From T', 'upperCamelCase', 'uppercase', 'upperCamelCase', 'function uppercase');
assertCasing('select GETDATE()', 'Select GETDATE()', 'upperCamelCase', 'uppercase', 'upperCamelCase', 'function already uppercase');

// --- Datatype casing ---
assertCasing('declare @x int', 'Declare @x Int', 'upperCamelCase', 'uppercase', 'upperCamelCase', 'datatype upperCamelCase');
assertCasing('cast(x as varchar)', 'CAST(x As Varchar)', 'upperCamelCase', 'uppercase', 'upperCamelCase', 'CAST uppercase + datatype upperCamelCase');

// --- String/comment protection ---
assertCasing("select 'select from'", "Select 'select from'", 'upperCamelCase', 'uppercase', 'upperCamelCase', 'string content untouched');
assertCasing('select -- select from\n1', 'Select -- select from\n1', 'upperCamelCase', 'uppercase', 'upperCamelCase', 'comment content untouched');
assertCasing('select /* select */ 1', 'Select /* select */ 1', 'upperCamelCase', 'uppercase', 'upperCamelCase', 'block comment untouched');

// --- Bracketed identifier protection ---
assertCasing('select [select] from T', 'Select [select] From T', 'upperCamelCase', 'uppercase', 'upperCamelCase', 'bracketed identifier untouched');

// --- Identifier protection ---
assertCasing('select CustomerName from T', 'Select CustomerName From T', 'upperCamelCase', 'uppercase', 'upperCamelCase', 'identifier case preserved');

// --- LEFT/RIGHT disambiguation ---
assertCasing('left join T on', 'Left Join T On', 'upperCamelCase', 'uppercase', 'upperCamelCase', 'LEFT as keyword');
assertCasing("left('abc', 2)", "LEFT('abc', 2)", 'upperCamelCase', 'uppercase', 'upperCamelCase', 'LEFT as function');

// --- @@ system variables ---
assertCasing('select @@rowcount', 'Select @@ROWCOUNT', 'upperCamelCase', 'uppercase', 'upperCamelCase', '@@ROWCOUNT function casing');

// --- Roundtrip whitespace preservation ---
assertCasing('  select  *  from  T  ', '  Select  *  From  T  ', 'upperCamelCase', 'uppercase', 'upperCamelCase', 'whitespace preserved');

console.log(`\nCasing: ${casingPassed} passed, ${casingFailed} failed\n`);
if (casingFailed > 0) process.exit(1);
```

- [ ] **Step 7: Run test to verify casing tests fail**

Run: `npx ts-node test/formatter.test.ts`
Expected: Tokenizer tests pass, casing tests FAIL — cannot find module `casingRule`

- [ ] **Step 8: Implement casingRule.ts**

```typescript
// src/formatter/casingRule.ts

import { Token } from './sqlTokenizer';

export type CasingMode = 'uppercase' | 'lowercase' | 'upperCamelCase' | 'leaveAsIs';

export interface CasingOptions {
    reservedKeywords: CasingMode;
    builtInFunctions: CasingMode;
    builtInDataTypes: CasingMode;
}

function applyMode(value: string, mode: CasingMode): string {
    switch (mode) {
        case 'uppercase': return value.toUpperCase();
        case 'lowercase': return value.toLowerCase();
        case 'upperCamelCase': return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
        case 'leaveAsIs': return value;
    }
}

export function applyCasing(tokens: Token[], options: CasingOptions): string {
    return tokens.map(token => {
        switch (token.type) {
            case 'keyword':
                return applyMode(token.value, options.reservedKeywords);
            case 'function':
                return applyMode(token.value, options.builtInFunctions);
            case 'datatype':
                return applyMode(token.value, options.builtInDataTypes);
            default:
                return token.value;
        }
    }).join('');
}
```

- [ ] **Step 9: Run tests to verify all pass**

Run: `npx ts-node test/formatter.test.ts`
Expected: All tokenizer + casing tests PASS

- [ ] **Step 10: Commit**

```bash
git add src/formatter/casingRule.ts test/formatter.test.ts
git commit -m "feat(formatter): add casing rule engine with uppercase/lowercase/upperCamelCase support"
```

---

## Chunk 2: Style Loader + Formatter + VS Code Integration

### Task 4: Style Loader

**Files:**
- Create: `src/formatter/styleLoader.ts`

- [ ] **Step 11: Implement styleLoader.ts**

```typescript
// src/formatter/styleLoader.ts

import * as fs from 'fs';
import * as path from 'path';
import { CasingOptions, CasingMode } from './casingRule';

export interface SqlStyle {
    metadata?: { id?: string; name?: string };
    casing?: {
        reservedKeywords?: string;
        builtInFunctions?: string;
        builtInDataTypes?: string;
        useObjectDefinitionCase?: boolean;
    };
}

const DEFAULT_STYLE: CasingOptions = {
    reservedKeywords: 'upperCamelCase',
    builtInFunctions: 'uppercase',
    builtInDataTypes: 'upperCamelCase',
};

const VALID_MODES: Set<string> = new Set(['uppercase', 'lowercase', 'upperCamelCase', 'leaveAsIs']);

function validateMode(value: string | undefined, fallback: CasingMode): CasingMode {
    if (value && VALID_MODES.has(value)) return value as CasingMode;
    return fallback;
}

export class StyleLoader {
    private options: CasingOptions = { ...DEFAULT_STYLE };
    private styleName: string = 'RENIUMSTYLE (default)';

    constructor(private outputChannel?: { appendLine(msg: string): void }) {}

    async loadFromFolder(folderPath: string): Promise<void> {
        if (!folderPath) {
            this.options = { ...DEFAULT_STYLE };
            this.styleName = 'RENIUMSTYLE (default)';
            this.log(`No style folder configured — using default RENIUMSTYLE`);
            return;
        }

        try {
            const files = await fs.promises.readdir(folderPath);
            const jsonFiles = files.filter(f => f.endsWith('.json')).sort();

            if (jsonFiles.length === 0) {
                this.log(`No .json files found in ${folderPath} — using default`);
                this.options = { ...DEFAULT_STYLE };
                this.styleName = 'RENIUMSTYLE (default)';
                return;
            }

            const filePath = path.join(folderPath, jsonFiles[0]);
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const style: SqlStyle = JSON.parse(content);

            this.styleName = style.metadata?.name || jsonFiles[0];
            if (style.casing) {
                this.options = {
                    reservedKeywords: validateMode(style.casing.reservedKeywords, DEFAULT_STYLE.reservedKeywords),
                    builtInFunctions: validateMode(style.casing.builtInFunctions, DEFAULT_STYLE.builtInFunctions),
                    builtInDataTypes: validateMode(style.casing.builtInDataTypes, DEFAULT_STYLE.builtInDataTypes),
                };
            } else {
                this.log(`Style "${this.styleName}" has no casing section — using default`);
                this.options = { ...DEFAULT_STYLE };
            }

            this.log(`Loaded style "${this.styleName}" from ${filePath}`);
            this.log(`  keywords: ${this.options.reservedKeywords}, functions: ${this.options.builtInFunctions}, datatypes: ${this.options.builtInDataTypes}`);
        } catch (err: any) {
            this.log(`Error loading style from ${folderPath}: ${err.message} — using default`);
            this.options = { ...DEFAULT_STYLE };
            this.styleName = 'RENIUMSTYLE (default)';
        }
    }

    getCasingOptions(): CasingOptions { return this.options; }
    getStyleName(): string { return this.styleName; }

    private log(msg: string) {
        this.outputChannel?.appendLine(msg);
    }
}
```

- [ ] **Step 12: Commit**

```bash
git add src/formatter/styleLoader.ts
git commit -m "feat(formatter): add style loader with folder-based JSON reading"
```

---

### Task 5: SQL Formatter Orchestrator

**Files:**
- Create: `src/formatter/sqlFormatter.ts`

- [ ] **Step 13: Implement sqlFormatter.ts**

```typescript
// src/formatter/sqlFormatter.ts

import { tokenize } from './sqlTokenizer';
import { applyCasing } from './casingRule';
import { StyleLoader } from './styleLoader';

export class SqlFormatter {
    constructor(private styleLoader: StyleLoader) {}

    format(sql: string): string {
        const tokens = tokenize(sql);
        const options = this.styleLoader.getCasingOptions();
        return applyCasing(tokens, options);
    }
}
```

- [ ] **Step 14: Commit**

```bash
git add src/formatter/sqlFormatter.ts
git commit -m "feat(formatter): add SqlFormatter orchestrator"
```

---

### Task 6: VS Code Formatter Provider

**Files:**
- Create: `src/providers/formatterProvider.ts`

- [ ] **Step 15: Implement formatterProvider.ts**

```typescript
// src/providers/formatterProvider.ts

import * as vscode from 'vscode';
import { SqlFormatter } from '../formatter/sqlFormatter';
import { StyleLoader } from '../formatter/styleLoader';

export class FormatterProvider implements vscode.DocumentFormattingEditProvider, vscode.DocumentRangeFormattingEditProvider {
    private formatter: SqlFormatter;

    constructor(private styleLoader: StyleLoader) {
        this.formatter = new SqlFormatter(styleLoader);
    }

    provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
        );
        const formatted = this.formatter.format(document.getText());
        return [vscode.TextEdit.replace(fullRange, formatted)];
    }

    provideDocumentRangeFormattingEdits(document: vscode.TextDocument, range: vscode.Range): vscode.TextEdit[] {
        const text = document.getText(range);
        const formatted = this.formatter.format(text);
        return [vscode.TextEdit.replace(range, formatted)];
    }

    formatActiveEditor(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const document = editor.document;
        const selection = editor.selection;

        editor.edit(editBuilder => {
            if (selection.isEmpty) {
                // Format entire document
                const fullRange = new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(document.getText().length)
                );
                const formatted = this.formatter.format(document.getText());
                editBuilder.replace(fullRange, formatted);
            } else {
                // Format selection
                const text = document.getText(selection);
                const formatted = this.formatter.format(text);
                editBuilder.replace(selection, formatted);
            }
        });
    }
}
```

- [ ] **Step 16: Commit**

```bash
git add src/providers/formatterProvider.ts
git commit -m "feat(formatter): add VS Code formatting provider with selection support"
```

---

### Task 7: Extension Registration

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 17: Add imports and registration to extension.ts**

Add imports at top of file:
```typescript
import { StyleLoader } from './formatter/styleLoader';
import { FormatterProvider } from './providers/formatterProvider';
```

Add after snippet provider registration (around line 202), before the closing of `activate()`:
```typescript
    // ── SQL Formatter (style-based casing) ──
    const styleOutputChannel = vscode.window.createOutputChannel('T-SQL Formatter');
    const styleLoader = new StyleLoader(styleOutputChannel);
    const styleFolder = vscode.workspace.getConfiguration('tsql-intellisense').get<string>('styleFolder', '');
    await styleLoader.loadFromFolder(styleFolder);

    const formatterProvider = new FormatterProvider(styleLoader);
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider({ language: 'sql', scheme: '*' }, formatterProvider),
        vscode.languages.registerDocumentRangeFormattingEditProvider({ language: 'sql', scheme: '*' }, formatterProvider)
    );

    // Ctrl+K Y — format SQL
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.formatSql', () => {
            formatterProvider.formatActiveEditor();
        })
    );

    // Set Style Folder command
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.setStyleFolder', async () => {
            const current = vscode.workspace.getConfiguration('tsql-intellisense').get<string>('styleFolder', '');
            const result = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Stil Dizini Seç',
                defaultUri: current ? vscode.Uri.file(current) : undefined
            });
            if (result && result[0]) {
                await vscode.workspace.getConfiguration('tsql-intellisense').update('styleFolder', result[0].fsPath, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Stil dizini ayarlandı: ${result[0].fsPath}`);
            }
        })
    );

    // Reload style on config change
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('tsql-intellisense.styleFolder')) {
                const folder = vscode.workspace.getConfiguration('tsql-intellisense').get<string>('styleFolder', '');
                styleLoader.loadFromFolder(folder);
            }
        })
    );
```

- [ ] **Step 18: Commit**

```bash
git add src/extension.ts
git commit -m "feat(formatter): register formatter provider and commands in extension"
```

---

### Task 8: Package.json — Commands, Keybinding, Setting

**Files:**
- Modify: `package.json`

- [ ] **Step 19: Add command declarations to package.json contributes.commands**

Add to the `commands` array:
```json
{
    "command": "tsql-intellisense.formatSql",
    "title": "T-SQL IntelliSense: Format SQL"
},
{
    "command": "tsql-intellisense.setStyleFolder",
    "title": "T-SQL IntelliSense: Set Style Folder"
}
```

- [ ] **Step 20: Add keybinding to package.json contributes.keybindings**

Add to the `keybindings` array:
```json
{
    "command": "tsql-intellisense.formatSql",
    "key": "ctrl+k y",
    "when": "editorLangId == sql && tsqlIntellisense.active"
}
```

- [ ] **Step 21: Add styleFolder setting to package.json contributes.configuration**

Add to the `properties` object inside `configuration`:
```json
"tsql-intellisense.styleFolder": {
    "type": "string",
    "default": "",
    "description": "Path to folder containing Redgate SQL Prompt style files (.json)"
}
```

- [ ] **Step 22: Commit**

```bash
git add package.json
git commit -m "feat(formatter): add formatSql command, keybinding, and styleFolder setting"
```

---

### Task 9: Update test script + Final verification

**Files:**
- Modify: `package.json`

- [ ] **Step 23: Add formatter test to npm test script**

Update the `test` script in package.json:
```json
"test": "npx ts-node test/contextDetection.test.ts && npx ts-node test/projectSync.test.ts && npx ts-node test/formatter.test.ts"
```

- [ ] **Step 24: Run all tests**

Run: `npm test`
Expected: All 87+ tests pass (41 context + 46 projectSync + formatter tests)

- [ ] **Step 25: Build**

Run: `npm run build`
Expected: Build succeeds — `dist/extension.js` produced

- [ ] **Step 26: Commit**

```bash
git add package.json
git commit -m "chore: add formatter tests to npm test script"
```

---

### Task 10: Manual Testing Checklist

- [ ] **Step 27: F5 test — verify all manual test cases**

Launch Extension Development Host (F5), open a `.sql` file:

| # | Test | Input | Expected |
|---|------|-------|----------|
| 1 | `Ctrl+K Y` full file | `select * from Customers where id = 1` | `Select * From Customers Where id = 1` |
| 2 | `Ctrl+K Y` selection | Select `from Customers`, press `Ctrl+K Y` | Only `From Customers` changes |
| 3 | `Shift+Alt+F` | Same file | Full file formatted |
| 4 | String protection | `select 'select from'` | `Select 'select from'` |
| 5 | Comment protection | `select -- select from` | `Select -- select from` |
| 6 | Bracketed identifier | `select [select] from T` | `Select [select] From T` |
| 7 | LEFT as keyword | `left join T on` | `Left Join T On` |
| 8 | LEFT as function | `left('abc', 2)` | `LEFT('abc', 2)` |
| 9 | @@ROWCOUNT | `select @@rowcount` | `Select @@ROWCOUNT` |
| 10 | Datatype | `declare @x int` | `Declare @x Int` |
| 11 | Set Style Folder | Command Palette → Set Style Folder | Folder picker opens |
