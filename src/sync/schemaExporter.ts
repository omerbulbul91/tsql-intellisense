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
    let s = script.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
    return s + '\n';
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
