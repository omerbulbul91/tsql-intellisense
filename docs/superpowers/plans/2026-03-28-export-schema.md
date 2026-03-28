# Export Schema Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export all DB objects (Tables, Views, SPs, Functions, Triggers) to a folder structure as `.sql` files.

**Architecture:** New `SchemaExporter` class in `src/sync/schemaExporter.ts` handles export logic. Uses `definitionProvider.buildTableScript()` for tables and `OBJECT_DEFINITION()` for other object types. Idempotent write — skips unchanged files. Command registered in `extension.ts`, accessible from Command Palette and DB tree context menu.

**Tech Stack:** TypeScript, VS Code Extension API, tedious (SQL Server)

---

## Task 1: Add `getAllObjects()` to SchemaCache

**Files:**
- Modify: `src/cache/schemaCache.ts`
- Modify: `test/projectSync.test.ts` (or inline verification)

- [ ] **Step 1: Add `getAllObjects()` method to SchemaCache**

In `src/cache/schemaCache.ts`, add a public method that returns all objects from the internal `objects` map:

```typescript
/** Return all cached objects (for export, etc.) */
getAllObjects(): ObjectInfo[] {
    return Array.from(this.objects.values());
}
```

Add after the existing `getObject(name)` method (around line 344).

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/cache/schemaCache.ts
git commit -m "feat: add getAllObjects() to SchemaCache for export support"
```

---

## Task 2: Create SchemaExporter

**Files:**
- Create: `src/sync/schemaExporter.ts`
- Create: `test/schemaExporter.test.ts`

- [ ] **Step 1: Write tests for SchemaExporter**

Create `test/schemaExporter.test.ts`. Tests verify:
1. Idempotent write — same content doesn't rewrite file
2. CRLF normalization — `\r\n` → `\n`
3. New file is written when it doesn't exist
4. Changed content overwrites existing file
5. Cancel token stops export midway
6. Empty schema returns `{ written: 0, skipped: 0, errors: 0 }`

Since SchemaExporter imports `vscode`, extract the pure logic (idempotent write, CRLF normalize) into testable helper functions, and test those. Mirror the pattern from `projectSync.test.ts` which duplicates the regex to avoid vscode dependency.

```typescript
/**
 * SchemaExporter unit tests.
 * Tests pure helper functions extracted to avoid vscode dependency.
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
        console.log(`  ✓ ${testName}`);
    } else {
        failed++;
        console.log(`  ✗ ${testName}`);
    }
}

// Mirror of normalize + idempotent write logic from schemaExporter.ts
function normalizeScript(script: string): string {
    return script.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '\n');
}

function shouldWriteFile(filePath: string, newContent: string): boolean {
    if (!fs.existsSync(filePath)) { return true; }
    const existing = fs.readFileSync(filePath, 'utf-8');
    return existing !== newContent;
}

// ─── normalizeScript ───
console.log('\n── normalizeScript ──');

assert(normalizeScript('SELECT 1\r\n') === 'SELECT 1\n', 'CRLF to LF');
assert(normalizeScript('SELECT 1  \n') === 'SELECT 1\n', 'trailing spaces removed');
assert(normalizeScript('SELECT 1\n\n\n') === 'SELECT 1\n', 'trailing newlines collapsed');
assert(normalizeScript('SELECT 1\r\nGO\r\n') === 'SELECT 1\nGO\n', 'multi-line CRLF');

// ─── shouldWriteFile (idempotent) ───
console.log('\n── shouldWriteFile ──');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-test-'));

// New file — should write
const newFile = path.join(tmpDir, 'new.sql');
assert(shouldWriteFile(newFile, 'SELECT 1\n') === true, 'new file should write');

// Same content — should NOT write
fs.writeFileSync(newFile, 'SELECT 1\n', 'utf-8');
assert(shouldWriteFile(newFile, 'SELECT 1\n') === false, 'same content should skip');

// Changed content — should write
assert(shouldWriteFile(newFile, 'SELECT 2\n') === true, 'changed content should write');

// Cleanup
fs.rmSync(tmpDir, { recursive: true });

// ─── SUBDIRECTORY_MAP ───
console.log('\n── SUBDIRECTORY_MAP ──');

const SUBDIRECTORY_MAP: Record<string, string> = {
    'PROCEDURE': 'Stored Procedures',
    'VIEW': 'Views',
    'FUNCTION': 'Functions',
    'TRIGGER': 'Triggers',
    'TABLE': 'Tables',
};

assert(SUBDIRECTORY_MAP['PROCEDURE'] === 'Stored Procedures', 'SP subdir correct');
assert(SUBDIRECTORY_MAP['TABLE'] === 'Tables', 'Table subdir correct');
assert(SUBDIRECTORY_MAP['VIEW'] === 'Views', 'View subdir correct');
assert(SUBDIRECTORY_MAP['FUNCTION'] === 'Functions', 'Function subdir correct');
assert(SUBDIRECTORY_MAP['TRIGGER'] === 'Triggers', 'Trigger subdir correct');

// ─── File path generation ───
console.log('\n── File path generation ──');

function buildExportPath(exportRoot: string, objectType: string, objectName: string): string {
    const subDir = SUBDIRECTORY_MAP[objectType] || objectType;
    return path.join(exportRoot, 'dbo', subDir, `${objectName}.sql`);
}

const p1 = buildExportPath('/export', 'PROCEDURE', 'spTest');
assert(p1.includes('Stored Procedures'), 'SP path has correct subdir');
assert(p1.endsWith('spTest.sql'), 'SP path has correct filename');

const p2 = buildExportPath('/export', 'TABLE', 'Users');
assert(p2.includes('Tables'), 'Table path has correct subdir');

// ─── Summary ───
console.log(`\n── Summary: ${passed} passed, ${failed} failed ──`);
if (failed > 0) { process.exit(1); }
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx ts-node test/schemaExporter.test.ts`
Expected: All tests pass (these test pure helper functions)

- [ ] **Step 3: Create `src/sync/schemaExporter.ts`**

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionManager, TYPES } from '../connection/connectionManager';
import { SchemaCache, ObjectInfo } from '../cache/schemaCache';

const SUBDIRECTORY_MAP: Record<string, string> = {
    'PROCEDURE': 'Stored Procedures',
    'VIEW': 'Views',
    'FUNCTION': 'Functions',
    'TRIGGER': 'Triggers',
    'TABLE': 'Tables',
};

/** Normalize line endings and trailing whitespace for consistent git diffs */
function normalizeScript(script: string): string {
    return script.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '\n');
}

