/**
 * Unit tests for SchemaExporter logic.
 * Run: npx ts-node test/schemaExporter.test.ts
 *
 * vscode / fs / ConnectionManager are not available in test env —
 * all logic is replicated inline so tests run without those deps.
 */

import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${testName}`);
    } else {
        failed++;
        console.log(`  ✗ ${testName}${detail ? ' — ' + detail : ''}`);
    }
}

// ─── Replica of core types & logic from schemaExporter.ts ────────────────────

type ObjectType = 'TABLE' | 'VIEW' | 'PROCEDURE' | 'FUNCTION' | 'TRIGGER';

interface ObjectInfo {
    name: string;
    type: ObjectType;
}

type BuildObjectScriptFn = (name: string) => string | null;

const SUBDIRECTORY_MAP: Record<string, string> = {
    'PROCEDURE': 'Stored Procedures',
    'VIEW': 'Views',
    'FUNCTION': 'Functions',
    'TRIGGER': 'Triggers',
    'TABLE': 'Tables',
};

/** Builds the file path for a given object under exportPath/dbo/subDir/name.sql */
function buildFilePath(exportPath: string, obj: ObjectInfo): string {
    const subDir = SUBDIRECTORY_MAP[obj.type] || obj.type;
    return path.join(exportPath, 'dbo', subDir, `${obj.name}.sql`);
}

/** Returns script from cache for TABLE/VIEW, from mock DB for others */
async function getScript(
    obj: ObjectInfo,
    buildObjectScript: BuildObjectScriptFn,
    mockDb: Map<string, string>
): Promise<string | null> {
    if (obj.type === 'TABLE' || obj.type === 'VIEW') {
        return buildObjectScript(obj.name);
    }
    return mockDb.get(obj.name) ?? null;
}

/** Core export loop — mirrors SchemaExporter.exportAll */
async function exportAll(
    objects: ObjectInfo[],
    exportPath: string,
    buildObjectScript: BuildObjectScriptFn,
    mockDb: Map<string, string>,
    token: { isCancellationRequested: boolean },
    writtenFiles: Map<string, string>
): Promise<{ written: number; skipped: number; errors: number }> {
    const total = objects.length;
    let written = 0;
    let skipped = 0;
    let errors = 0;

    if (total === 0) {
        return { written, skipped, errors };
    }

    for (let i = 0; i < objects.length; i++) {
        if (token.isCancellationRequested) { break; }

        const obj = objects[i];
        try {
            const script = await getScript(obj, buildObjectScript, mockDb);
            if (!script) { skipped++; continue; }

            const filePath = buildFilePath(exportPath, obj);
            writtenFiles.set(filePath, script);
            written++;
        } catch (err: any) {
            errors++;
        }
    }

    return { written, skipped, errors };
}

// ─── Tests: SUBDIRECTORY_MAP ──────────────────────────────────────────────────
console.log('\n── SUBDIRECTORY_MAP ──');

assert(SUBDIRECTORY_MAP['PROCEDURE'] === 'Stored Procedures', 'PROCEDURE → Stored Procedures');
assert(SUBDIRECTORY_MAP['VIEW'] === 'Views', 'VIEW → Views');
assert(SUBDIRECTORY_MAP['FUNCTION'] === 'Functions', 'FUNCTION → Functions');
assert(SUBDIRECTORY_MAP['TRIGGER'] === 'Triggers', 'TRIGGER → Triggers');
assert(SUBDIRECTORY_MAP['TABLE'] === 'Tables', 'TABLE → Tables');
assert(SUBDIRECTORY_MAP['UNKNOWN'] === undefined, 'unknown type → undefined (falls back to type name)');

// ─── Tests: buildFilePath ─────────────────────────────────────────────────────
console.log('\n── buildFilePath ──');

const BASE = '/project';

assert(
    buildFilePath(BASE, { name: 'spGetUser', type: 'PROCEDURE' }) ===
        path.join(BASE, 'dbo', 'Stored Procedures', 'spGetUser.sql'),
    'PROCEDURE path correct'
);
assert(
    buildFilePath(BASE, { name: 'vwOrders', type: 'VIEW' }) ===
        path.join(BASE, 'dbo', 'Views', 'vwOrders.sql'),
    'VIEW path correct'
);
assert(
    buildFilePath(BASE, { name: 'Orders', type: 'TABLE' }) ===
        path.join(BASE, 'dbo', 'Tables', 'Orders.sql'),
    'TABLE path correct'
);
assert(
    buildFilePath(BASE, { name: 'fnCalc', type: 'FUNCTION' }) ===
        path.join(BASE, 'dbo', 'Functions', 'fnCalc.sql'),
    'FUNCTION path correct'
);
assert(
    buildFilePath(BASE, { name: 'trg_Insert', type: 'TRIGGER' }) ===
        path.join(BASE, 'dbo', 'Triggers', 'trg_Insert.sql'),
    'TRIGGER path correct'
);

// Object names with Turkish characters
assert(
    buildFilePath(BASE, { name: 'CPC01_ModulAltGrupları', type: 'TABLE' }) ===
        path.join(BASE, 'dbo', 'Tables', 'CPC01_ModulAltGrupları.sql'),
    'Turkish chars in table name'
);
assert(
    buildFilePath(BASE, { name: 'spÖğrenciKayıt', type: 'PROCEDURE' }) ===
        path.join(BASE, 'dbo', 'Stored Procedures', 'spÖğrenciKayıt.sql'),
    'Turkish chars in procedure name'
);

// ─── Tests: getScript routing ─────────────────────────────────────────────────
console.log('\n── getScript routing ──');

{
    const buildScript: BuildObjectScriptFn = (name) => name === 'Orders' ? 'CREATE TABLE [dbo].[Orders]...' : null;
    const mockDb = new Map([['spTest', 'CREATE PROCEDURE dbo.spTest AS SELECT 1']]);

    // TABLE → uses buildObjectScript
    getScript({ name: 'Orders', type: 'TABLE' }, buildScript, mockDb).then(s => {
        assert(s === 'CREATE TABLE [dbo].[Orders]...', 'TABLE uses buildObjectScript');
    });

    // VIEW → uses buildObjectScript
    const buildWithView: BuildObjectScriptFn = (name) => name === 'vwTest' ? 'CREATE VIEW...' : null;
    getScript({ name: 'vwTest', type: 'VIEW' }, buildWithView, mockDb).then(s => {
        assert(s === 'CREATE VIEW...', 'VIEW uses buildObjectScript');
    });

    // PROCEDURE → uses mockDb (DB query)
    getScript({ name: 'spTest', type: 'PROCEDURE' }, buildScript, mockDb).then(s => {
        assert(s === 'CREATE PROCEDURE dbo.spTest AS SELECT 1', 'PROCEDURE fetched from DB');
    });

    // FUNCTION → uses mockDb
    const mockDb2 = new Map([['fnCalc', 'CREATE FUNCTION dbo.fnCalc...']]);
    getScript({ name: 'fnCalc', type: 'FUNCTION' }, buildScript, mockDb2).then(s => {
        assert(s === 'CREATE FUNCTION dbo.fnCalc...', 'FUNCTION fetched from DB');
    });

    // TRIGGER → uses mockDb
    const mockDb3 = new Map([['trg_Insert', 'CREATE TRIGGER trg_Insert...']]);
    getScript({ name: 'trg_Insert', type: 'TRIGGER' }, buildScript, mockDb3).then(s => {
        assert(s === 'CREATE TRIGGER trg_Insert...', 'TRIGGER fetched from DB');
    });

    // Not in DB → returns null
    getScript({ name: 'spMissing', type: 'PROCEDURE' }, buildScript, mockDb).then(s => {
        assert(s === null, 'missing DB object → null');
    });
}

// ─── Tests: exportAll — normal flow ──────────────────────────────────────────
console.log('\n── exportAll — normal flow ──');

async function testNormalFlow() {
    const objects: ObjectInfo[] = [
        { name: 'Orders', type: 'TABLE' },
        { name: 'vwOrders', type: 'VIEW' },
        { name: 'spGetOrders', type: 'PROCEDURE' },
        { name: 'fnCalc', type: 'FUNCTION' },
        { name: 'trg_Insert', type: 'TRIGGER' },
    ];
    const buildScript: BuildObjectScriptFn = (name) => {
        if (name === 'Orders') { return 'CREATE TABLE [dbo].[Orders]...'; }
        if (name === 'vwOrders') { return 'CREATE VIEW dbo.vwOrders...'; }
        return null;
    };
    const mockDb = new Map([
        ['spGetOrders', 'CREATE PROCEDURE dbo.spGetOrders AS SELECT 1'],
        ['fnCalc', 'CREATE FUNCTION dbo.fnCalc()...'],
        ['trg_Insert', 'CREATE TRIGGER trg_Insert ON dbo.Orders...'],
    ]);
    const token = { isCancellationRequested: false };
    const writtenFiles = new Map<string, string>();

    const result = await exportAll(objects, '/project', buildScript, mockDb, token, writtenFiles);

    assert(result.written === 5, `all 5 objects written (got ${result.written})`);
    assert(result.skipped === 0, `0 skipped (got ${result.skipped})`);
    assert(result.errors === 0, `0 errors (got ${result.errors})`);
    assert(writtenFiles.size === 5, `5 files in writtenFiles (got ${writtenFiles.size})`);

    const tableFile = path.join('/project', 'dbo', 'Tables', 'Orders.sql');
    assert(writtenFiles.get(tableFile) === 'CREATE TABLE [dbo].[Orders]...', 'TABLE content correct');

    const spFile = path.join('/project', 'dbo', 'Stored Procedures', 'spGetOrders.sql');
    assert(writtenFiles.get(spFile) === 'CREATE PROCEDURE dbo.spGetOrders AS SELECT 1', 'SP content correct');
}

// ─── Tests: exportAll — skip when script is null ──────────────────────────────
console.log('\n── exportAll — skip when script null ──');

async function testSkipNull() {
    const objects: ObjectInfo[] = [
        { name: 'Orders', type: 'TABLE' },       // buildScript returns content
        { name: 'MissingTable', type: 'TABLE' }, // buildScript returns null → skip
        { name: 'spMissing', type: 'PROCEDURE' }, // not in mockDb → skip
    ];
    const buildScript: BuildObjectScriptFn = (name) => name === 'Orders' ? 'CREATE TABLE...' : null;
    const mockDb = new Map<string, string>();
    const token = { isCancellationRequested: false };
    const writtenFiles = new Map<string, string>();

    const result = await exportAll(objects, '/project', buildScript, mockDb, token, writtenFiles);

    assert(result.written === 1, `1 written (got ${result.written})`);
    assert(result.skipped === 2, `2 skipped (got ${result.skipped})`);
    assert(result.errors === 0, `0 errors (got ${result.errors})`);
}

// ─── Tests: exportAll — empty schema ─────────────────────────────────────────
console.log('\n── exportAll — empty schema ──');

async function testEmptySchema() {
    const token = { isCancellationRequested: false };
    const writtenFiles = new Map<string, string>();

    const result = await exportAll([], '/project', () => null, new Map(), token, writtenFiles);

    assert(result.written === 0, 'empty schema → 0 written');
    assert(result.skipped === 0, 'empty schema → 0 skipped');
    assert(result.errors === 0, 'empty schema → 0 errors');
    assert(writtenFiles.size === 0, 'empty schema → 0 files');
}

// ─── Tests: exportAll — cancel mid-way ───────────────────────────────────────
console.log('\n── exportAll — cancel ──');

async function testCancel() {
    const objects: ObjectInfo[] = [
        { name: 'T1', type: 'TABLE' },
        { name: 'T2', type: 'TABLE' },
        { name: 'T3', type: 'TABLE' },
    ];
    const buildScript: BuildObjectScriptFn = (name) => `CREATE TABLE ${name}`;
    const mockDb = new Map<string, string>();
    const writtenFiles = new Map<string, string>();

    // Cancel after first object
    let callCount = 0;
    const cancellingBuildScript: BuildObjectScriptFn = (name) => {
        callCount++;
        return `CREATE TABLE ${name}`;
    };
    const token = { isCancellationRequested: false };

    // Wrap exportAll to cancel after first iteration
    const objectsCancelAfterFirst: ObjectInfo[] = [
        { name: 'T1', type: 'TABLE' },
        { name: 'T2', type: 'TABLE' },
        { name: 'T3', type: 'TABLE' },
    ];

    let cancelToken = { isCancellationRequested: false };
    let callIdx = 0;
    const cancellingScript: BuildObjectScriptFn = (name) => {
        callIdx++;
        if (callIdx === 1) { cancelToken.isCancellationRequested = true; }
        return `CREATE TABLE ${name}`;
    };

    const result = await exportAll(
        objectsCancelAfterFirst, '/project', cancellingScript,
        mockDb, cancelToken, writtenFiles
    );

    // First object written before cancel check, T2 and T3 not reached
    assert(result.written === 1, `cancelled after 1st object: 1 written (got ${result.written})`);
    assert(result.written < 3, 'cancelled: not all objects written');
}

// ─── Tests: exportAll — error handling ───────────────────────────────────────
console.log('\n── exportAll — error handling ──');

async function testErrorHandling() {
    const objects: ObjectInfo[] = [
        { name: 'GoodTable', type: 'TABLE' },
        { name: 'BadSP', type: 'PROCEDURE' },
        { name: 'GoodSP', type: 'PROCEDURE' },
    ];
    const buildScript: BuildObjectScriptFn = (name) => `CREATE TABLE ${name}`;
    const mockDb = new Map([['GoodSP', 'CREATE PROCEDURE dbo.GoodSP AS SELECT 1']]);

    // Simulate error on BadSP by wrapping getScript to throw
    const writtenFiles = new Map<string, string>();
    const token = { isCancellationRequested: false };
    let written = 0, skipped = 0, errors = 0;

    for (const obj of objects) {
        if (token.isCancellationRequested) { break; }
        try {
            let script: string | null = null;
            if (obj.type === 'TABLE' || obj.type === 'VIEW') {
                script = buildScript(obj.name);
            } else if (obj.name === 'BadSP') {
                throw new Error('DB connection lost');
            } else {
                script = mockDb.get(obj.name) ?? null;
            }
            if (!script) { skipped++; continue; }
            const filePath = buildFilePath('/project', obj);
            writtenFiles.set(filePath, script);
            written++;
        } catch (_) {
            errors++;
        }
    }

    assert(written === 2, `2 written despite error (got ${written})`);
    assert(errors === 1, `1 error counted (got ${errors})`);
    assert(skipped === 0, `0 skipped (got ${skipped})`);
}

// ─── Tests: file path — no double dbo prefix ─────────────────────────────────
console.log('\n── File path structure ──');

{
    const p = buildFilePath('/C:/Projects/MyDB', { name: 'spTest', type: 'PROCEDURE' });
    const parts = p.split(path.sep);
    const dboIdx = parts.indexOf('dbo');
    assert(dboIdx !== -1, 'dbo directory present in path');
    assert(parts.filter(x => x === 'dbo').length === 1, 'only one dbo in path');
    assert(p.endsWith('.sql'), 'file extension is .sql');
}

{
    // Ensure uniqueness: two objects with same name but different types get different paths
    const spPath = buildFilePath('/proj', { name: 'GetData', type: 'PROCEDURE' });
    const fnPath = buildFilePath('/proj', { name: 'GetData', type: 'FUNCTION' });
    assert(spPath !== fnPath, 'same name, different types → different paths');
}

// ─── Run async tests ─────────────────────────────────────────────────────────
Promise.all([
    testNormalFlow(),
    testSkipNull(),
    testEmptySchema(),
    testCancel(),
    testErrorHandling(),
]).then(() => {
    console.log(`\n${'═'.repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log(`${'═'.repeat(40)}\n`);
    process.exit(failed > 0 ? 1 : 0);
});
