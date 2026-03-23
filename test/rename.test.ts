/**
 * Programmatic tests for rename provider (alias + parameter rename).
 * Run: npx ts-node test/rename.test.ts
 */

import { getCurrentStatement, extractAliases } from '../src/parser/sqlContext';

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

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Helper: simulate parameter rename (find all @param occurrences in full text) ──
function findParamOccurrences(fullText: string, paramName: string): number[] {
    const regex = new RegExp(`${escapeRegex(paramName)}\\b`, 'gi');
    const positions: number[] = [];
    let match;
    while ((match = regex.exec(fullText)) !== null) {
        positions.push(match.index);
    }
    return positions;
}

// ── Helper: simulate alias rename (find all alias occurrences in current statement) ──
// Mirrors renameProvider.ts logic: excludes table name positions in FROM/JOIN clauses
function findAliasOccurrences(fullText: string, offset: number, aliasName: string): number[] {
    const statement = getCurrentStatement(fullText, offset);
    const statementStart = fullText.indexOf(statement);

    // Find table name positions to exclude (same logic as renameProvider.ts)
    const tableNamePositions = new Set<number>();
    const fromJoinRegex = /(?:FROM|(?:INNER|LEFT|RIGHT|CROSS|FULL)\s+(?:OUTER\s+)?JOIN|JOIN)\s+(?:dbo\.)?(\[?\w+\]?)\s+/gi;
    let fjMatch;
    while ((fjMatch = fromJoinRegex.exec(statement)) !== null) {
        const tableNameInMatch = fjMatch[1];
        const tableNameStart = fjMatch.index + fjMatch[0].indexOf(tableNameInMatch);
        tableNamePositions.add(tableNameStart);
    }

    const regex = new RegExp(`\\b${escapeRegex(aliasName)}\\b`, 'gi');
    const positions: number[] = [];
    let match;
    while ((match = regex.exec(statement)) !== null) {
        // Skip table name positions
        if (tableNamePositions.has(match.index)) {
            continue;
        }
        positions.push(statementStart + match.index);
    }
    return positions;
}

// ── Helper: detect if position is on a parameter ──
function isParameter(fullText: string, offset: number): boolean {
    // Walk back to find @ before the word
    let i = offset;
    while (i > 0 && /\w/.test(fullText[i - 1])) { i--; }
    return i > 0 && fullText[i - 1] === '@';
}

function getParamAtOffset(fullText: string, offset: number): string | undefined {
    // Find the @word at offset
    let start = offset;
    while (start > 0 && /[\w@]/.test(fullText[start - 1])) { start--; }
    if (fullText[start] !== '@') { return undefined; }
    let end = offset;
    while (end < fullText.length && /\w/.test(fullText[end])) { end++; }
    return fullText.substring(start, end);
}

// ═══════════════════════════════════════════════════════
// PARAMETER DETECTION
// ═══════════════════════════════════════════════════════
console.log('\n── Parameter Detection ──');

{
    const sql = `ALTER PROC dbo.SpTest\n    @Id BigInt,\n    @Name NVarchar(200)\nAS BEGIN\n    SELECT @Id, @Name\nEND`;
    assert(getParamAtOffset(sql, sql.indexOf('@Id') + 1) === '@Id', '@Id detected as parameter');
    assert(getParamAtOffset(sql, sql.indexOf('@Name') + 2) === '@Name', '@Name detected as parameter');
    assert(getParamAtOffset(sql, sql.indexOf('SpTest') + 2) === undefined, 'SpTest is not a parameter');
    assert(getParamAtOffset(sql, sql.indexOf('BigInt') + 2) === undefined, 'BigInt is not a parameter');
}

// ═══════════════════════════════════════════════════════
// PARAMETER RENAME — FIND ALL OCCURRENCES
// ═══════════════════════════════════════════════════════
console.log('\n── Parameter Rename: Find All Occurrences ──');

