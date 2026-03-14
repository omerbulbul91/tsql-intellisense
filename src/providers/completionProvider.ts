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
                return this.completeAlterProc();

            case SqlContextType.AFTER_SELECT:
                return await this.completeColumnsWithAlias(context.tableName!, context.prefix, context.alias, position);

            case SqlContextType.AFTER_TABLE_NAME:
                return this.completeAfterTableName(context.tableName);

            default:
                return undefined;
        }
    }

    /** Complete ALTER PROC — selecting an SP triggers fetching its code */
    private completeAlterProc(): vscode.CompletionList {
        const items: vscode.CompletionItem[] = [];
        const procedures = this.schemaCache.getProcedures();

        for (const obj of procedures) {
            // Skip functions that DB reports as PROCEDURE (F_, FN_, Fn_ prefixes)
            if (/^F\d{1,3}_|^FN\d{1,3}_|^Fn_/i.test(obj.name)) { continue; }
            const item = new vscode.CompletionItem(obj.name);
            item.kind = vscode.CompletionItemKind.Method;
            item.detail = 'PROCEDURE — select to fetch code';
            item.sortText = `0_${obj.name}`;
            item.filterText = obj.name;
            // When selected, trigger the alterProc command to fetch SP code
            item.command = {
                command: 'tsql-intellisense.fetchProcCode',
                title: 'Fetch SP Code',
                arguments: [obj.name],
            };
            items.push(item);
        }

        return new vscode.CompletionList(items, true);
    }

    /** Suggest SQL keywords + alias after FROM TableName */
    private completeAfterTableName(tableName?: string): vscode.CompletionList {
        const items: vscode.CompletionItem[] = [];

        // SQL keywords that can follow a table name
        const keywords = [
            { label: 'WHERE', detail: 'Filter rows' },
            { label: 'ORDER BY', detail: 'Sort results' },
            { label: 'GROUP BY', detail: 'Group rows' },
            { label: 'HAVING', detail: 'Filter groups' },
            { label: 'INNER JOIN', detail: 'Inner join' },
            { label: 'LEFT JOIN', detail: 'Left outer join' },
            { label: 'RIGHT JOIN', detail: 'Right outer join' },
            { label: 'CROSS JOIN', detail: 'Cross join' },
            { label: 'ON', detail: 'Join condition' },
            { label: 'AS', detail: 'Alias' },
        ];

        for (const kw of keywords) {
            const item = new vscode.CompletionItem(kw.label);
            item.kind = vscode.CompletionItemKind.Keyword;
            item.detail = kw.detail;
            item.sortText = `0_${kw.label}`;
            item.filterText = kw.label;
            items.push(item);
        }

        return new vscode.CompletionList(items, true);
    }

    private completeTableNames(prefix?: string): vscode.CompletionList {
        const items: vscode.CompletionItem[] = [];
        const tablesAndViews = this.schemaCache.getTablesAndViews();

        for (const obj of tablesAndViews) {
            const alias = this.generateAlias(obj.name);
            const item = new vscode.CompletionItem(obj.name);
            item.kind = obj.type === 'TABLE'
                ? vscode.CompletionItemKind.Class
                : vscode.CompletionItemKind.Interface;
            item.detail = obj.type;
            item.sortText = `0_${obj.name}`;
            item.filterText = obj.name;
            // Insert table name + alias (e.g. "RN100_Kullanicilar k")
            if (alias) {
                item.insertText = `${obj.name} ${alias}`;
            }
            items.push(item);
        }

        return new vscode.CompletionList(items, true);
    }

    /** Generate a short alias from a table name */
    private generateAlias(tableName: string): string | null {
        // Remove prefix like RN06_, CV04_, SP06_, IT01_, TMP06_ etc.
        const withoutPrefix = tableName.replace(/^[A-Z]{1,4}\d{1,3}_/, '');
        if (!withoutPrefix) { return null; }

        // Get uppercase letters as alias (e.g. StokAmbarNo → SAN, HareketFisM → HFM)
        const uppers = withoutPrefix.match(/[A-Z]/g);
        if (uppers && uppers.length >= 2) {
            return uppers.join('').toLowerCase();
        }

        // Fallback: first letter
        return withoutPrefix[0].toLowerCase();
    }

    private completeProcedureNames(prefix?: string): vscode.CompletionList {
        const items: vscode.CompletionItem[] = [];
        const procedures = this.schemaCache.getProcedures();
        const functions = this.schemaCache.getFunctions();

        for (const obj of [...procedures, ...functions]) {
            const item = new vscode.CompletionItem(obj.name);
            item.kind = obj.type === 'PROCEDURE'
                ? vscode.CompletionItemKind.Method
                : vscode.CompletionItemKind.Function;
            item.detail = obj.type;
            item.sortText = `0_${obj.name}`;
            item.filterText = obj.name;
            items.push(item);
        }

        return new vscode.CompletionList(items, true);
    }

    /** Complete columns with alias prefix (for SELECT/WHERE context) */
    private async completeColumnsWithAlias(tableName: string, prefix?: string, alias?: string, position?: vscode.Position): Promise<vscode.CompletionList> {
        const items: vscode.CompletionItem[] = [];
        const columns = await this.schemaCache.getColumns(tableName);
        const aliasPrefix = alias ? `${alias}.` : '';

        // Calculate range that includes * or typed prefix
        let replaceRange: vscode.Range | undefined;
        if (position && prefix) {
            replaceRange = new vscode.Range(
                position.line, position.character - prefix.length,
                position.line, position.character
            );
        }

        // Add "* (expand all)" snippet
        if (columns.length > 0 && alias) {
            const starItem = new vscode.CompletionItem('* (expand all columns)', vscode.CompletionItemKind.Snippet);
            starItem.detail = `${columns.length} columns with ${alias}. prefix`;
            starItem.sortText = '0_0000';
            starItem.filterText = '* expand all';
            const allCols = columns.map(c => `${aliasPrefix}${c.name}`).join(',\n\t');
            starItem.insertText = new vscode.SnippetString(allCols);
            if (replaceRange) {
                starItem.range = replaceRange;
            }
            items.push(starItem);
        }

        for (const col of columns) {
            // Show alias in label (e.g. "k.KullaniciID")
            const displayName = alias ? `${aliasPrefix}${col.name}` : col.name;
            const item = new vscode.CompletionItem(displayName);
            item.kind = vscode.CompletionItemKind.Field;

            let typeStr = col.dataType;
            if (col.maxLength && col.maxLength > 0) {
                typeStr += `(${col.maxLength})`;
            }
            item.detail = typeStr;
            item.documentation = `${tableName}.${col.name} — ${typeStr}${col.isNullable ? ' NULL' : ' NOT NULL'}`;
            item.sortText = `0_${String(col.ordinalPosition).padStart(4, '0')}`;
            // Filter by column name (without alias) so "kull" still matches "k.KullaniciID"
            item.filterText = col.name;
            item.insertText = displayName;

            items.push(item);
        }

        return new vscode.CompletionList(items, false);
    }

    /** Complete columns without alias (for alias.dot context) */
    private async completeColumns(tableName: string, prefix?: string): Promise<vscode.CompletionList> {
        const items: vscode.CompletionItem[] = [];
        const columns = await this.schemaCache.getColumns(tableName);

        for (const col of columns) {
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
            item.filterText = col.name;

            items.push(item);
        }

        return new vscode.CompletionList(items, false);
    }
}
