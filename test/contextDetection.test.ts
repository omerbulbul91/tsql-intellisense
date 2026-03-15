/**
 * Programmatic tests for SQL context detection and helpers.
 * Run: npx ts-node test/contextDetection.test.ts
 */

import {
    SqlContextType,
    detectContext,
    getCurrentStatement,
    extractAliases,
    extractTables,
    extractNonAggColumns,
} from '../src/parser/sqlContext';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${testName}`);
    } else {
        failed++;
        console.log(`  ✗ ${testName}`);
    }
}

function contextOf(textBeforeCursor: string, fullStatement?: string): SqlContextType {
    const stmt = fullStatement || textBeforeCursor;
    return detectContext(textBeforeCursor, stmt).type;
}

function contextFull(textBeforeCursor: string, fullStatement?: string) {
    const stmt = fullStatement || textBeforeCursor;
    return detectContext(textBeforeCursor, stmt);
}

// ─── FROM / JOIN ───
console.log('\n── FROM / JOIN context ──');
assert(contextOf('SELECT * FROM ') === SqlContextType.AFTER_FROM_JOIN, 'FROM + space → AFTER_FROM_JOIN');
assert(contextOf('SELECT * FROM RN') === SqlContextType.AFTER_FROM_JOIN, 'FROM + prefix → AFTER_FROM_JOIN');
assert(contextOf('LEFT JOIN ') === SqlContextType.AFTER_FROM_JOIN, 'LEFT JOIN → AFTER_FROM_JOIN');
assert(contextOf('INNER JOIN dbo.') === SqlContextType.AFTER_FROM_JOIN, 'INNER JOIN dbo. → AFTER_FROM_JOIN');

// ─── AFTER TABLE NAME (keyword suggestions) ───
console.log('\n── AFTER_TABLE_NAME (keyword) ──');
const stmt1 = 'SELECT * FROM RN100_Kullanicilar k';
assert(contextOf(stmt1) === SqlContextType.AFTER_TABLE_NAME, 'FROM table alias → AFTER_TABLE_NAME');

const stmt2 = 'SELECT * FROM RN100_Kullanicilar k wh';
assert(contextOf(stmt2) === SqlContextType.AFTER_TABLE_NAME, 'FROM table alias + partial keyword → AFTER_TABLE_NAME');

const stmt3 = 'SELECT * FROM RN100_Kullanicilar k or';
assert(contextOf(stmt3) === SqlContextType.AFTER_TABLE_NAME, 'FROM table alias keyword_prefix → AFTER_TABLE_NAME');

// ─── Fallback keyword ───
console.log('\n── Fallback keyword context ──');
// "or" on new line → detected as SQL OR keyword → AFTER_SELECT (column suggestions after OR)
const stmtFb = 'SELECT * FROM RN100_Kullanicilar k WHERE k.ID = 1\nor';
assert(contextOf(stmtFb) === SqlContextType.AFTER_SELECT, 'WHERE condition + newline "or" → AFTER_SELECT (OR is column context)');

const stmtGo = 'SELECT * FROM RN100_Kullanicilar k\ngo';
assert(contextOf(stmtGo) === SqlContextType.AFTER_TABLE_NAME, '"go" → AFTER_TABLE_NAME (GO in keyword list)');

// ─── EXEC ───
console.log('\n── EXEC context ──');
assert(contextOf('EXEC ') === SqlContextType.AFTER_EXEC, 'EXEC + space → AFTER_EXEC');
assert(contextOf('EXEC sp_') === SqlContextType.AFTER_EXEC, 'EXEC + prefix → AFTER_EXEC');
// EXECUTE dbo. → detected as AFTER_FROM_JOIN (dbo. handling in alias dot check)
assert(contextOf('EXECUTE dbo.') === SqlContextType.AFTER_FROM_JOIN, 'EXECUTE dbo. → AFTER_FROM_JOIN (dbo prefix)');
// EXEC context should only suggest SPs, not functions (functions use SELECT dbo.FnName())
assert(contextOf('EXEC ') === SqlContextType.AFTER_EXEC, 'EXEC → AFTER_EXEC (only SPs, no functions)');

// ─── ALIAS DOT ───
console.log('\n── ALIAS DOT context ──');
const aliasDotStmt = 'SELECT k. FROM RN100_Kullanicilar k';
const ctx1 = contextFull('SELECT k.', aliasDotStmt);
assert(ctx1.type === SqlContextType.AFTER_ALIAS_DOT, 'alias. → AFTER_ALIAS_DOT');
assert(ctx1.tableName === 'RN100_Kullanicilar', 'alias resolves to correct table');
assert(ctx1.alias === 'k', 'alias name is correct');

const aliasDotPrefix = 'SELECT k.Kul FROM RN100_Kullanicilar k';
const ctx2 = contextFull('SELECT k.Kul', aliasDotPrefix);
assert(ctx2.type === SqlContextType.AFTER_ALIAS_DOT, 'alias.prefix → AFTER_ALIAS_DOT');
assert(ctx2.prefix === 'Kul', 'prefix is correct');

// ─── ALTER PROC ───
console.log('\n── ALTER PROC context ──');
assert(contextOf('ALTER PROC ') === SqlContextType.AFTER_ALTER_PROC, 'ALTER PROC → AFTER_ALTER_PROC');
// ALTER PROCEDURE dbo.sp → dbo. intercepted by alias dot check first
assert(contextOf('ALTER PROCEDURE sp') === SqlContextType.AFTER_ALTER_PROC, 'ALTER PROCEDURE prefix → AFTER_ALTER_PROC');

// ─── SELECT (column context) ───
console.log('\n── SELECT / column context ──');
const selStmt = 'SELECT  FROM RN100_Kullanicilar k';
assert(contextOf('SELECT ', selStmt) === SqlContextType.AFTER_SELECT, 'SELECT + space → AFTER_SELECT');

const whereStmt = 'SELECT * FROM RN100_Kullanicilar k WHERE ';
assert(contextOf(whereStmt) === SqlContextType.AFTER_SELECT, 'WHERE + space → AFTER_SELECT');

// ─── Inside function parenthesis ───
console.log('\n── Function parenthesis ──');
const sumStmt = 'SELECT SUM( FROM RN100_Kullanicilar k';
assert(contextOf('SELECT SUM(', sumStmt) === SqlContextType.AFTER_SELECT, 'SUM( → AFTER_SELECT');

const countStmt = 'SELECT COUNT( FROM RN100_Kullanicilar k';
assert(contextOf('SELECT COUNT(', countStmt) === SqlContextType.AFTER_SELECT, 'COUNT( → AFTER_SELECT');

// ─── ORDER BY + ASC/DESC ───
console.log('\n── ORDER BY ASC/DESC ──');
const orderStmt = 'SELECT * FROM T k ORDER BY k.Name de';
assert(contextOf('SELECT * FROM T k\nORDER BY k.Name de', orderStmt) === SqlContextType.AFTER_ORDER_BY_COLUMN, 'ORDER BY col prefix → AFTER_ORDER_BY_COLUMN');

// ─── ON (join condition) ───
console.log('\n── ON (join condition) ──');
const onStmt = 'SELECT * FROM T1 k LEFT JOIN T2 r ON ';
const ctx3 = contextFull('SELECT * FROM T1 k LEFT JOIN T2 r ON ', onStmt);
assert(ctx3.type === SqlContextType.AFTER_ON, 'JOIN table alias ON → AFTER_ON');
assert(ctx3.joinedTable === 'T2', 'joined table correct');
assert(ctx3.joinedAlias === 'r', 'joined alias correct');

// ─── After = sign ───
console.log('\n── After = sign ──');
const eqStmt = 'SELECT * FROM T1 k JOIN T2 r ON r.ID = ';
const ctx4 = contextFull('SELECT * FROM T1 k JOIN T2 r ON r.ID = ', eqStmt);
assert(ctx4.type === SqlContextType.AFTER_ON, '= + space → AFTER_ON (alias suggestions)');

// ─── GROUP BY ───
console.log('\n── GROUP BY ──');
const gbStmt = 'SELECT k.Name, COUNT(*) FROM T k GROUP BY ';
const ctx5 = contextFull('SELECT k.Name, COUNT(*) FROM T k\nGROUP BY ', gbStmt);
assert(ctx5.type === SqlContextType.AFTER_GROUP_BY, 'GROUP BY → AFTER_GROUP_BY');

// ─── extractAliases ───
console.log('\n── extractAliases ──');
const aliases = extractAliases('SELECT * FROM RN100_Kullanicilar k LEFT JOIN RN100_Roller r ON r.ID = k.ID');
assert(aliases.length === 2, 'extracts 2 aliases');
assert(aliases[0].alias === 'k' && aliases[0].tableName === 'RN100_Kullanicilar', 'first alias correct');
assert(aliases[1].alias === 'r' && aliases[1].tableName === 'RN100_Roller', 'second alias correct');

// ─── extractTables ───
console.log('\n── extractTables ──');
const tables = extractTables('SELECT * FROM T1 JOIN T2 ON T2.ID = T1.ID LEFT JOIN T3 ON T3.ID = T1.ID');
assert(tables.length === 3, 'extracts 3 tables');
assert(tables.includes('T1') && tables.includes('T2') && tables.includes('T3'), 'all table names correct');

// ─── extractNonAggColumns ───
console.log('\n── extractNonAggColumns ──');
const nonAgg1 = extractNonAggColumns('SELECT k.Name, k.RolID, SUM(k.Amount) AS Total, COUNT(*) FROM T k');
assert(nonAgg1.length === 2, 'extracts 2 non-agg columns');
assert(nonAgg1[0] === 'k.Name', 'first non-agg column correct');
assert(nonAgg1[1] === 'k.RolID', 'second non-agg column correct');

const nonAgg2 = extractNonAggColumns('SELECT * FROM T');
assert(nonAgg2.length === 0, 'SELECT * → no non-agg columns');

// ─── getCurrentStatement ───
console.log('\n── getCurrentStatement ──');
const fullText = 'SELECT 1;\nSELECT 2;\nSELECT 3';
const stmt = getCurrentStatement(fullText, 15); // middle of "SELECT 2"
assert(stmt.trim().startsWith('SELECT 2'), 'getCurrentStatement extracts correct statement');

const goText = 'SELECT 1\nGO\nSELECT 2';
const stmtGo2 = getCurrentStatement(goText, 15);
assert(stmtGo2.trim().startsWith('SELECT 2'), 'getCurrentStatement respects GO separator');

// ─── Summary ───
console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'═'.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