{
    const sql = `ALTER PROC dbo.Sp_Rn_Crm_Bonus_CancelOlayLog
    @PrimOlayLogId BigInt, @CancelNotes NVarchar(200) = Null, @sssip Int = Null
AS BEGIN
    Set NoCount On;

    If @sssip Is Null Begin
        RAISERROR('Kullanıcı bilgisi (@sssip) zorunludur.', 16, 1);
        Return;
    End

    Update dbo.Tb_Rn_Crm_PrimOlayLog
    Set     IsCancelled = 1
            , CancelNotes = @CancelNotes
            , UpdateUser = @sssip
    Where   PrimOlayLogId = @PrimOlayLogId;
End`;

    // @CancelNotes should appear 2 times (definition + usage)
    const cancelNotesOccurrences = findParamOccurrences(sql, '@CancelNotes');
    assert(cancelNotesOccurrences.length === 2, '@CancelNotes found 2 times');

    // @sssip should appear 3 times (definition + if check + RAISERROR string + usage)
    // Note: RAISERROR string contains @sssip inside quotes — regex \b will match it
    const sssipOccurrences = findParamOccurrences(sql, '@sssip');
    assert(sssipOccurrences.length === 4, '@sssip found 4 times (def + if + string + usage)');

    // @PrimOlayLogId should appear 2 times
    const primOccurrences = findParamOccurrences(sql, '@PrimOlayLogId');
    assert(primOccurrences.length === 2, '@PrimOlayLogId found 2 times');
}

{
    // Simple case
    const sql = `CREATE PROC dbo.Test @Amount Decimal(18,2)\nAS\nSELECT @Amount * 1.18`;
    const occurrences = findParamOccurrences(sql, '@Amount');
    assert(occurrences.length === 2, '@Amount found in definition and usage');
}

// ═══════════════════════════════════════════════════════
// PARAMETER RENAME — NO FALSE POSITIVES
// ═══════════════════════════════════════════════════════
console.log('\n── Parameter Rename: No False Positives ──');

{
    const sql = `CREATE PROC dbo.Test @Name NVarchar(50), @NameSuffix NVarchar(10)\nAS\nSELECT @Name, @NameSuffix`;
    // @Name should NOT match @NameSuffix (word boundary)
    const nameOccurrences = findParamOccurrences(sql, '@Name');
    assert(nameOccurrences.length === 2, '@Name does not match @NameSuffix (word boundary)');

    const nameSuffixOccurrences = findParamOccurrences(sql, '@NameSuffix');
    assert(nameSuffixOccurrences.length === 2, '@NameSuffix found exactly 2 times');
}

// ═══════════════════════════════════════════════════════
// PARAMETER RENAME — newName @ PREFIX HANDLING
// ═══════════════════════════════════════════════════════
console.log('\n── Parameter Rename: @ Prefix Handling ──');

{
    const newName1 = 'Notes';
    const newParam1 = newName1.startsWith('@') ? newName1 : '@' + newName1;
    assert(newParam1 === '@Notes', 'Auto-prefix @ when user types without @');

    const newName2 = '@Notes';
    const newParam2 = newName2.startsWith('@') ? newName2 : '@' + newName2;
    assert(newParam2 === '@Notes', 'No double @ when user types with @');
}

// ═══════════════════════════════════════════════════════
// ALIAS RENAME — STILL WORKS (REGRESSION)
// ═══════════════════════════════════════════════════════
console.log('\n── Alias Rename: Regression Tests ──');

{
    const sql = `SELECT k.ID, k.Name\nFROM Kullanicilar k\nWHERE k.Active = 1`;
    const aliases = extractAliases(sql);
    assert(aliases.length === 1, 'extractAliases finds 1 alias');
    assert(aliases[0].alias === 'k', 'alias is k');
    assert(aliases[0].tableName === 'Kullanicilar', 'tableName is Kullanicilar');

    // Find alias occurrences in statement
    const occurrences = findAliasOccurrences(sql, 10, 'k');
    assert(occurrences.length === 4, 'alias k found 4 times (definition + 3 usages)');
}

{
    const sql = `SELECT am.ID, am.Name, k.Code\nFROM AnaMenu am\nINNER JOIN Kullanicilar k ON k.ID = am.KullaniciID`;
    const aliases = extractAliases(sql);
    assert(aliases.length === 2, 'extractAliases finds 2 aliases');
    assert(aliases.some(a => a.alias === 'am'), 'alias am found');
    assert(aliases.some(a => a.alias === 'k'), 'alias k found');

    const amOccurrences = findAliasOccurrences(sql, 10, 'am');
    assert(amOccurrences.length === 4, 'alias am found 4 times');

    const kOccurrences = findAliasOccurrences(sql, 10, 'k');
    assert(kOccurrences.length === 3, 'alias k found 3 times');
}

