import { applyStatementFormatting } from '../src/formatter/statementRule';
import { tokenize } from '../src/formatter/sqlTokenizer';
import { WhitespaceOptions, ControlFlowOptions, VariablesOptions } from '../src/formatter/styleLoader';

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

function fmt(sql: string, overrideWs?: Partial<WhitespaceOptions>): string {
    const tokens = tokenize(sql);
    return applyStatementFormatting(tokens, { ...ws, ...overrideWs }, cf, vars);
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, actual?: string) {
    if (condition) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.log(`  ❌ ${name}`);
        if (actual !== undefined) console.log(`     Got: ${JSON.stringify(actual)}`);
        failed++;
    }
}

// ═══════════════════════════════════════════════
// Layer 2: Statement Separation
// ═══════════════════════════════════════════════
console.log('\nStatement Separation:');

const t1 = fmt('Set @x = 1 Set @y = 2');
assert(t1.includes('Set @x = 1\n') && t1.includes('Set @y = 2'), 'two SETs separated', t1);

const t2 = fmt('Set @x = (Select Count(*) From T)');
assert(!t2.includes('\nSelect') && !t2.includes('\nFrom'), 'subquery not separated', t2);

const t3 = fmt('Select 1\nGo\nSelect 2');
assert(t3.includes('Go\n\n'), 'GO empty line after', t3);

const t4 = fmt('Select Col1 From T Order By Col1');
assert(!t4.includes('\nOrder') && !t4.includes('\nFrom'), 'ORDER BY not separated from SELECT', t4);

const t5 = fmt('Update T Set Col1 = 1 Where ID = 2');
assert(!t5.includes('\nSet'), 'UPDATE SET not separated', t5);

// ═══════════════════════════════════════════════
// Layer 1: Block Indentation
// ═══════════════════════════════════════════════
console.log('\nBlock Indentation:');

const b1 = fmt('Begin\nSet @x = 1\nEnd');
assert(b1.includes('    Set @x = 1'), 'BEGIN/END indent', b1);
assert(b1.startsWith('Begin'), 'BEGIN at depth 0', b1);

const b2 = fmt('Begin\nBegin Try\nSet @x = 1\nEnd Try\nBegin Catch\nPrint @e\nEnd Catch\nEnd');
assert(b2.includes('        Set @x = 1'), 'nested TRY depth 2', b2);
assert(b2.includes('    Begin Try'), 'BEGIN TRY depth 1', b2);
assert(b2.includes('    Begin Catch'), 'BEGIN CATCH depth 1', b2);

const b3 = fmt('If @x = 1\nSet @y = 2\nSet @z = 3');
assert(b3.includes('    Set @y = 2'), 'IF single body indented', b3);
assert(b3.includes('\nSet @z = 3'), 'after IF body at depth 0', b3);

const b4 = fmt('If @x = 1 Begin\nSet @y = 2\nEnd');
assert(b4.includes('    Set @y = 2'), 'IF BEGIN inline indent', b4);

const b5 = fmt('If @x = 1\nSet @y = 2\nElse\nSet @y = 3\nSet @z = 4');
assert(b5.includes('    Set @y = 2'), 'IF body indented', b5);
assert(b5.includes('    Set @y = 3'), 'ELSE body indented', b5);
assert(b5.includes('\nSet @z = 4'), 'after ELSE at depth 0', b5);

// ═══════════════════════════════════════════════
// Layer 3: Detail Formatting
// ═══════════════════════════════════════════════
console.log('\nDetail Formatting:');

// EXEC wrapping
const e1 = fmt('Exec dbo.SpName @P1 = 1, @P2 = 2');
assert(!e1.includes('\n'), 'EXEC 2 params single line', e1);

const e2 = fmt('Exec dbo.SpName @P1 = 1, @P2 = 2, @P3 = 3, @P4 = 4, @P5 = 5', { wrapLinesLongerThan: 50 });
assert(e2.includes('\n'), 'EXEC 5 params wrapped', e2);
assert(e2.includes(', @P'), 'EXEC comma-before on wrap', e2);

// DECLARE formatting
const d1 = fmt('Declare @x Int, @y NVarchar(50), @z DateTime');
assert(d1.includes(', @y'), 'DECLARE comma alignment', d1);
assert(d1.includes(', @z'), 'DECLARE second comma', d1);

