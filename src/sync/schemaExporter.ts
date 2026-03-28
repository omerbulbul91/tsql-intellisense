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

export type BuildObjectScriptFn = (name: string) => string | null;

export class SchemaExporter {
    constructor(
        private connectionManager: ConnectionManager,
        private schemaCache: SchemaCache
    ) {}

    /**
     * Export all DB objects to exportPath.
     * buildObjectScript handles TABLE and VIEW (from cache).
     * SP/FUNCTION/TRIGGER definitions are fetched from DB.
     */
    async exportAll(
        exportPath: string,
        buildObjectScript: BuildObjectScriptFn,
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken
    ): Promise<{ written: number; skipped: number; errors: number }> {
        const objects = Array.from(this.schemaCache.getAllObjects());
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
            progress.report({ message: `(${i + 1}/${total}) ${obj.name}`, increment: 100 / total });

            try {
                const script = await this.getScript(obj, buildObjectScript);
                if (!script) { skipped++; continue; }

                const subDir = SUBDIRECTORY_MAP[obj.type] || obj.type;
                const filePath = path.join(exportPath, 'dbo', subDir, `${obj.name}.sql`);
                const dir = path.dirname(filePath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(filePath, script.replace(/\r\n/g, '\n'), 'utf-8');
                written++;
            } catch (err: any) {
                errors++;
                this.connectionManager.log.appendLine(`[SchemaExporter] Error exporting ${obj.name}: ${err.message}`);
            }
        }

        return { written, skipped, errors };
    }

    private async getScript(obj: ObjectInfo, buildObjectScript: BuildObjectScriptFn): Promise<string | null> {
        if (obj.type === 'TABLE' || obj.type === 'VIEW') {
            return buildObjectScript(obj.name);
        }

        // SP / FUNCTION / TRIGGER — fetch from DB
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