// ═══════════════════════════════════════════════════════
// ALIAS RENAME — ALIAS = TABLE NAME (SHOULD NOT RENAME TABLE)
// ═══════════════════════════════════════════════════════
console.log('\n── Alias Rename: Alias = Table Name ──');

{
    // With dbo. prefix — alias same as table name
    const sql = `SELECT RN100_Kullanicilar.KullaniciID, RN100_Kullanicilar.RolID\nFROM dbo.RN100_Kullanicilar RN100_Kullanicilar`;
    const occurrences = findAliasOccurrences(sql, 10, 'RN100_Kullanicilar');
    // Should find: 2 usages in SELECT + 1 alias definition in FROM = 3 (NOT the table name after dbo.)
    assert(occurrences.length === 3, 'alias=tableName with dbo.: table name excluded, 3 occurrences (2 usage + 1 def)');
}

{
    // Without dbo. prefix — alias same as table name
    const sql = `SELECT RN100_Kullanicilar.KullaniciID\nFROM RN100_Kullanicilar RN100_Kullanicilar`;
    const occurrences = findAliasOccurrences(sql, 10, 'RN100_Kullanicilar');
    // Should find: 1 usage in SELECT + 1 alias definition = 2 (NOT the table name in FROM)
    assert(occurrences.length === 2, 'alias=tableName without dbo.: table name excluded, 2 occurrences (1 usage + 1 def)');
}

{
    // Multi-table with alias = table name on one
    const sql = `SELECT RN100_Kullanicilar.KullaniciID, R.RolName\nFROM dbo.RN100_Kullanicilar RN100_Kullanicilar\nLEFT OUTER JOIN dbo.RN100_Roller R ON R.RolID = RN100_Kullanicilar.RolID`;
    const occurrences = findAliasOccurrences(sql, 10, 'RN100_Kullanicilar');
    // SELECT usage (1) + FROM alias def (1) + ON usage (1) = 3
    assert(occurrences.length === 3, 'multi-table alias=tableName: 3 occurrences (table name excluded)');
}

// ═══════════════════════════════════════════════════════
// ALIAS RENAME — SCOPE (STATEMENT ONLY)
// ═══════════════════════════════════════════════════════
console.log('\n── Alias Rename: Statement Scope ──');

{
    // Two separate statements with same alias
    const sql = `SELECT k.ID FROM Users k WHERE k.Active = 1\nGO\nSELECT k.Name FROM Products k`;
    const stmt1Occurrences = findAliasOccurrences(sql, 5, 'k');
    assert(stmt1Occurrences.length === 3, 'alias k in first statement: 3 occurrences (not crossing GO)');

    const stmt2Occurrences = findAliasOccurrences(sql, sql.length - 5, 'k');
    assert(stmt2Occurrences.length === 2, 'alias k in second statement: 2 occurrences');
}

// ═══════════════════════════════════════════════════════
// PARAMETER RENAME — CASE INSENSITIVE
// ═══════════════════════════════════════════════════════
console.log('\n── Parameter Rename: Case Insensitive ──');

{
    const sql = `CREATE PROC dbo.Test @userId Int\nAS\nSELECT @USERID, @UserId`;
    const occurrences = findParamOccurrences(sql, '@userId');
    assert(occurrences.length === 3, '@userId matched case-insensitively (3 occurrences)');
}

// ═══════════════════════════════════════════════════════
// PARAMETER RENAME — MULTIPLE PARAMS
// ═══════════════════════════════════════════════════════
console.log('\n── Parameter Rename: Multiple Parameters ──');

{
    const sql = `ALTER PROC dbo.Test
    @StartDate DateTime,
    @EndDate DateTime,
    @Status Int = 1
AS BEGIN
    SELECT * FROM Orders
    WHERE OrderDate BETWEEN @StartDate AND @EndDate
    AND Status = @Status
END`;

    assert(findParamOccurrences(sql, '@StartDate').length === 2, '@StartDate found 2 times');
    assert(findParamOccurrences(sql, '@EndDate').length === 2, '@EndDate found 2 times');
    assert(findParamOccurrences(sql, '@Status').length === 2, '@Status found 2 times');
}

// ═══════════════════════════════════════════════════════
console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
process.exit(failed > 0 ? 1 : 0);