/** Only write if content actually changed (idempotent) */
function writeIfChanged(filePath: string, content: string): boolean {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(filePath)) {
        const existing = fs.readFileSync(filePath, 'utf-8');
        if (existing === content) { return false; }
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
}

export type BuildTableScriptFn = (tableName: string) => Promise<string | null>;

export class SchemaExporter {
    constructor(
        private connectionManager: ConnectionManager,
        private schemaCache: SchemaCache
    ) {}

    async exportAll(
        exportPath: string,
        buildTableScript: BuildTableScriptFn,
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken
    ): Promise<{ written: number; skipped: number; errors: number }> {
        const objects = this.schemaCache.getAllObjects();
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
            progress.report({
                message: `(${i + 1}/${total}) ${obj.name}`,
                increment: 100 / total,
            });

            try {
                const script = await this.getScript(obj, buildTableScript);
                if (!script) { skipped++; continue; }

                const normalized = normalizeScript(script);
                const subDir = SUBDIRECTORY_MAP[obj.type] || obj.type;
                const filePath = path.join(exportPath, 'dbo', subDir, `${obj.name}.sql`);

                if (writeIfChanged(filePath, normalized)) {
                    written++;
                } else {
                    skipped++;
                }
            } catch (err: any) {
                errors++;
                this.connectionManager.log.appendLine(
                    `[SchemaExporter] Error exporting ${obj.name}: ${err.message}`
                );
            }
        }

        return { written, skipped, errors };
    }

    private async getScript(
        obj: ObjectInfo,
        buildTableScript: BuildTableScriptFn
    ): Promise<string | null> {
        if (obj.type === 'TABLE') {
            return buildTableScript(obj.name);
        }

        // VIEW / SP / FUNCTION / TRIGGER — fetch definition from DB as-is
        try {
            const result = await this.connectionManager.executeQuery(
                `SELECT OBJECT_DEFINITION(OBJECT_ID(@objectName)) AS [definition]`,
                { objectName: { type: TYPES.NVarChar, value: obj.name } }
            );
            if (result.rows.length > 0 && result.rows[0]['definition']) {
                return (result.rows[0]['definition'] as string).trim();
            }
        } catch (_) { /* logged by caller */ }
        return null;
    }
}
```

Key points:
- `normalizeScript()` — CRLF→LF, trailing whitespace, trailing newlines
- `writeIfChanged()` — idempotent, only writes if content differs
- Table: `buildTableScript()` (async, from definitionProvider)
- Others: `OBJECT_DEFINITION()` — no CREATE OR ALTER transformation
- Cancel support via `token.isCancellationRequested`

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/sync/schemaExporter.ts test/schemaExporter.test.ts
git commit -m "feat: add SchemaExporter with idempotent write and CRLF normalize"
```

