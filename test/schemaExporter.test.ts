/**
 * SchemaExporter unit tests.
 * Tests pure helper functions (normalize, idempotent write, path generation).
 * Run: npx ts-node test/schemaExporter.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string) {
    if (condition) {
        passed++;
        console.log(`  \u2713 ${testName}`);
    } else {
        failed++;
        console.log(`  \u2717 ${testName}`);
    }
}

const BOM = '\uFEFF';

// Mirror of normalize + idempotent write logic from schemaExporter.ts
function normalizeScript(script: string): string {
    let s = script.startsWith(BOM) ? script.slice(1) : script;
    s = s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
    s = s + '\n\n'; // trailing blank line (SSDT standard)
    // Convert to CRLF (Windows/SSDT standard) and prepend BOM
    return BOM + s.replace(/\n/g, '\r\n');
}

function stripLineEndings(s: string): string {
    return s.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\n+$/, '\n');
}

function shouldWriteFile(filePath: string, newContent: string): boolean {
    if (!fs.existsSync(filePath)) { return true; }
    const existing = fs.readFileSync(filePath, 'utf-8');
    return stripLineEndings(existing) !== stripLineEndings(newContent);
}

const SUBDIRECTORY_MAP: Record<string, string> = {
    'PROCEDURE': 'Stored Procedures',
    'VIEW': 'Views',
    'FUNCTION': 'Functions',
    'TRIGGER': 'Triggers',
    'TABLE': 'Tables',
};

function buildExportPath(exportRoot: string, objectType: string, objectName: string): string {
    const subDir = SUBDIRECTORY_MAP[objectType] || objectType;
    return path.join(exportRoot, 'dbo', subDir, `${objectName}.sql`);
}

// ─── normalizeScript ───
console.log('\n── normalizeScript ──');

assert(normalizeScript('SELECT 1\r\n') === BOM + 'SELECT 1\r\n\r\n', 'CRLF + BOM + trailing blank line');
assert(normalizeScript('SELECT 1\n') === BOM + 'SELECT 1\r\n\r\n', 'LF to CRLF + BOM');
assert(normalizeScript('SELECT 1  \n') === BOM + 'SELECT 1\r\n\r\n', 'trailing spaces removed');
assert(normalizeScript('SELECT 1\t\n') === BOM + 'SELECT 1\r\n\r\n', 'trailing tabs removed');
assert(normalizeScript('SELECT 1\n\n\n') === BOM + 'SELECT 1\r\n\r\n', 'trailing newlines collapsed to one blank line');
assert(normalizeScript('SELECT 1\r\nGO\r\n') === BOM + 'SELECT 1\r\nGO\r\n\r\n', 'multi-line CRLF');
assert(normalizeScript('  SELECT 1  \r\n  GO  \r\n') === BOM + '  SELECT 1\r\n  GO\r\n\r\n', 'leading spaces preserved, trailing removed');
assert(normalizeScript('SELECT 1') === BOM + 'SELECT 1\r\n\r\n', 'adds trailing CRLF + BOM if missing');

// ─── shouldWriteFile (idempotent) ───
console.log('\n── shouldWriteFile ──');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-test-'));

const newFile = path.join(tmpDir, 'new.sql');
assert(shouldWriteFile(newFile, BOM + 'SELECT 1\r\n') === true, 'new file should write');

fs.writeFileSync(newFile, BOM + 'SELECT 1\r\n', 'utf-8');
assert(shouldWriteFile(newFile, BOM + 'SELECT 1\r\n') === false, 'same content should skip');

assert(shouldWriteFile(newFile, BOM + 'SELECT 2\r\n') === true, 'changed content should write');

// LF vs CRLF difference should NOT trigger rewrite
fs.writeFileSync(newFile, 'SELECT 1\n', 'utf-8');
assert(shouldWriteFile(newFile, BOM + 'SELECT 1\r\n') === false, 'LF vs CRLF + BOM = same content (no rewrite)');

assert(shouldWriteFile(newFile, 'SELECT 1\n\n') === false, 'extra trailing newline = same content (normalized)');
assert(shouldWriteFile(newFile, 'SELECT 2\n') === true, 'different content = should write');

fs.rmSync(tmpDir, { recursive: true });

// ─── SUBDIRECTORY_MAP ───
console.log('\n── SUBDIRECTORY_MAP ──');

assert(SUBDIRECTORY_MAP['PROCEDURE'] === 'Stored Procedures', 'SP subdir correct');
assert(SUBDIRECTORY_MAP['TABLE'] === 'Tables', 'Table subdir correct');
assert(SUBDIRECTORY_MAP['VIEW'] === 'Views', 'View subdir correct');
assert(SUBDIRECTORY_MAP['FUNCTION'] === 'Functions', 'Function subdir correct');
assert(SUBDIRECTORY_MAP['TRIGGER'] === 'Triggers', 'Trigger subdir correct');

// ─── File path generation ───
console.log('\n── File path generation ──');

const p1 = buildExportPath('/export', 'PROCEDURE', 'spTest');
assert(p1.includes('Stored Procedures'), 'SP path has correct subdir');
assert(p1.endsWith('spTest.sql'), 'SP path has correct filename');

const p2 = buildExportPath('/export', 'TABLE', 'Users');
assert(p2.includes('Tables'), 'Table path has correct subdir');
assert(p2.endsWith('Users.sql'), 'Table path has correct filename');

const p3 = buildExportPath('/export', 'VIEW', 'vwActive');
assert(p3.includes('Views'), 'View path has correct subdir');

const p4 = buildExportPath('/export', 'FUNCTION', 'fnCalc');
assert(p4.includes('Functions'), 'Function path has correct subdir');

const p5 = buildExportPath('/export', 'TRIGGER', 'trAudit');
assert(p5.includes('Triggers'), 'Trigger path has correct subdir');

// All paths start with dbo
assert(p1.includes(`dbo${path.sep}Stored Procedures`), 'SP path has dbo prefix');
assert(p2.includes(`dbo${path.sep}Tables`), 'Table path has dbo prefix');

// ─── End-to-end: normalize + write ───
console.log('\n── End-to-end: normalize then write ──');

const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'export-e2e-'));
const e2eFile = path.join(tmpDir2, 'test.sql');

// First write
const script1 = 'CREATE PROC dbo.spTest\r\nAS\r\n  SELECT 1  \r\n';
const norm1 = normalizeScript(script1);
assert(norm1 === BOM + 'CREATE PROC dbo.spTest\r\nAS\r\n  SELECT 1\r\n\r\n', 'normalize complex script to BOM + CRLF + trailing blank line');
fs.writeFileSync(e2eFile, norm1, 'utf-8');

// Second write with same logical content but different whitespace
const script2 = 'CREATE PROC dbo.spTest\nAS\n  SELECT 1\n';
const norm2 = normalizeScript(script2);
assert(shouldWriteFile(e2eFile, norm2) === false, 'same content after normalize = skip');

// Third write with actual change
const script3 = 'CREATE PROC dbo.spTest\r\nAS\r\n  SELECT 2  \r\n';
const norm3 = normalizeScript(script3);
assert(shouldWriteFile(e2eFile, norm3) === true, 'different content after normalize = write');

fs.rmSync(tmpDir2, { recursive: true });

// ─── SSDT Table Format Tests ───
console.log('\n── SSDT Table Format ──');

// Mirror of formatDataType logic
function formatDataType(col: { dataType: string; maxLength?: number | null; numericPrecision?: number; numericScale?: number; datetimePrecision?: number }): string {
    const dt = col.dataType.toLowerCase();
    const upper = col.dataType.toUpperCase();
    if (['varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary'].includes(dt)) {
        const len = (col.maxLength as number) === -1 ? 'MAX' : String(col.maxLength);
        return `${upper} (${len})`;
    }
    if (['decimal', 'numeric'].includes(dt) && col.numericPrecision != null) {
        return `${upper} (${col.numericPrecision}, ${col.numericScale ?? 0})`;
    }
    if (['datetime2', 'datetimeoffset', 'time'].includes(dt) && col.datetimePrecision != null) {
        return `${upper} (${col.datetimePrecision})`;
    }
    return upper;
}

// Datatype formatting — UPPERCASE, unbracketed, with precision
assert(formatDataType({ dataType: 'uniqueidentifier' }) === 'UNIQUEIDENTIFIER', 'uniqueidentifier uppercase');
assert(formatDataType({ dataType: 'bit' }) === 'BIT', 'bit uppercase');
assert(formatDataType({ dataType: 'int' }) === 'INT', 'int uppercase');
assert(formatDataType({ dataType: 'nvarchar', maxLength: 250 }) === 'NVARCHAR (250)', 'nvarchar with length + space');
assert(formatDataType({ dataType: 'nvarchar', maxLength: -1 }) === 'NVARCHAR (MAX)', 'nvarchar MAX');
assert(formatDataType({ dataType: 'varchar', maxLength: 50 }) === 'VARCHAR (50)', 'varchar with length');
assert(formatDataType({ dataType: 'datetime2', datetimePrecision: 7 }) === 'DATETIME2 (7)', 'datetime2 with precision');
assert(formatDataType({ dataType: 'datetime2', datetimePrecision: 0 }) === 'DATETIME2 (0)', 'datetime2 precision 0');
assert(formatDataType({ dataType: 'decimal', numericPrecision: 18, numericScale: 2 }) === 'DECIMAL (18, 2)', 'decimal with precision/scale');
assert(formatDataType({ dataType: 'datetime' }) === 'DATETIME', 'datetime no precision');

// Column definition parts
function buildColSuffix(col: { isIdentity?: boolean; hasDefault?: boolean; defaultValue?: string; defaultConstraintName?: string; isNullable: boolean; computedDefinition?: string; isPersisted?: boolean }): string {
    if (col.computedDefinition) {
        return `AS ${col.computedDefinition}${col.isPersisted ? ' PERSISTED' : ''}`;
    }
    let suffix = '';
    if (col.isIdentity) { suffix += ' IDENTITY (1, 1)'; }
    if (col.hasDefault && col.defaultValue) {
        const dcName = col.defaultConstraintName ? `CONSTRAINT [${col.defaultConstraintName}] ` : '';
        suffix += ` ${dcName}DEFAULT ${col.defaultValue}`;
    }
    suffix += col.isNullable ? ' NULL' : ' NOT NULL';
    return suffix;
}

// IDENTITY format
assert(buildColSuffix({ isIdentity: true, isNullable: false }) === ' IDENTITY (1, 1) NOT NULL', 'IDENTITY with spaces');

// DEFAULT without constraint name
assert(buildColSuffix({ hasDefault: true, defaultValue: '(getdate())', isNullable: false }) === ' DEFAULT (getdate()) NOT NULL', 'DEFAULT without constraint name');

// DEFAULT with named constraint
assert(buildColSuffix({ hasDefault: true, defaultValue: '(getdate())', defaultConstraintName: 'DF_MyTable_AddDate', isNullable: false }) === ' CONSTRAINT [DF_MyTable_AddDate] DEFAULT (getdate()) NOT NULL', 'DEFAULT with named constraint');

// Computed column
assert(buildColSuffix({ computedDefinition: '(HOST_NAME())', isNullable: false }) === 'AS (HOST_NAME())', 'computed column');
assert(buildColSuffix({ computedDefinition: '([Col1]+[Col2])', isPersisted: true, isNullable: false }) === 'AS ([Col1]+[Col2]) PERSISTED', 'computed column PERSISTED');

// NULL / NOT NULL
assert(buildColSuffix({ isNullable: true }) === ' NULL', 'nullable');
assert(buildColSuffix({ isNullable: false }) === ' NOT NULL', 'not nullable');

// FK cascade formatting
function buildFkCascade(deleteAction?: string, updateAction?: string): string {
    let suffix = '';
    if (deleteAction && deleteAction !== 'NO_ACTION') {
        suffix += ` ON DELETE ${deleteAction.replace(/_/g, ' ')}`;
    }
    if (updateAction && updateAction !== 'NO_ACTION') {
        suffix += ` ON UPDATE ${updateAction.replace(/_/g, ' ')}`;
    }
    return suffix;
}

assert(buildFkCascade('NO_ACTION', 'NO_ACTION') === '', 'NO_ACTION = empty');
assert(buildFkCascade('CASCADE', 'NO_ACTION') === ' ON DELETE CASCADE', 'ON DELETE CASCADE');
assert(buildFkCascade('SET_NULL', 'NO_ACTION') === ' ON DELETE SET NULL', 'ON DELETE SET NULL');
assert(buildFkCascade('SET_DEFAULT', 'NO_ACTION') === ' ON DELETE SET DEFAULT', 'ON DELETE SET DEFAULT');
assert(buildFkCascade('CASCADE', 'CASCADE') === ' ON DELETE CASCADE ON UPDATE CASCADE', 'both cascade');

// BOM in normalizeScript
const bomScript = normalizeScript('SELECT 1');
assert(bomScript.startsWith('\uFEFF'), 'normalizeScript adds BOM');
assert(bomScript.charCodeAt(0) === 0xFEFF, 'BOM is first character');

// Trailing blank line
assert(bomScript.endsWith('\r\n\r\n'), 'normalizeScript ends with trailing blank line');

// stripLineEndings ignores BOM + CRLF + trailing newlines
assert(stripLineEndings('\uFEFFSELECT 1\r\n\r\n') === stripLineEndings('SELECT 1\n'), 'BOM + CRLF + trailing = same as LF');

// ─── Summary ───
console.log(`\n── Summary: ${passed} passed, ${failed} failed ──`);
if (failed > 0) { process.exit(1); }
