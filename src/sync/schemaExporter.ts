import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionManager } from '../connection/connectionManager';
import { SchemaCache, ObjectInfo } from '../cache/schemaCache';
import { ts } from '../utils/timestamp';

const SUBDIRECTORY_MAP: Record<string, string> = {
    'PROCEDURE': 'Stored Procedures',
    'VIEW': 'Views',
    'FUNCTION': 'Functions',
    'TRIGGER': 'Triggers',
    'TABLE': 'Tables',
};

/** Normalize line endings to CRLF and trim trailing whitespace for consistent git diffs */
function normalizeScript(script: string): string {
    let s = script.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
    s = s + '\n';
    // Convert to CRLF (Windows/SSDT standard)
    return s.replace(/\n/g, '\r\n');
}

/** Strip line endings for content comparison (ignores LF vs CRLF difference) */
function stripLineEndings(s: string): string {
    return s.replace(/\r\n/g, '\n');
}

/** Only write if content actually changed (idempotent) */
function writeIfChanged(filePath: string, content: string): boolean {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(filePath)) {
        const existing = fs.readFileSync(filePath, 'utf-8');
        if (stripLineEndings(existing) === stripLineEndings(content)) { return false; }
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
}

export class SchemaExporter {
    constructor(
        private connectionManager: ConnectionManager,
        private schemaCache: SchemaCache
    ) {}

    async exportAll(
        exportPath: string,
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

        const log = this.connectionManager.log;
        const start = Date.now();
        log.appendLine(`[${ts()}] [SchemaExporter] Export başladı — ${total} nesne → ${exportPath}`);
        log.show(true);

        // Ensure object definitions are cached
        if (!this.schemaCache.isFullyLoaded) {
            log.appendLine(`[${ts()}] [SchemaExporter] Schema detayları yükleniyor...`);
            await this.schemaCache.loadObjectDefinitions();
        }

        for (let i = 0; i < objects.length; i++) {
            if (token.isCancellationRequested) { break; }

            const obj = objects[i];
            progress.report({
                message: `(${i + 1}/${total}) ${obj.name}`,
                increment: 100 / total,
            });

            try {
                const script = this.getScript(obj);
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
                log.appendLine(`[${ts()}] [SchemaExporter] Error: ${obj.name} — ${err.message}`);
            }
        }

        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        log.appendLine(`[${ts()}] [SchemaExporter] Export bitti — ${written} yazıldı, ${skipped} atlandı, ${errors} hata (${elapsed}s)`);

        return { written, skipped, errors };
    }

    private getScript(obj: ObjectInfo): string | null {
        if (obj.type === 'TABLE') {
            return this.buildTableScriptFromCache(obj.name);
        }

        // VIEW / SP / FUNCTION / TRIGGER — cache'ten al
        return this.schemaCache.getObjectDefinition(obj.name) || null;
    }

    /** Build CREATE TABLE script from cached schema data */
    private buildTableScriptFromCache(tableName: string): string | null {
        const obj = this.schemaCache.findObject(tableName);
        if (!obj?.columns || obj.columns.length === 0) { return null; }

        const lines: string[] = [];
        lines.push(`CREATE TABLE [dbo].[${tableName}]`, '(');

        // Columns
        for (let i = 0; i < obj.columns.length; i++) {
            const col = obj.columns[i];
            let colDef = `    [${col.name}]`;
            colDef += ` [${col.dataType}]`;

            if (['varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary'].includes(col.dataType)) {
                colDef += col.maxLength === -1 ? '(MAX)' : `(${col.maxLength})`;
            }

            if (col.isIdentity) { colDef += ' IDENTITY(1,1)'; }
            colDef += col.isNullable ? ' NULL' : ' NOT NULL';
            if (col.hasDefault && col.defaultValue) { colDef += ` DEFAULT ${col.defaultValue}`; }

            if (i < obj.columns.length - 1) { colDef += ','; }
            lines.push(colDef);
        }
        lines.push(')');
        lines.push('GO');

        // Indexes & PK
        const indexes = this.schemaCache.getIndexes(tableName);
        for (const idx of indexes) {
            if (idx.isPrimaryKey) {
                lines.push(`ALTER TABLE [dbo].[${tableName}] ADD CONSTRAINT [${idx.name}] PRIMARY KEY ${idx.type} (${idx.columns})`);
            } else {
                const unique = idx.isUnique ? 'UNIQUE ' : '';
                lines.push(`CREATE ${unique}${idx.type} INDEX [${idx.name}] ON [dbo].[${tableName}] (${idx.columns})`);
            }
            lines.push('GO');
        }

        // Foreign keys
        const fks = this.schemaCache.getForeignKeysForTable(tableName)
            .filter(fk => fk.parentTable.toLowerCase() === tableName.toLowerCase());
        for (const fk of fks) {
            lines.push(`ALTER TABLE [dbo].[${tableName}] ADD CONSTRAINT [${fk.fkName}] FOREIGN KEY ([${fk.parentColumn}]) REFERENCES [dbo].[${fk.referencedTable}] ([${fk.referencedColumn}])`);
            lines.push('GO');
        }

        // Triggers
        const triggers = this.schemaCache.getTriggers(tableName);
        for (const trig of triggers) {
            if (trig.definition) {
                lines.push(trig.definition.trim());
                lines.push('GO');
            }
        }

        return lines.join('\n');
    }
}
