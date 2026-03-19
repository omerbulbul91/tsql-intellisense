/**
 * Programmatic tests for ProjectSync DDL detection regex.
 * Run: npx ts-node test/projectSync.test.ts
 *
 * Note: detectDdl is duplicated here because projectSync.ts imports vscode
 * which is not available in test environment.
 */

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

// Mirror of DDL_REGEX and detectDdl from src/sync/projectSync.ts
const DDL_REGEX = /^\s*(ALTER|CREATE(?:\s+OR\s+ALTER)?)\s+(PROC(?:EDURE)?|VIEW|FUNCTION|TRIGGER|TABLE)\s+(?:\[?([a-zA-Z0-9_\u00C0-\u024F\u0100-\u017F]+)\]?\.)?\[?([a-zA-Z0-9_\u00C0-\u024F\u0100-\u017F]+)\]?/im;

interface DdlInfo {
    action: 'ALTER' | 'CREATE';
    objectType: 'PROCEDURE' | 'VIEW' | 'FUNCTION' | 'TRIGGER' | 'TABLE';
    schema: string;
    objectName: string;
}

function detectDdl(sql: string): DdlInfo | null {
    const match = sql.match(DDL_REGEX);
    if (!match) { return null; }
    let objectType = match[2].toUpperCase();
    if (objectType === 'PROC') { objectType = 'PROCEDURE'; }
    const rawAction = match[1].toUpperCase();
    return {
        action: (rawAction.includes('ALTER') ? 'ALTER' : 'CREATE') as 'ALTER' | 'CREATE',
        objectType: objectType as DdlInfo['objectType'],
        schema: match[3] || 'dbo',
        objectName: match[4],
    };
}

// ─── ALTER / CREATE basic ───
console.log('\n── ALTER / CREATE basic ──');

const ddl1 = detectDdl('ALTER PROCEDURE dbo.spTest AS SELECT 1');
assert(ddl1 !== null, 'ALTER PROCEDURE detected');
assert(ddl1?.action === 'ALTER', 'action is ALTER');
assert(ddl1?.objectType === 'PROCEDURE', 'objectType is PROCEDURE');
assert(ddl1?.objectName === 'spTest', 'objectName is spTest');
assert(ddl1?.schema === 'dbo', 'schema is dbo');

const ddl2 = detectDdl('CREATE VIEW vwTest AS SELECT 1');
assert(ddl2 !== null, 'CREATE VIEW detected');
assert(ddl2?.action === 'CREATE', 'action is CREATE');
assert(ddl2?.objectType === 'VIEW', 'objectType is VIEW');
assert(ddl2?.objectName === 'vwTest', 'objectName is vwTest');

const ddl3 = detectDdl('ALTER PROC spShort AS SELECT 1');
assert(ddl3 !== null, 'ALTER PROC (short) detected');
assert(ddl3?.objectType === 'PROCEDURE', 'PROC normalized to PROCEDURE');

// ─── CREATE OR ALTER ───
console.log('\n── CREATE OR ALTER ──');

const ddl4 = detectDdl('CREATE OR ALTER PROCEDURE dbo.spTest AS SELECT 1');
assert(ddl4 !== null, 'CREATE OR ALTER PROCEDURE detected');
assert(ddl4?.action === 'ALTER', 'CREATE OR ALTER → action normalized to ALTER');
assert(ddl4?.objectType === 'PROCEDURE', 'objectType is PROCEDURE');
assert(ddl4?.objectName === 'spTest', 'objectName is spTest');

const ddl5 = detectDdl('CREATE OR ALTER TRIGGER trg_Test ON dbo.MyTable FOR INSERT AS');
assert(ddl5 !== null, 'CREATE OR ALTER TRIGGER detected');
assert(ddl5?.objectType === 'TRIGGER', 'objectType is TRIGGER');
assert(ddl5?.objectName === 'trg_Test', 'objectName is trg_Test');

const ddl6 = detectDdl('CREATE OR ALTER VIEW dbo.vwTest AS SELECT 1');
assert(ddl6 !== null, 'CREATE OR ALTER VIEW detected');
assert(ddl6?.objectType === 'VIEW', 'objectType is VIEW');

const ddl7 = detectDdl('CREATE OR ALTER FUNCTION dbo.fnTest() RETURNS INT AS BEGIN RETURN 1 END');
assert(ddl7 !== null, 'CREATE OR ALTER FUNCTION detected');
assert(ddl7?.objectType === 'FUNCTION', 'objectType is FUNCTION');

// ─── TRIGGER ───
console.log('\n── TRIGGER ──');

const ddl8 = detectDdl('ALTER TRIGGER RN05_RotaD_Update ON RN05_RotaD FOR UPDATE AS');
assert(ddl8 !== null, 'ALTER TRIGGER detected');
assert(ddl8?.objectType === 'TRIGGER', 'objectType is TRIGGER');
assert(ddl8?.objectName === 'RN05_RotaD_Update', 'objectName is RN05_RotaD_Update');
assert(ddl8?.schema === 'dbo', 'schema defaults to dbo');

// ─── With comments before DDL ───
console.log('\n── Comments before DDL ──');

