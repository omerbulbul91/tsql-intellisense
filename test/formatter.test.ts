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

// ===================== CASING TESTS =====================

import { applyCasing, CasingMode } from '../src/formatter/casingRule';

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

// ===================== LAYOUT TESTS =====================

import { applyLayout, LayoutOptions } from '../src/formatter/layoutRule';
import { applyCasingInPlace } from '../src/formatter/casingRule';

let layoutPassed = 0;
let layoutFailed = 0;

const defaultLayout: LayoutOptions = { maxLineLength: 120, placeCommasBeforeItems: true, alignItemsToTabStops: true };

function assertLayout(input: string, expected: string, options: LayoutOptions, testName: string) {
    const tokens = tokenize(input);
    applyCasingInPlace(tokens, { reservedKeywords: 'upperCamelCase', builtInFunctions: 'uppercase', builtInDataTypes: 'upperCamelCase' });
    const result = applyLayout(tokens, options);
    if (result === expected) {
        layoutPassed++;
        console.log(`  ✅ ${testName}`);
    } else {
        layoutFailed++;
        console.error(`  ❌ ${testName}`);
        console.error(`    expected: "${expected.replace(/\n/g, '\\n')}"`);
        console.error(`    got:      "${result.replace(/\n/g, '\\n')}"`);
    }
}

console.log('\n=== Layout Rule Tests ===\n');

// --- Basic SELECT + FROM ---
assertLayout(
    'select a, b, c from T',
    'Select  a, b, c\nFrom    T',
    defaultLayout, 'basic SELECT FROM padding'
);

// --- Dynamic padding with ORDER BY ---
assertLayout(
    'select a from T order by a',
    'Select    a\nFrom      T\nOrder By  a',
    defaultLayout, 'dynamic padding with ORDER BY'
);

// --- SELECT with GROUP BY + HAVING ---
assertLayout(
    'select a, count(b) from T group by a having count(b) > 1',
    'Select    a, COUNT(b)\nFrom      T\nGroup By  a\nHaving    COUNT(b) > 1',
    defaultLayout, 'GROUP BY + HAVING'
);

// --- WHERE clause (single item, no comma split) ---
assertLayout(
    'select a from T where x = 1 and y = 2',
    'Select  a\nFrom    T\nWhere   x = 1 And y = 2',
    defaultLayout, 'WHERE as single item'
);

// --- SELECT * ---
assertLayout(
    'select * from T',
    'Select  *\nFrom    T',
    defaultLayout, 'SELECT star'
);

// --- SELECT DISTINCT ---
assertLayout(
    'select distinct a, b from T',
    'Select  Distinct a, b\nFrom    T',
    defaultLayout, 'SELECT DISTINCT prefix'
);

// --- SELECT TOP N ---
assertLayout(
    'select top 100 a, b from T',
    'Select  Top 100 a, b\nFrom    T',
    defaultLayout, 'SELECT TOP N prefix'
);

// --- Function with inner commas (depth>0) ---
assertLayout(
    'select isnull(a, b), c from T',
    'Select  ISNULL(a, b), c\nFrom    T',
    defaultLayout, 'function inner commas not split'
);

// --- Line wrap with commas before ---
assertLayout(
    'select col1, col2, col3, col4, col5, col6, col7, col8, col9, col10 from T',
    'Select  col1, col2, col3, col4, col5, col6, col7, col8, col9, col10\nFrom    T',
    { maxLineLength: 80, placeCommasBeforeItems: true, alignItemsToTabStops: true },
    'wrap within maxLineLength'
);

// --- Wrap: commas before items on continuation ---
assertLayout(
    'select very_long_column_name_1, very_long_column_name_2, very_long_column_name_3 from T',
    'Select  very_long_column_name_1, very_long_column_name_2\n      , very_long_column_name_3\nFrom    T',
    { maxLineLength: 60, placeCommasBeforeItems: true, alignItemsToTabStops: true },
    'wrap with comma before on continuation'
);

// --- Wrap: commas after items ---
assertLayout(
    'select very_long_column_name_1, very_long_column_name_2, very_long_column_name_3 from T',
    'Select  very_long_column_name_1, very_long_column_name_2,\n        very_long_column_name_3\nFrom    T',
    { maxLineLength: 60, placeCommasBeforeItems: false, alignItemsToTabStops: true },
    'wrap with comma after'
);

// --- maxLineLength=0: no wrap ---
assertLayout(
    'select a, b, c, d, e, f, g, h from T',
    'Select  a, b, c, d, e, f, g, h\nFrom    T',
    { maxLineLength: 0, placeCommasBeforeItems: true, alignItemsToTabStops: true },
    'maxLineLength=0 no wrap'
);

// --- alignItemsToTabStops=false: no padding ---
assertLayout(
    'select a, b from T',
    'Select a, b\nFrom T',
    { maxLineLength: 120, placeCommasBeforeItems: true, alignItemsToTabStops: false },
    'no padding when alignItemsToTabStops=false'
);

// --- Subquery (depth>0 SELECT ignored) ---
assertLayout(
    'select a from (select b from T2) x',
    'Select  a\nFrom    (Select b From T2) x',
    defaultLayout, 'subquery SELECT not split'
);

// --- String with keyword ---
assertLayout(
    "select 'from' from T",
    "Select  'from'\nFrom    T",
    defaultLayout, 'string keyword not treated as clause'
);

// --- Batch: semicolon ---
assertLayout(
    'select a from T1; select b from T2',
    'Select  a\nFrom    T1;\nSelect  b\nFrom    T2',
    defaultLayout, 'batch semicolon separates statements'
);

// --- AS alias ---
assertLayout(
    'select col1 as alias1, col2 as alias2 from T',
    'Select  col1 As alias1, col2 As alias2\nFrom    T',
    defaultLayout, 'AS alias stays with item'
);

// --- FROM with multiple tables ---
assertLayout(
    'select a from T1, T2 where T1.id = T2.id',
    'Select  a\nFrom    T1, T2\nWhere   T1.id = T2.id',
    defaultLayout, 'FROM multiple tables comma-separated'
);

// --- Only SELECT (no FROM) ---
assertLayout(
    'select 1, 2, 3',
    'Select  1, 2, 3',
    defaultLayout, 'SELECT without FROM'
);

console.log(`\nLayout: ${layoutPassed} passed, ${layoutFailed} failed\n`);

const totalFailed = failed + casingFailed + layoutFailed;
if (totalFailed > 0) process.exit(1);
