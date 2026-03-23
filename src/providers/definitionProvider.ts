import * as vscode from 'vscode';
import { ConnectionManager, TYPES } from '../connection/connectionManager';
import { SchemaCache } from '../cache/schemaCache';
import { QueryRunner } from './queryRunner';

const TABLE_SCRIPT_QUERY = `
SELECT
    s.name AS SchemaName,
    c.name AS ColumnName,
    t.name AS TypeName,
    CASE
        WHEN t.name IN ('nvarchar','nchar') THEN CASE WHEN c.max_length = -1 THEN -1 ELSE c.max_length / 2 END
        ELSE c.max_length
    END AS MaxLength,
    c.precision AS [Precision],
    c.scale AS Scale,
    c.is_nullable AS IsNullable,
    c.is_identity AS IsIdentity,
    CAST(ISNULL(ic.seed_value, 0) AS INT) AS IdentitySeed,
    CAST(ISNULL(ic.increment_value, 0) AS INT) AS IdentityIncrement,
    dc.definition AS DefaultDefinition,
    cc.definition AS ComputedDefinition
FROM sys.columns c
JOIN sys.types t ON c.user_type_id = t.user_type_id
JOIN sys.objects o ON c.object_id = o.object_id
JOIN sys.schemas s ON o.schema_id = s.schema_id
LEFT JOIN sys.identity_columns ic ON c.object_id = ic.object_id AND c.column_id = ic.column_id
LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id
LEFT JOIN sys.computed_columns cc ON c.object_id = cc.object_id AND c.column_id = cc.column_id
WHERE o.name = @tableName AND o.type = 'U'
ORDER BY c.column_id`;

const INDEX_SCRIPT_QUERY = `
SELECT
    i.name AS IndexName,
    i.is_primary_key AS IsPrimaryKey,
    i.is_unique AS IsUnique,
    CASE i.type WHEN 1 THEN 'CLUSTERED' WHEN 2 THEN 'NONCLUSTERED' ELSE 'NONCLUSTERED' END AS IndexType,
    STRING_AGG('[' + col.name + ']' + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END, ', ')
        WITHIN GROUP (ORDER BY ic.key_ordinal) AS Columns
FROM sys.indexes i
JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id AND ic.is_included_column = 0
JOIN sys.columns col ON ic.object_id = col.object_id AND ic.column_id = col.column_id
WHERE i.object_id = OBJECT_ID(@tableName) AND i.name IS NOT NULL
GROUP BY i.name, i.is_primary_key, i.is_unique, i.type
ORDER BY i.is_primary_key DESC, i.name`;

const FK_SCRIPT_QUERY = `
SELECT
    fk.name AS FKName,
    cp.name AS ParentColumn,
    OBJECT_NAME(fk.referenced_object_id) AS ReferencedTable,
    cr.name AS ReferencedColumn
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
JOIN sys.columns cp ON fkc.parent_object_id = cp.object_id AND fkc.parent_column_id = cp.column_id
JOIN sys.columns cr ON fkc.referenced_object_id = cr.object_id AND fkc.referenced_column_id = cr.column_id
WHERE fk.parent_object_id = OBJECT_ID(@tableName)
ORDER BY fk.name`;

const CHECK_SCRIPT_QUERY = `
SELECT
    cc.name AS CheckName,
    cc.definition AS CheckDefinition
FROM sys.check_constraints cc
WHERE cc.parent_object_id = OBJECT_ID(@tableName)
ORDER BY cc.name`;

const TRIGGER_SCRIPT_QUERY = `
SELECT
    OBJECT_DEFINITION(tr.object_id) AS TriggerDefinition
FROM sys.triggers tr
WHERE tr.parent_id = OBJECT_ID(@tableName)
ORDER BY tr.name`;

export class TsqlDefinitionProvider implements vscode.DefinitionProvider {
    constructor(
        private connectionManager: ConnectionManager,
        private schemaCache: SchemaCache,
        private queryRunner?: QueryRunner
    ) {}

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Location | undefined> {
        const wordRange = document.getWordRangeAtPosition(position, /[\w]+/);
        if (!wordRange) { return undefined; }

        const word = document.getText(wordRange);
        if (!word || !this.connectionManager.isConnected) { return undefined; }

        const obj = this.schemaCache.findObject(word);
        if (!obj) { return undefined; }

        // Fetch definition and open in new tab
        let script: string | null = null;

        if (obj.type === 'PROCEDURE' || obj.type === 'FUNCTION') {
            script = await this.getObjectDefinition(word);
        } else if (obj.type === 'VIEW') {
            script = await this.getObjectDefinition(word);
            // Update view definition cache + refresh columns
            if (script) { this.schemaCache.setViewDefinition(word, script); }
            this.schemaCache.loadColumnsFor(word, true).catch(() => {});
        } else if (obj.type === 'TABLE') {
            script = await this.buildTableScript(word);
            // Refresh column cache for this table
            this.schemaCache.loadColumnsFor(word, true).catch(() => {});
        }

        if (!script) { return undefined; }

        // Create document without showing it — VS Code will navigate on Ctrl+click.
        // showTextDocument here would cause the tab to open on Ctrl+hover too.
        const sourceDb = this.queryRunner?.getDocumentDatabase(document.uri);
        const doc = await vscode.workspace.openTextDocument({ content: script, language: 'sql' });
        if (sourceDb) {
            this.queryRunner!.setDocumentDatabase(doc.uri, sourceDb);
        }

        return new vscode.Location(doc.uri, new vscode.Position(0, 0));
    }

