import * as vscode from 'vscode';
import { SchemaCache } from '../cache/schemaCache';
import { SqlContextType, detectContext, getCurrentStatement } from '../parser/sqlContext';

export class TsqlCompletionProvider implements vscode.CompletionItemProvider {
    constructor(private schemaCache: SchemaCache) {}

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): Promise<vscode.CompletionList | undefined> {
        if (!this.schemaCache.isLoaded) {
            return undefined;
        }

        const fullText = document.getText();
        const offset = document.offsetAt(position);
        const textBeforeCursor = fullText.substring(0, offset);
        const statementText = getCurrentStatement(fullText, offset);

        const context = detectContext(textBeforeCursor, statementText);

        switch (context.type) {
            case SqlContextType.AFTER_FROM_JOIN:
                return this.completeTableNames(context.prefix);

            case SqlContextType.AFTER_EXEC:
                return this.completeProcedureNames(context.prefix);

            case SqlContextType.AFTER_ALIAS_DOT:
                return await this.completeColumns(context.tableName!, context.prefix);

            case SqlContextType.AFTER_ALTER_PROC:
                return this.completeProcedureNames(context.prefix);

            default:
                return undefined;
        }
    }

    private completeTableNames(prefix?: string): vscode.CompletionList {
        const items: vscode.CompletionItem[] = [];
        const tablesAndViews = this.schemaCache.getTablesAndViews();

        for (const obj of tablesAndViews) {
            if (prefix && !obj.name.toLowerCase().startsWith(prefix.toLowerCase())) {
                continue;
            }

            const item = new vscode.CompletionItem(obj.name);
            item.kind = obj.type === 'TABLE'
                ? vscode.CompletionItemKind.Class
                : vscode.CompletionItemKind.Interface;
            item.detail = obj.type;
            item.sortText = `0_${obj.name}`; // Priority over mssql suggestions
            items.push(item);
        }

        return new vscode.CompletionList(items, true);
    }

    private completeProcedureNames(prefix?: string): vscode.CompletionList {
        const items: vscode.CompletionItem[] = [];
        const procedures = this.schemaCache.getProcedures();
        const functions = this.schemaCache.getFunctions();

        for (const obj of [...procedures, ...functions]) {
            if (prefix && !obj.name.toLowerCase().startsWith(prefix.toLowerCase())) {
                continue;
            }

            const item = new vscode.CompletionItem(obj.name);
            item.kind = obj.type === 'PROCEDURE'
                ? vscode.CompletionItemKind.Method
                : vscode.CompletionItemKind.Function;
            item.detail = obj.type;
            item.sortText = `0_${obj.name}`;
            items.push(item);
        }

        return new vscode.CompletionList(items, true);
    }

    private async completeColumns(tableName: string, prefix?: string): Promise<vscode.CompletionList> {
        const items: vscode.CompletionItem[] = [];
        const columns = await this.schemaCache.getColumns(tableName);

        for (const col of columns) {
            if (prefix && !col.name.toLowerCase().startsWith(prefix.toLowerCase())) {
                continue;
            }

            const item = new vscode.CompletionItem(col.name);
            item.kind = vscode.CompletionItemKind.Field;

            // Show data type info
            let typeStr = col.dataType;
            if (col.maxLength && col.maxLength > 0) {
                typeStr += `(${col.maxLength})`;
            }
            item.detail = typeStr;
            item.documentation = `${tableName}.${col.name} — ${typeStr}${col.isNullable ? ' NULL' : ' NOT NULL'}`;

            // Sort by ordinal position (columns appear in table order)
            item.sortText = `0_${String(col.ordinalPosition).padStart(4, '0')}`;

            items.push(item);
        }

        return new vscode.CompletionList(items, false);
    }
}
