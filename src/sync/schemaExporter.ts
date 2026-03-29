import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionManager } from '../connection/connectionManager';
import { SchemaCache, ObjectInfo, ColumnInfo } from '../cache/schemaCache';
import { ts } from '../utils/timestamp';

const SUBDIRECTORY_MAP: Record<string, string> = {
    'PROCEDURE': 'Stored Procedures',
    'VIEW': 'Views',
    'FUNCTION': 'Functions',
    'TRIGGER': 'Triggers',
    'TABLE': 'Tables',
};

const BOM = '\uFEFF';

/** Normalize line endings to CRLF, add BOM, and trim trailing whitespace for consistent git diffs */
function normalizeScript(script: string): string {
    // Strip existing BOM if present
    let s = script.startsWith(BOM) ? script.slice(1) : script;
    s = s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
    s = s + '\n\n'; // trailing blank line (SSDT standard)
    // Convert to CRLF (Windows/SSDT standard) and prepend BOM
    return BOM + s.replace(/\n/g, '\r\n');
}

/** Strip BOM, normalize line endings and trailing newlines for content comparison */
function stripLineEndings(s: string): string {
    return s.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\n+$/, '\n');
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

        // Always refresh all schema data before export (columns, FKs, indexes, triggers, definitions)
        log.appendLine(`[${ts()}] [SchemaExporter] Schema yenileniyor...`);
        await this.schemaCache.refresh();
        await this.schemaCache.loadObjectDefinitions();

        for (let i = 0; i < objects.length; i++) {
            if (token.isCancellationRequested) { break; }

            const obj = objects[i];
            progress.report({
                message: `(${i + 1}/${total}) ${obj.name}`,
                increment: 100 / total,
            });

            try {
                const subDir = SUBDIRECTORY_MAP[obj.type] || obj.type;
                const filePath = path.join(exportPath, 'dbo', subDir, `${obj.name}.sql`);
                const script = this.getScript(obj, filePath);
                if (!script) { skipped++; continue; }

                const normalized = normalizeScript(script);

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

    private getScript(obj: ObjectInfo, existingFilePath?: string): string | null {
        if (obj.type === 'TABLE') {
            return this.buildTableScriptFromCache(obj.name, existingFilePath);
        }

        // VIEW / SP / FUNCTION / TRIGGER — cache'ten al
        return this.schemaCache.getObjectDefinition(obj.name) || null;
    }

    /** Format data type in SSDT style: UPPERCASE, unbracketed, with precision */
    private formatDataType(col: ColumnInfo): string {
        const dt = col.dataType.toLowerCase();
        const upper = col.dataType.toUpperCase();

        // String/binary types: NVARCHAR (250), VARCHAR (MAX)
        if (['varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary'].includes(dt)) {
            const len = col.maxLength === -1 ? 'MAX' : String(col.maxLength);
            return `${upper} (${len})`;
        }
        // Numeric types with precision: DECIMAL (18, 2)
        if (['decimal', 'numeric'].includes(dt) && col.numericPrecision != null) {
            return `${upper} (${col.numericPrecision}, ${col.numericScale ?? 0})`;
        }
        // Datetime types with precision: DATETIME2 (7)
        if (['datetime2', 'datetimeoffset', 'time'].includes(dt) && col.datetimePrecision != null) {
            return `${upper} (${col.datetimePrecision})`;
        }
        return upper;
    }

    /** Extract index names from existing file to preserve ordering */
    private getExistingIndexOrder(filePath: string): string[] {
        if (!fs.existsSync(filePath)) { return []; }
        const content = fs.readFileSync(filePath, 'utf-8');
        const order: string[] = [];
        const re = /CREATE\s+(?:UNIQUE\s+)?(?:CLUSTERED|NONCLUSTERED)\s+INDEX\s+\[([^\]]+)\]/gi;
        let m;
        while ((m = re.exec(content)) !== null) {
            order.push(m[1]);
        }
        return order;
    }

    /** Build CREATE TABLE script from cached schema data (SSDT format) */
    private buildTableScriptFromCache(tableName: string, existingFilePath?: string): string | null {
        const obj = this.schemaCache.findObject(tableName);
        if (!obj?.columns || obj.columns.length === 0) { return null; }

        const indexes = this.schemaCache.getIndexes(tableName);
        const fks = this.schemaCache.getForeignKeysForTable(tableName)
            .filter(fk => fk.parentTable.toLowerCase() === tableName.toLowerCase());

        // --- Build column definitions for alignment ---
        const colParts: { name: string; type: string; suffix: string }[] = [];
        for (const col of obj.columns) {
            const name = `[${col.name}]`;

            // Computed column: [Name] AS (expression)
            if (col.computedDefinition) {
                const persisted = col.isPersisted ? ' PERSISTED' : '';
                colParts.push({ name, type: `AS ${col.computedDefinition}${persisted}`, suffix: '' });
                continue;
            }

            const type = this.formatDataType(col);
            let suffix = '';
            if (col.isIdentity) { suffix += ' IDENTITY (1, 1)'; }
            if (col.hasDefault && col.defaultValue) {
                const dcName = col.defaultConstraintName ? `CONSTRAINT [${col.defaultConstraintName}] ` : '';
                suffix += ` ${dcName}DEFAULT ${col.defaultValue}`;
            }
            suffix += col.isNullable ? ' NULL' : ' NOT NULL';
            colParts.push({ name, type, suffix });
        }

        // Calculate alignment widths
        const maxNameLen = Math.max(...colParts.map(c => c.name.length));
        const maxTypeLen = Math.max(...colParts.map(c => c.type.length));

        // --- Build constraint lines (inline) ---
        const constraintLines: string[] = [];

        // PK inline
        const pk = indexes.find(idx => idx.isPrimaryKey);
        if (pk) {
            constraintLines.push(`    CONSTRAINT [${pk.name}] PRIMARY KEY ${pk.type} (${pk.columns})`);
        }

        // FK inline
        for (const fk of fks) {
            let fkLine = `    CONSTRAINT [${fk.fkName}] FOREIGN KEY ([${fk.parentColumn}]) REFERENCES [dbo].[${fk.referencedTable}] ([${fk.referencedColumn}])`;
            if (fk.deleteAction && fk.deleteAction !== 'NO_ACTION') {
                fkLine += ` ON DELETE ${fk.deleteAction.replace(/_/g, ' ')}`;
            }
            if (fk.updateAction && fk.updateAction !== 'NO_ACTION') {
                fkLine += ` ON UPDATE ${fk.updateAction.replace(/_/g, ' ')}`;
            }
            constraintLines.push(fkLine);
        }

        // --- Assemble CREATE TABLE ---
        const lines: string[] = [];
        lines.push(`CREATE TABLE [dbo].[${tableName}] (`);

        const allInlineItems = [...colParts.map((c) => {
            const padName = c.name.padEnd(maxNameLen);
            const padType = c.type.padEnd(maxTypeLen);
            return `    ${padName} ${padType}${c.suffix}`;
        }), ...constraintLines];

        for (let i = 0; i < allInlineItems.length; i++) {
            const comma = i < allInlineItems.length - 1 ? ',' : '';
            lines.push(allInlineItems[i] + comma);
        }

        lines.push(');');

        // --- Non-PK indexes (separate, SSDT format, preserve existing file order) ---
        let nonPkIndexes = indexes.filter(idx => !idx.isPrimaryKey);
        if (existingFilePath) {
            const existingOrder = this.getExistingIndexOrder(existingFilePath);
            if (existingOrder.length > 0) {
                const orderMap = new Map(existingOrder.map((name, i) => [name.toLowerCase(), i]));
                nonPkIndexes.sort((a, b) => {
                    const oa = orderMap.get(a.name.toLowerCase()) ?? 99999;
                    const ob = orderMap.get(b.name.toLowerCase()) ?? 99999;
                    return oa - ob;
                });
            }
        }
        for (const idx of nonPkIndexes) {
            lines.push('');
            lines.push('');
            lines.push('GO');
            const unique = idx.isUnique ? 'UNIQUE ' : '';
            const filter = idx.filterDefinition ? ` WHERE ${idx.filterDefinition}` : '';
            lines.push(`CREATE ${unique}${idx.type} INDEX [${idx.name}]`);
            lines.push(`    ON [dbo].[${tableName}](${idx.columns})${filter};`);
        }

        // Triggers (separate)
        const triggers = this.schemaCache.getTriggers(tableName);
        for (const trig of triggers) {
            if (trig.definition) {
                lines.push('');
                lines.push('');
                lines.push('GO');
                lines.push(trig.definition.trim());
            }
        }

        return lines.join('\n');
    }
}