    private async getObjectDefinition(name: string): Promise<string | null> {
        try {
            const result = await this.connectionManager.executeQuery(
                `SELECT COALESCE(
                    OBJECT_DEFINITION(OBJECT_ID(@objectName)),
                    OBJECT_DEFINITION(OBJECT_ID(@objectName, 'TR'))
                ) AS [definition]`,
                { objectName: { type: TYPES.NVarChar, value: name } }
            );
            if (result.rows.length > 0 && result.rows[0]['definition']) {
                let def = result.rows[0]['definition'] as string;
                // CREATE → ALTER dönüşümü
                def = def.replace(/^(\s*)CREATE\s+/i, '$1ALTER ');
                return def;
            }
        } catch {}
        return null;
    }

    private async buildTableScript(tableName: string): Promise<string | null> {
        try {
            const result = await this.connectionManager.executeQuery(
                TABLE_SCRIPT_QUERY,
                { tableName: { type: TYPES.NVarChar, value: tableName } }
            );
            if (result.rows.length === 0) { return null; }

            const lines: string[] = [];
            const schemaName = result.rows[0]['SchemaName'] as string || 'dbo';

            // -- CREATE TABLE
            lines.push(`CREATE TABLE [${schemaName}].[${tableName}]`, '(');
            for (let i = 0; i < result.rows.length; i++) {
                const row = result.rows[i];
                const colName = row['ColumnName'] as string;
                const typeName = row['TypeName'] as string;
                const maxLen = row['MaxLength'] as number;
                const precision = row['Precision'] as number;
                const scale = row['Scale'] as number;
                const isNullable = row['IsNullable'] as boolean;
                const isIdentity = row['IsIdentity'] as boolean;
                const identSeed = row['IdentitySeed'] as number;
                const identIncr = row['IdentityIncrement'] as number;
                const defaultDef = row['DefaultDefinition'] as string | null;
                const computedDef = row['ComputedDefinition'] as string | null;

                let colDef = `    [${colName}]`;

                if (computedDef) {
                    colDef += ` AS ${computedDef}`;
                } else {
                    colDef += ` [${typeName}]`;
                    if (['varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary'].includes(typeName)) {
                        colDef += maxLen === -1 ? '(MAX)' : `(${maxLen})`;
                    } else if (['decimal', 'numeric'].includes(typeName)) {
                        colDef += `(${precision}, ${scale})`;
                    }
                    if (isIdentity) {
                        colDef += ` IDENTITY(${identSeed}, ${identIncr})`;
                    }
                    colDef += isNullable ? ' NULL' : ' NOT NULL';
                    if (defaultDef) {
                        colDef += ` DEFAULT ${defaultDef}`;
                    }
                }

                if (i < result.rows.length - 1) { colDef += ','; }
                lines.push(colDef);
            }
            lines.push(')');
            lines.push('GO');

            // -- PK & Indexes
            const idxResult = await this.connectionManager.executeQuery(
                INDEX_SCRIPT_QUERY,
                { tableName: { type: TYPES.NVarChar, value: tableName } }
            );
            for (const row of idxResult.rows) {
                const idxName = row['IndexName'] as string;
                const isPK = row['IsPrimaryKey'] as boolean;
                const isUnique = row['IsUnique'] as boolean;
                const idxType = row['IndexType'] as string;
                const columns = row['Columns'] as string;

                if (isPK) {
                    lines.push(`ALTER TABLE [${schemaName}].[${tableName}] ADD CONSTRAINT [${idxName}] PRIMARY KEY ${idxType} (${columns})`);
                } else {
                    const unique = isUnique ? 'UNIQUE ' : '';
                    lines.push(`CREATE ${unique}${idxType} INDEX [${idxName}] ON [${schemaName}].[${tableName}] (${columns})`);
                }
                lines.push('GO');
            }

            // -- Foreign Keys
            const fkResult = await this.connectionManager.executeQuery(
                FK_SCRIPT_QUERY,
                { tableName: { type: TYPES.NVarChar, value: tableName } }
            );
            for (const row of fkResult.rows) {
                const fkName = row['FKName'] as string;
                const parentCol = row['ParentColumn'] as string;
                const refTable = row['ReferencedTable'] as string;
                const refCol = row['ReferencedColumn'] as string;
                lines.push(`ALTER TABLE [${schemaName}].[${tableName}] ADD CONSTRAINT [${fkName}] FOREIGN KEY ([${parentCol}]) REFERENCES [dbo].[${refTable}] ([${refCol}])`);
                lines.push('GO');
            }

            // -- Check Constraints
            const chkResult = await this.connectionManager.executeQuery(
                CHECK_SCRIPT_QUERY,
                { tableName: { type: TYPES.NVarChar, value: tableName } }
            );
            for (const row of chkResult.rows) {
                const chkName = row['CheckName'] as string;
                const chkDef = row['CheckDefinition'] as string;
                lines.push(`ALTER TABLE [${schemaName}].[${tableName}] ADD CONSTRAINT [${chkName}] CHECK ${chkDef}`);
                lines.push('GO');
            }

            // -- Triggers
            const trigResult = await this.connectionManager.executeQuery(
                TRIGGER_SCRIPT_QUERY,
                { tableName: { type: TYPES.NVarChar, value: tableName } }
            );
            for (const row of trigResult.rows) {
                const trigDef = row['TriggerDefinition'] as string;
                if (trigDef) {
                    lines.push(trigDef.trim());
                    lines.push('GO');
                }
            }

            return lines.join('\n');
        } catch {
            return null;
        }
    }
}