---

## Task 3: Register Export Schema Command

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`
- Modify: `package.nls.json`
- Modify: `package.nls.tr.json`

- [ ] **Step 1: Add command to `package.json`**

In `package.json` → `contributes.commands` array, add:

```json
{
    "command": "tsql-intellisense.exportSchema",
    "title": "%command.exportSchema%",
    "category": "T-SQL"
}
```

In `contributes.menus` → `view/item/context` array, add after the `loadDatabaseSchema` entry:

```json
{
    "command": "tsql-intellisense.exportSchema",
    "when": "viewItem == Database"
}
```

- [ ] **Step 2: Add NLS translations**

In `package.nls.json`:
```json
"command.exportSchema": "Export Schema"
```

In `package.nls.tr.json`:
```json
"command.exportSchema": "T-SQL IntelliSense: Şemayı Dışa Aktar"
```

- [ ] **Step 3: Register command in `extension.ts`**

Add import at top of `extension.ts`:
```typescript
import { SchemaExporter } from './sync/schemaExporter';
```

In the `activate()` function, after the existing `ProjectSync` setup, create the exporter and register the command:

```typescript
const schemaExporter = new SchemaExporter(connectionManager, schemaCacheManager.active!);

context.subscriptions.push(
    vscode.commands.registerCommand('tsql-intellisense.exportSchema', async (node?: DatabaseTreeItem) => {
        // Command Palette — check connection
        if (!node && !connectionManager.isConnected) {
            vscode.window.showWarningMessage('T-SQL IntelliSense: Bağlantı yok. Lütfen önce bir bağlantı kurun.');
            return;
        }

        const profile = connectionManager.currentProfile;
        if (!profile) { return; }

        // Determine default export path
        const currentDb = profile.database;
        const defaultPath = (profile as any).databaseProjects?.[currentDb]
            ?? (profile as any).projectPath
            ?? undefined;

        // Folder picker
        const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Export Buraya',
            title: 'Export Schema — Hedef Klasör',
            defaultUri: defaultPath ? vscode.Uri.file(defaultPath) : undefined,
        });
        if (!picked || picked.length === 0) { return; }
        const exportPath = picked[0].fsPath;

        // Ensure schema is loaded
        const cache = schemaCacheManager.active;
        if (!cache || !cache.isLoaded) {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'T-SQL: Schema yükleniyor...' },
                async () => { await loadSchemaForActiveDb(); }
            );
            if (!schemaCacheManager.active?.isLoaded) {
                vscode.window.showErrorMessage('T-SQL: Schema yüklenemedi. Export iptal edildi.');
                return;
            }
        }

        // Create exporter with current cache
        const exporter = new SchemaExporter(connectionManager, schemaCacheManager.active!);

        // Run export with progress
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `T-SQL: Schema dışa aktarılıyor (${currentDb})`,
                cancellable: true,
            },
            async (progress, token) => {
                progress.report({ message: 'Başlıyor...' });
                const { written, skipped, errors } = await exporter.exportAll(
                    exportPath,
                    (name) => definitionProvider.buildTableScript(name),
                    progress,
                    token
                );
                if (token.isCancellationRequested) {
                    vscode.window.showWarningMessage(`T-SQL: Export iptal edildi. ${written} dosya yazıldı.`);
                } else {
                    vscode.window.showInformationMessage(
                        `T-SQL: Export tamamlandı — ${written} yazıldı, ${skipped} atlandı, ${errors} hata. Klasör: ${exportPath}`
                    );
                }
            }
        );
    })
);
```

Note: `definitionProvider` is already available in the activate scope — verify its variable name by checking existing references in extension.ts.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: All tests pass (existing + new schemaExporter tests)

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts package.json package.nls.json package.nls.tr.json
git commit -m "feat: register Export Schema command with context menu and Command Palette"
```

---

## Task 4: Add test to `npm test` pipeline

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add schemaExporter test to npm test script**

In `package.json` → `scripts.test`, append `&& npx ts-node test/schemaExporter.test.ts` to the existing chain.

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass, including the new schemaExporter tests.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "test: add schemaExporter tests to npm test pipeline"
```
