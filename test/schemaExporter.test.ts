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

// Mirror of normalize + idempotent write logic from schemaExporter.ts
function normalizeScript(script: string): string {
    let s = script.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
    return s + '\n';
}

function shouldWriteFile(filePath: string, newContent: string): boolean {
    if (!fs.existsSync(filePath)) { return true; }
    const existing = fs.readFileSync(filePath, 'utf-8');
    return existing !== newContent;
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

assert(normalizeScript('SELECT 1\r\n') === 'SELECT 1\n', 'CRLF to LF');
assert(normalizeScript('SELECT 1  \n') === 'SELECT 1\n', 'trailing spaces removed');
assert(normalizeScript('SELECT 1\t\n') === 'SELECT 1\n', 'trailing tabs removed');
assert(normalizeScript('SELECT 1\n\n\n') === 'SELECT 1\n', 'trailing newlines collapsed');
assert(normalizeScript('SELECT 1\r\nGO\r\n') === 'SELECT 1\nGO\n', 'multi-line CRLF');
assert(normalizeScript('  SELECT 1  \r\n  GO  \r\n') === '  SELECT 1\n  GO\n', 'leading spaces preserved, trailing removed');
assert(normalizeScript('SELECT 1') === 'SELECT 1\n', 'adds trailing newline if missing');

// ─── shouldWriteFile (idempotent) ───
console.log('\n── shouldWriteFile ──');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-test-'));

const newFile = path.join(tmpDir, 'new.sql');
assert(shouldWriteFile(newFile, 'SELECT 1\n') === true, 'new file should write');

fs.writeFileSync(newFile, 'SELECT 1\n', 'utf-8');
assert(shouldWriteFile(newFile, 'SELECT 1\n') === false, 'same content should skip');

assert(shouldWriteFile(newFile, 'SELECT 2\n') === true, 'changed content should write');

assert(shouldWriteFile(newFile, 'SELECT 1\n\n') === true, 'extra newline = different content');

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
assert(norm1 === 'CREATE PROC dbo.spTest\nAS\n  SELECT 1\n', 'normalize complex script');
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

// ─── Summary ───
console.log(`\n── Summary: ${passed} passed, ${failed} failed ──`);
if (failed > 0) { process.exit(1); }