const ddl9 = detectDdl('/*Yazan : Test\n   Tarih: 15.12.2020\n*/\nALTER TRIGGER RN05_RotaD_Update ON RN05_RotaD FOR UPDATE AS');
assert(ddl9 !== null, 'DDL with block comment detected');
assert(ddl9?.objectName === 'RN05_RotaD_Update', 'objectName correct after comment');

const ddl10 = detectDdl('-- single line comment\nCREATE OR ALTER PROCEDURE dbo.spTest AS SELECT 1');
assert(ddl10 !== null, 'DDL with line comment detected');
assert(ddl10?.objectName === 'spTest', 'objectName correct after line comment');

// ─── TABLE ───
console.log('\n── TABLE ──');

const ddl11 = detectDdl('ALTER TABLE dbo.RN100_Kullanicilar ADD Test NVARCHAR(100) NULL');
assert(ddl11 !== null, 'ALTER TABLE detected');
assert(ddl11?.objectType === 'TABLE', 'objectType is TABLE');
assert(ddl11?.objectName === 'RN100_Kullanicilar', 'objectName is RN100_Kullanicilar');

const ddl12 = detectDdl('CREATE TABLE [dbo].[NewTable] (ID INT)');
assert(ddl12 !== null, 'CREATE TABLE with brackets detected');
assert(ddl12?.objectName === 'NewTable', 'objectName extracted from brackets');

// ─── No match ───
console.log('\n── No match ──');

assert(detectDdl('SELECT * FROM MyTable') === null, 'SELECT → no DDL');
assert(detectDdl('INSERT INTO T VALUES (1)') === null, 'INSERT → no DDL');
assert(detectDdl('UPDATE T SET Col = 1') === null, 'UPDATE → no DDL');

// ─── Snippet placeholder conversion ───
console.log('\n── Snippet placeholder conversion ──');

function convertPlaceholders(body: string): string {
    let converted = body.replace(/\\n/g, '\n');
    converted = converted.replace(/\$PASTE\$\$CURSOR\$/g, '${1:PASTE}$0');
    converted = converted.replace(/\$CURSOR\$/g, '$0');
    converted = converted.replace(/\$PASTE\$/g, '${1:PASTE}');
    converted = converted.replace(/\$SELECTIONSTART\$/g, '');
    converted = converted.replace(/\$SELECTIONEND\$/g, '');

    const placeholderMap = new Map<string, number>();
    let nextIndex = converted.includes('${1:PASTE}') ? 2 : 1;
    converted = converted.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)\$/g, (_match, name) => {
        if (!placeholderMap.has(name)) {
            placeholderMap.set(name, nextIndex++);
        }
        return `\${${placeholderMap.get(name)}:${name}}`;
    });
    return converted;
}

assert(
    convertPlaceholders('SELECT $0$ FROM $CURSOR$') === 'SELECT $0$ FROM $0',
    '$CURSOR$ → $0 (standalone)'
);

assert(
    convertPlaceholders('WHERE col LIKE \'%$PASTE$$CURSOR$%\'') === 'WHERE col LIKE \'%${1:PASTE}$0%\'',
    '$PASTE$$CURSOR$ → ${1:PASTE}$0'
);

assert(
    convertPlaceholders('$PASTE$') === '${1:PASTE}',
    '$PASTE$ alone → ${1:PASTE}'
);

assert(
    convertPlaceholders('ALTER TABLE $table_name$ ADD $column_name$ INT') ===
    'ALTER TABLE ${1:table_name} ADD ${2:column_name} INT',
    '$table_name$ and $column_name$ → sequential tabstops'
);

assert(
    convertPlaceholders('$table_name$.$table_name$') === '${1:table_name}.${1:table_name}',
    'same placeholder name → same tabstop number'
);

assert(
    convertPlaceholders('$SELECTIONSTART$text$SELECTIONEND$') === 'text',
    '$SELECTIONSTART$ and $SELECTIONEND$ removed'
);

assert(
    convertPlaceholders('Line1\\nLine2\\nLine3') === 'Line1\nLine2\nLine3',
    '\\n → actual newlines'
);

// $PASTE$ present → named placeholders start at 2
assert(
    convertPlaceholders('$PASTE$ $table_name$') === '${1:PASTE} ${2:table_name}',
    'with $PASTE$, named placeholders start at 2'
);

// ── Turkish characters in DDL ──
{
    const ddl = detectDdl('CREATE OR ALTER VIEW dbo.CPC01_ModulAltGrupları AS SELECT 1');
    assert(ddl !== null, 'Turkish chars: DDL detected');
    assert(ddl?.objectName === 'CPC01_ModulAltGrupları', 'Turkish chars: objectName correct — ' + ddl?.objectName);
    assert(ddl?.schema === 'dbo', 'Turkish chars: schema correct');
}
{
    const ddl = detectDdl('ALTER PROCEDURE dbo.spÖğrenciKayıt AS SELECT 1');
    assert(ddl !== null, 'Turkish SP: DDL detected');
    assert(ddl?.objectName === 'spÖğrenciKayıt', 'Turkish SP: objectName correct — ' + ddl?.objectName);
}

// ─── Summary ───
console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'═'.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
