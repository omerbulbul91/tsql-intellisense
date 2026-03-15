import * as vscode from 'vscode';
import { ConnectionManager, TYPES } from '../connection/connectionManager';
import { SchemaCache } from '../cache/schemaCache';

export class TsqlDefinitionProvider implements vscode.DefinitionProvider {
    constructor(
        private connectionManager: ConnectionManager,
        private schemaCache: SchemaCache
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
            script = this.schemaCache.getViewDefinition(word) || await this.getObjectDefinition(word);
        } else if (obj.type === 'TABLE') {
            script = this.buildTableScript(word);
        }

        if (!script) { return undefined; }

        // Open script in new untitled editor
        const doc = await vscode.workspace.openTextDocument({ content: script, language: 'sql' });
        await vscode.window.showTextDocument(doc, { preview: false });

        // Return a dummy location (required by API but we already opened the doc)
        return new vscode.Location(doc.uri, new vscode.Position(0, 0));
    }

    private async getObjectDefinition(name: string): Promise<string | null> {
        try {
            const result = await this.connectionManager.executeQuery(
                `SELECT OBJECT_DEFINITION(OBJECT_ID(@objectName)) AS [definition]`,
                { objectName: { type: TYPES.NVarChar, value: name } }
            );
            if (result.rows.length > 0 && result.rows[0]['definition']) {
                return result.rows[0]['definition'] as string;
            }
        } catch {}
        return null;
    }

    private buildTableScript(tableName: string): string | null {
        const obj = this.schemaCache.findObject(tableName);
        if (!obj || !obj.columns || obj.columns.length === 0) { return null; }

        const lines: string[] = [`CREATE TABLE [dbo].[${tableName}]`, '('];
        for (let i = 0; i < obj.columns.length; i++) {
            const col = obj.columns[i];
            let colDef = `    [${col.name}] [${col.dataType}]`;
            if (col.maxLength && col.maxLength > 0) {
                colDef += `(${col.maxLength})`;
            }
            colDef += col.isNullable ? ' NULL' : ' NOT NULL';
            if (i < obj.columns.length - 1) { colDef += ','; }
            lines.push(colDef);
        }
        lines.push(')');
        lines.push('GO');

        const indexes = this.schemaCache.getIndexes(tableName);
        const pk = indexes.find(idx => idx.isPrimaryKey);
        if (pk) {
            lines.push(`ALTER TABLE [dbo].[${tableName}] ADD CONSTRAINT [${pk.name}] PRIMARY KEY (${pk.columns})`);
            lines.push('GO');
        }
        for (const idx of indexes.filter(i => !i.isPrimaryKey)) {
            const unique = idx.isUnique ? 'UNIQUE ' : '';
            lines.push(`CREATE ${unique}${idx.type} INDEX [${idx.name}] ON [dbo].[${tableName}] (${idx.columns})`);
            lines.push('GO');
        }

        const fks = this.schemaCache.getForeignKeysForTable(tableName);
        for (const fk of fks) {
            lines.push(`ALTER TABLE [dbo].[${fk.parentTable}] ADD CONSTRAINT [${fk.fkName}] FOREIGN KEY ([${fk.parentColumn}]) REFERENCES [dbo].[${fk.referencedTable}] ([${fk.referencedColumn}])`);
            lines.push('GO');
        }

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