// String concat (short — single line)
const s1 = fmt("Print N'hello ' + @name");
assert(!s1.includes('\n'), 'short concat single line', s1);

// String concat (long — wrapped)
const s2 = fmt("Set @x = @y + N'very long string that exceeds the maximum line length configured for this formatter setting'", { wrapLinesLongerThan: 60 });
assert(s2.includes('\n'), 'long concat wrapped', s2);

// ═══════════════════════════════════════════════
// Integration: Full SP structure
// ═══════════════════════════════════════════════
console.log('\nIntegration:');

const spInput = 'Begin\nBegin Try\nDeclare @x Int\nSet @x = 1\nIf @x = 0 Begin\nPrint \'zero\'\nEnd\nEnd Try\nBegin Catch\nPrint ERROR_MESSAGE()\nEnd Catch\nEnd';
const sp = fmt(spInput);
assert(sp.includes('    Begin Try'), 'SP: BEGIN TRY at depth 1', sp);
assert(sp.includes('        Declare'), 'SP: DECLARE at depth 2', sp);
assert(sp.includes('        Set @x'), 'SP: SET at depth 2', sp);
assert(sp.includes('            Print \'zero\''), 'SP: PRINT inside IF BEGIN at depth 3', sp);
assert(sp.includes('    Begin Catch'), 'SP: BEGIN CATCH at depth 1', sp);
assert(!!sp.match(/^End/m), 'SP: outer END at depth 0', sp);

// ═══════════════════════════════════════════════
// Empty Lines Between Statements
// ═══════════════════════════════════════════════
console.log('\nEmpty Lines Between Statements:');

// Two top-level SELECTs with emptyLinesBetweenStatements=1
const el1 = fmt('Select 1\nSelect 2', { emptyLinesBetweenStatements: 1 });
const el1Lines = el1.split('\n');
const el1BlankCount = el1Lines.filter((l, i) => i > 0 && l.trim() === '' && i < el1Lines.length - 1).length;
assert(el1BlankCount === 1, 'emptyLines=1: 1 blank line between two SELECTs', el1);

// Two top-level SELECTs with emptyLinesBetweenStatements=2
const el2 = fmt('Select 1\nSelect 2', { emptyLinesBetweenStatements: 2 });
const el2Lines = el2.split('\n');
const el2BlankCount = el2Lines.filter((l, i) => i > 0 && l.trim() === '' && i < el2Lines.length - 1).length;
assert(el2BlankCount === 2, 'emptyLines=2: 2 blank lines between two SELECTs', el2);

// Two top-level SELECTs with emptyLinesBetweenStatements=0 (does not remove existing blank lines)
const el0 = fmt('Select 1\nSelect 2', { emptyLinesBetweenStatements: 0 });
assert(!el0.includes('\n\n'), 'emptyLines=0: no extra blank lines added', el0);

// Mixed statements: SELECT then INSERT
const el3 = fmt('Select 1\nInsert Into T Values(1)', { emptyLinesBetweenStatements: 1 });
assert(el3.includes('\n\n'), 'emptyLines=1: blank line between SELECT and INSERT', el3);

// Mixed: DECLARE then SET then SELECT
const el4 = fmt('Declare @x Int\nSet @x = 1\nSelect @x', { emptyLinesBetweenStatements: 2 });
const el4Parts = el4.split(/\n{3}/); // 2 blank lines = 3 newlines
assert(el4Parts.length >= 3, 'emptyLines=2: 2 blank lines between DECLARE-SET-SELECT', el4);

// Existing blank lines replaced: input has 1 blank, setting says 2
const el5 = fmt('Select 1\n\nSelect 2', { emptyLinesBetweenStatements: 2 });
const el5Chunks = el5.split('Select');
const el5Between = el5Chunks[1]?.split('\n').filter(l => l.trim() === '').length || 0;
// Between first Select's content and second Select, should have exactly 2 blank lines
assert(el5.includes('\n\n\n') && !el5.includes('\n\n\n\n'), 'emptyLines=2: existing 1 blank replaced with 2', el5);

// ═══════════════════════════════════════════════

console.log(`\nStatement Rule: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
