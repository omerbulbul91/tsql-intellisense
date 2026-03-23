import * as vscode from 'vscode';
import { SchemaCache } from '../cache/schemaCache';
import { QueryRunner } from './queryRunner';
import { SqlContextType, SqlContext, AliasMapping, detectContext, getCurrentStatement, extractNonAggColumns } from '../parser/sqlContext';
import { FUNCTIONS } from '../formatter/sqlTokenizer';

export class TsqlCompletionProvider implements vscode.CompletionItemProvider {
    constructor(private schemaCache: SchemaCache, private queryRunner?: QueryRunner) {}

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): Promise<vscode.CompletionList | undefined> {
        const result = await this.provideCompletionItemsInner(document, position, _token, _context);
        if (result) {
            const chars = TsqlCompletionProvider.getCommitCharacters();
            for (const item of result.items) {
                // Tag all items with extension name
                if (typeof item.detail === 'string') {
                    item.detail = `T-SQL • ${item.detail}`;
                } else if (!item.detail) {
                    item.detail = 'T-SQL';
                }
                // Commit characters
                if (chars.length > 0 && !item.commitCharacters) {
                    item.commitCharacters = chars;
                }
            }
        }
        return result;
    }

    private static getCommitCharacters(): string[] {
        const keys = vscode.workspace.getConfiguration('tsql-intellisense').get<any>('insertionKeys', {});
        const chars: string[] = [];
        if (keys.space) chars.push(' ');
        if (keys.dot) chars.push('.');
        if (keys.parentheses) chars.push('(', ')');
        if (keys.comma) chars.push(',');
        if (keys.bracket) chars.push(']');
        if (keys.semicolon) chars.push(';');
        return chars;
    }

    private async provideCompletionItemsInner(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): Promise<vscode.CompletionList | undefined> {
        // Determine the effective DB for this document
        const docDb = this.queryRunner?.getDocumentDatabase(document.uri);
        const dbName = docDb?.dbName;

        // Check if schema is loaded for this doc's DB
        const effectiveObjects = dbName ? this.schemaCache.getObjectsForDb(dbName) : null;
        const isLoaded = effectiveObjects ? effectiveObjects.size > 0 : this.schemaCache.isLoaded;
        if (!isLoaded) {
            return undefined;
        }

        const fullText = document.getText();
        const offset = document.offsetAt(position);
        const textBeforeCursor = fullText.substring(0, offset);
        const statementText = getCurrentStatement(fullText, offset);

        const context = detectContext(textBeforeCursor, statementText);

        switch (context.type) {
            case SqlContextType.AFTER_FROM_JOIN:
                return this.completeTableNames(context.prefix, dbName, context.hasSchemaPrefix);

            case SqlContextType.AFTER_EXEC:
                return this.completeProcedureNames(context.prefix, dbName);

            case SqlContextType.AFTER_ALIAS_DOT:
                return await this.completeColumns(context.tableName!, context.prefix, dbName);

            case SqlContextType.AFTER_ALTER_PROC:
                return this.completeAlterProc(dbName);

            case SqlContextType.AFTER_SELECT:
                return await this.completeColumnsWithAlias(context.tableName!, context.prefix, context.alias, position, dbName, textBeforeCursor, context.aliases);

            case SqlContextType.AFTER_TABLE_NAME:
                return this.completeAfterTableName(context.tableName);

            case SqlContextType.AFTER_ORDER_BY_COLUMN:
                return this.completeOrderByDirection(context.prefix);

            case SqlContextType.AFTER_ON:
                return await this.completeJoinCondition(context, dbName);

            case SqlContextType.AFTER_GROUP_BY:
                return await this.completeGroupBy(context, statementText, dbName);

            case SqlContextType.AFTER_INSERT_INTO:
                return this.completeInsertTable(context.prefix, position, dbName);

            case SqlContextType.AFTER_ALTER_CREATE:
                return this.completeAlterCreateObjects(context.prefix);

            case SqlContextType.AFTER_ALTER_OBJECT:
                return this.completeObjectsByType(context.alias, context.prefix, dbName);

            case SqlContextType.NONE:
                return this.completeStatementStart(context.prefix);

            default:
                return undefined;
        }
    }

    /** Suggest SQL statement keywords when no specific context matches */
    private completeStatementStart(prefix?: string): vscode.CompletionList | undefined {
        // Only trigger if there's a partial word being typed
        if (!prefix) { return undefined; }

        const items: vscode.CompletionItem[] = [];
        const keywords = [
            { label: 'SELECT', detail: 'Query data' },
            { label: 'EXEC', detail: 'Execute stored procedure' },
            { label: 'INSERT INTO', detail: 'Insert rows' },
            { label: 'UPDATE', detail: 'Update rows' },
            { label: 'DELETE FROM', detail: 'Delete rows' },
            { label: 'ALTER PROCEDURE', detail: 'Modify stored procedure' },
            { label: 'CREATE PROCEDURE', detail: 'Create stored procedure' },
            { label: 'ALTER TABLE', detail: 'Modify table' },
            { label: 'CREATE TABLE', detail: 'Create table' },
            { label: 'ALTER VIEW', detail: 'Modify view' },
            { label: 'CREATE VIEW', detail: 'Create view' },
            { label: 'BEGIN TRANSACTION', detail: 'Start transaction' },
            { label: 'COMMIT', detail: 'Commit transaction' },
            { label: 'ROLLBACK', detail: 'Rollback transaction' },
            { label: 'DECLARE', detail: 'Declare variable' },
            { label: 'SET', detail: 'Set variable value' },
            { label: 'IF', detail: 'Conditional' },
            { label: 'WHILE', detail: 'Loop' },
            { label: 'PRINT', detail: 'Print message' },
            { label: 'GO', detail: 'Batch separator' },
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

    /** Complete ALTER PROC — selecting an SP triggers fetching its code */
    private completeAlterProc(dbName?: string): vscode.CompletionList {
        const items: vscode.CompletionItem[] = [];
        const procedures = dbName
            ? Array.from(this.schemaCache.getObjectsForDb(dbName).values()).filter(o => o.type === 'PROCEDURE')
            : this.schemaCache.getProcedures();

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

        const list = new vscode.CompletionList(items, true);
        (list as any).__isAlterProc = true;
        return list;
    }

    /** Lazily fetch live object definition for ALTER PROC/VIEW/FUNCTION/TRIGGER hover preview */
    async resolveCompletionItem(item: vscode.CompletionItem): Promise<vscode.CompletionItem> {
        const detail = item.detail ?? '';
        const fetchable = detail === 'PROCEDURE — select to fetch code'
            || detail === 'VIEW' || detail === 'FUNCTION' || detail === 'TRIGGER';
        if (!fetchable) { return item; }
        const name = typeof item.label === 'string' ? item.label : item.label.label;
        const def = await this.schemaCache.fetchObjectDefinition(name);
        if (def) {
            const md = new vscode.MarkdownString();
            md.appendCodeblock(def, 'sql');
            item.documentation = md;
        }
        return item;
    }

    /** Suggest object types after ALTER/CREATE */
    private completeAlterCreateObjects(prefix?: string): vscode.CompletionList {
        const items: vscode.CompletionItem[] = [];
        const objectTypes = [
            { label: 'PROCEDURE', detail: 'Stored procedure' },
            { label: 'PROC', detail: 'Stored procedure (short)' },
            { label: 'FUNCTION', detail: 'User-defined function' },
            { label: 'TABLE', detail: 'Table' },
            { label: 'VIEW', detail: 'View' },
            { label: 'INDEX', detail: 'Index' },
            { label: 'TRIGGER', detail: 'Trigger' },
            { label: 'DATABASE', detail: 'Database' },
            { label: 'SCHEMA', detail: 'Schema' },
            { label: 'LOGIN', detail: 'Login' },
            { label: 'USER', detail: 'Database user' },
            { label: 'ROLE', detail: 'Database role' },
            { label: 'APPLICATION ROLE', detail: 'Application role' },
            { label: 'ASSEMBLY', detail: 'Assembly' },
            { label: 'ASYMMETRIC KEY', detail: 'Asymmetric key' },
            { label: 'AUTHORIZATION ON', detail: 'Authorization' },
            { label: 'AVAILABILITY GROUP', detail: 'Availability group' },
            { label: 'BROKER PRIORITY', detail: 'Broker priority' },
            { label: 'CERTIFICATE', detail: 'Certificate' },
            { label: 'COLUMN ENCRYPTION KEY', detail: 'Column encryption key' },
            { label: 'CREDENTIAL', detail: 'Credential' },
            { label: 'CRYPTOGRAPHIC PROVIDER', detail: 'Cryptographic provider' },
            { label: 'DATABASE AUDIT SPECIFICATION', detail: 'Database audit spec' },
            { label: 'DATABASE ENCRYPTION KEY', detail: 'Database encryption key' },
            { label: 'DATABASE SCOPED', detail: 'Database scoped' },
            { label: 'DATABASE SCOPED CONFIGURATION', detail: 'Database scoped config' },
            { label: 'ENDPOINT', detail: 'Endpoint' },
        ];

        for (const ot of objectTypes) {
            const item = new vscode.CompletionItem(ot.label);
            item.kind = vscode.CompletionItemKind.Keyword;
            item.detail = ot.detail;
            item.sortText = `0_${ot.label}`;
            item.filterText = ot.label;
            items.push(item);
        }

        return new vscode.CompletionList(items, true);
    }

    /** Suggest objects by type: ALTER TABLE → tables, ALTER VIEW → views, etc. */
    private completeObjectsByType(objType?: string, prefix?: string, dbName?: string): vscode.CompletionList {
        const items: vscode.CompletionItem[] = [];
        const type = (objType || '').toUpperCase();

        const dbObjects = dbName ? this.schemaCache.getObjectsForDb(dbName) : null;

        let objects: { name: string; type: string }[] = [];
        if (type === 'TABLE') {
            objects = dbObjects
                ? Array.from(dbObjects.values()).filter(o => o.type === 'TABLE')
                : this.schemaCache.getTablesAndViews().filter(o => o.type === 'TABLE');
        } else if (type === 'VIEW') {
            objects = dbObjects
                ? Array.from(dbObjects.values()).filter(o => o.type === 'VIEW')
                : this.schemaCache.getTablesAndViews().filter(o => o.type === 'VIEW');
        } else if (type === 'FUNCTION') {
            objects = dbObjects
                ? Array.from(dbObjects.values()).filter(o => o.type === 'FUNCTION')
                : this.schemaCache.getFunctions();
        } else if (type === 'TRIGGER') {
            const sourceMap = dbObjects || this.schemaCache.getObjectsForDb('');
            objects = Array.from(sourceMap.values()).filter(o => o.type === 'TRIGGER');
        }

        for (const obj of objects) {
            const qualifiedName = `dbo.${obj.name}`;
            const item = new vscode.CompletionItem(qualifiedName);
            item.kind = type === 'TRIGGER' ? vscode.CompletionItemKind.Event
                : type === 'FUNCTION' ? vscode.CompletionItemKind.Function
                : type === 'VIEW' ? vscode.CompletionItemKind.Interface
                : vscode.CompletionItemKind.Class;
            item.detail = obj.type;
            item.sortText = `0_${obj.name}`;
            item.filterText = `${obj.name} dbo.${obj.name}`;
            item.insertText = qualifiedName;
            // ALTER TABLE sadece isim tamamlar, script açmaz
            // Diğerleri (VIEW, FUNCTION, TRIGGER) seçilince definition açar
            if (type !== 'TABLE') {
                item.command = {
                    command: 'tsql-intellisense.openObjectDefinition',
                    title: 'Open Definition',
                    arguments: [obj.name],
                };
            }
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
            { label: 'GO', detail: 'Batch separator' },
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

    /** Suggest ASC/DESC after ORDER BY column */
    private completeOrderByDirection(prefix?: string): vscode.CompletionList {
        const items: vscode.CompletionItem[] = [];
        const directions = [
            { label: 'ASC', detail: 'Ascending order' },
            { label: 'DESC', detail: 'Descending order' },
        ];

        for (const dir of directions) {
            const item = new vscode.CompletionItem(dir.label);
            item.kind = vscode.CompletionItemKind.Keyword;
            item.detail = dir.detail;
            item.sortText = `0_${dir.label}`;
            item.filterText = dir.label;
            items.push(item);
        }

        return new vscode.CompletionList(items, true);
    }

    /** GROUP BY completion: "All non-aggregated columns" snippet + aliases + columns */
    private async completeGroupBy(context: SqlContext, statementText: string, dbName?: string): Promise<vscode.CompletionList> {
        const items: vscode.CompletionItem[] = [];
        const { aliases } = context;

        // 1. "All non-aggregated columns" snippet (highest priority)
        const nonAggCols = extractNonAggColumns(statementText);
        if (nonAggCols.length > 0) {
            const snippet = nonAggCols.join(',\n\t');
            const item = new vscode.CompletionItem('All non-aggregated columns', vscode.CompletionItemKind.Snippet);
            item.detail = `${nonAggCols.length} columns`;
            item.documentation = nonAggCols.join(', ');
            item.sortText = '0_0000';
            item.filterText = 'all non aggregated columns';
            item.insertText = new vscode.SnippetString(snippet);
            items.push(item);
        }

        // 2. Aliases
        if (aliases && aliases.length > 0) {
            for (let i = 0; i < aliases.length; i++) {
                const a = aliases[i];
                const item = new vscode.CompletionItem(a.alias);
                item.kind = vscode.CompletionItemKind.Variable;
                item.detail = a.tableName;
                item.sortText = `1_${String(i).padStart(4, '0')}`;
                item.insertText = a.alias;
                item.command = {
                    command: 'editor.action.triggerSuggest',
                    title: 'Trigger Suggest',
                };
                items.push(item);
            }

            // 3. All columns from all aliases
            let colIndex = 0;
            for (let i = 0; i < aliases.length; i++) {
                const a = aliases[i];
                const columns = dbName
                    ? await this.schemaCache.loadColumnsForDbTable(dbName, a.tableName)
                    : await this.schemaCache.getColumns(a.tableName);
                for (const col of columns) {
                    const displayName = `${a.alias}.${col.name}`;
                    const item = new vscode.CompletionItem(displayName);
                    item.kind = vscode.CompletionItemKind.Field;
                    let typeStr = col.dataType;
                    if (col.maxLength && col.maxLength > 0) {
                        typeStr += `(${col.maxLength})`;
                    }
                    item.detail = typeStr;
                    item.sortText = `2_${String(i).padStart(2, '0')}_${String(col.ordinalPosition).padStart(4, '0')}`;
                    item.filterText = `${a.alias} ${col.name}`;
                    item.insertText = displayName;
                    items.push(item);
                    colIndex++;
                }
            }
        }

        return new vscode.CompletionList(items, true);
    }

    /** Suggest join conditions: FK matches first, then same-name columns, then aliases */
    private async completeJoinCondition(context: SqlContext, dbName?: string): Promise<vscode.CompletionList> {
        const items: vscode.CompletionItem[] = [];
        const { joinedTable, joinedAlias, aliases } = context;

        // After = sign: show aliases first, then all columns from all aliases
        if (!joinedTable && aliases && aliases.length > 0) {
            // 1. Aliases (highest priority, FROM clause order)
            for (let i = 0; i < aliases.length; i++) {
                const a = aliases[i];
                const item = new vscode.CompletionItem(a.alias);
                item.kind = vscode.CompletionItemKind.Variable;
                item.detail = a.tableName;
                item.sortText = `0_${String(i).padStart(4, '0')}`;
                item.filterText = `${a.alias} ${a.tableName}`;
                item.insertText = a.alias;
                item.command = {
                    command: 'editor.action.triggerSuggest',
                    title: 'Trigger Suggest',
                };
                items.push(item);
            }

            // 2. All columns from all aliases
            let colIndex = 0;
            for (let i = 0; i < aliases.length; i++) {
                const a = aliases[i];
                const columns = dbName
                    ? await this.schemaCache.loadColumnsForDbTable(dbName, a.tableName)
                    : await this.schemaCache.getColumns(a.tableName);
                for (const col of columns) {
                    const displayName = `${a.alias}.${col.name}`;
                    const item = new vscode.CompletionItem(displayName);
                    item.kind = vscode.CompletionItemKind.Field;
                    let typeStr = col.dataType;
                    if (col.maxLength && col.maxLength > 0) {
                        typeStr += `(${col.maxLength})`;
                    }
                    item.detail = typeStr;
                    // Sort: alias order first, then column ordinal
                    item.sortText = `1_${String(i).padStart(2, '0')}_${String(col.ordinalPosition).padStart(4, '0')}`;
                    // Filter by alias + column name so typing "r" or "RolID" both work
                    item.filterText = `${a.alias} ${col.name}`;
                    item.insertText = displayName;
                    items.push(item);
                    colIndex++;
                }
            }

            return new vscode.CompletionList(items, true);
        }

        if (!joinedTable || !joinedAlias || !aliases || aliases.length === 0) {
            return new vscode.CompletionList(items, true);
        }

        // Get columns of the joined table
        const joinedColumns = dbName
            ? await this.schemaCache.loadColumnsForDbTable(dbName, joinedTable)
            : await this.schemaCache.getColumns(joinedTable);

        // Find other tables in the statement (FROM table and other JOINs)
        const otherAliases = aliases.filter(a => a.alias.toLowerCase() !== joinedAlias.toLowerCase());

        const addedConditions = new Set<string>();
        let sortIndex = 0;
        const joinConfig = vscode.workspace.getConfiguration('tsql-intellisense');
        const matchNames = joinConfig.get<boolean>('joinMatchingNames', true);
        const swapOrder = joinConfig.get<boolean>('joinSwapColumnOrder', false);

        for (const other of otherAliases) {
            const otherColumns = dbName
                ? await this.schemaCache.loadColumnsForDbTable(dbName, other.tableName)
                : await this.schemaCache.getColumns(other.tableName);

            // 1. FK relationships (highest priority)
            const fks = this.schemaCache.getForeignKeysBetween(joinedTable, other.tableName);
            for (const fk of fks) {
                let joinCol: string;
                let otherCol: string;
                if (fk.parentTable.toLowerCase() === joinedTable.toLowerCase()) {
                    joinCol = fk.parentColumn;
                    otherCol = fk.referencedColumn;
                } else {
                    joinCol = fk.referencedColumn;
                    otherCol = fk.parentColumn;
                }

                const label = swapOrder
                    ? `${other.alias}.${otherCol} = ${joinedAlias}.${joinCol}`
                    : `${joinedAlias}.${joinCol} = ${other.alias}.${otherCol}`;
                if (addedConditions.has(label.toLowerCase())) { continue; }
                addedConditions.add(label.toLowerCase());

                const item = new vscode.CompletionItem(label);
                item.kind = vscode.CompletionItemKind.Reference;
                item.detail = `FK: ${fk.fkName}`;
                item.sortText = `0_${String(sortIndex++).padStart(4, '0')}`;
                item.filterText = `${joinedAlias} ${joinCol} ${otherCol}`;
                item.insertText = label;
                items.push(item);
            }

            // 2. Same-name columns (controlled by joinMatchingNames setting)
            if (!matchNames) { continue; }
            for (const jCol of joinedColumns) {
                const matchingCol = otherColumns.find(
                    c => c.name.toLowerCase() === jCol.name.toLowerCase()
                );
                if (!matchingCol) { continue; }

                const label = swapOrder
                    ? `${other.alias}.${matchingCol.name} = ${joinedAlias}.${jCol.name}`
                    : `${joinedAlias}.${jCol.name} = ${other.alias}.${matchingCol.name}`;
                if (addedConditions.has(label.toLowerCase())) { continue; }
                addedConditions.add(label.toLowerCase());

                const item = new vscode.CompletionItem(label);
                item.kind = vscode.CompletionItemKind.Field;
                item.detail = `Same column: ${jCol.dataType}`;
                item.sortText = `1_${String(sortIndex++).padStart(4, '0')}`;
                item.filterText = `${joinedAlias} ${jCol.name}`;
                item.insertText = label;
                items.push(item);
            }
        }

        // 3. Add aliases so user can type alias.column manually
        const allAliases = [
            { alias: joinedAlias, tableName: joinedTable },
            ...otherAliases,
        ];
        for (const a of allAliases) {
            const item = new vscode.CompletionItem(a.alias);
            item.kind = vscode.CompletionItemKind.Variable;
            item.detail = a.tableName;
            item.sortText = `2_${a.alias}`;
            item.insertText = a.alias;
            // After selecting alias, trigger suggest so user gets dot-completion
            item.command = {
                command: 'editor.action.triggerSuggest',
                title: 'Trigger Suggest',
            };
            items.push(item);
        }

        return new vscode.CompletionList(items, true);
    }

    private completeTableNames(prefix?: string, dbName?: string, hasSchemaPrefix?: boolean): vscode.CompletionList {
        const items: vscode.CompletionItem[] = [];
        const tablesAndViews = dbName
            ? Array.from(this.schemaCache.getObjectsForDb(dbName).values()).filter(o => o.type === 'TABLE' || o.type === 'VIEW')
            : this.schemaCache.getTablesAndViews();

        for (const obj of tablesAndViews) {
            const alias = this.generateAlias(obj.name);
            const hasTrigger = this.schemaCache.hasTriggers(obj.name);
            const label = hasTrigger ? `${obj.name} ⚡` : obj.name;
            const item = new vscode.CompletionItem(label);
            item.kind = obj.type === 'TABLE'
                ? vscode.CompletionItemKind.Class
                : vscode.CompletionItemKind.Interface;
            item.detail = hasTrigger
                ? `${obj.type} (has trigger)`
                : obj.type;
            item.sortText = `0_${obj.name}`;
            item.filterText = obj.name;
            // Insert table name with schema + alias (without ⚡)
            const config = vscode.workspace.getConfiguration('tsql-intellisense');
            const qualifyWithOwner = config.get<boolean>('qualifyWithOwner', true);
            // If user already typed dbo., don't add it again
            const needsDbo = qualifyWithOwner && !hasSchemaPrefix;
            const qualifiedName = needsDbo ? `dbo.${obj.name}` : obj.name;
            if (alias) {
                const includeAs = config.get<boolean>('aliases.includeAS', false);
                item.insertText = includeAs ? `${qualifiedName} AS ${alias}` : `${qualifiedName} ${alias}`;
            } else {
                item.insertText = qualifiedName;
            }

            // Build documentation: CREATE script + trigger scripts
            const doc = this.buildTableDocumentation(obj.name);
            if (doc) {
                item.documentation = doc;
            } else {
                item.documentation = new vscode.MarkdownString(`**${obj.name}** (${obj.type})`);
            }

            items.push(item);
        }

        return new vscode.CompletionList(items, true);
    }

    /** Build full documentation: VIEW definition or CREATE TABLE + PK + Indexes + FK + Triggers */
    private buildTableDocumentation(tableName: string): vscode.MarkdownString | undefined {
        const obj = this.schemaCache.findObject(tableName);
        if (!obj) {
            console.log(`[DOC] findObject("${tableName}") → NOT FOUND`);
            return undefined;
        }
        const cols = obj.columns?.length ?? 0;
        const idxs = this.schemaCache.getIndexes(tableName).length;
        const fks = this.schemaCache.getForeignKeysForTable(tableName).length;
        const trigs = this.schemaCache.getTriggers(tableName).length;
        console.log(`[DOC] ${tableName}: type=${obj.type}, cols=${cols}, idx=${idxs}, fk=${fks}, trig=${trigs}, fullyLoaded=${this.schemaCache.isFullyLoaded}`);

        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.supportHtml = true;

        // Command links at top
        const encodedName = encodeURIComponent(JSON.stringify([tableName]));
        md.appendMarkdown(`[Copy Script](command:tsql-intellisense.copyTableScript?${encodedName}) | [Open Script](command:tsql-intellisense.openTableScript?${encodedName})\n\n`);

        // VIEW → show actual view definition
        if (obj.type === 'VIEW') {
            const viewDef = this.schemaCache.getViewDefinition(tableName);
            if (viewDef) {
                md.appendCodeblock(viewDef.trim(), 'sql');
            } else if (obj.columns && obj.columns.length > 0) {
                const colList = obj.columns.map(c => `    ${c.name} (${c.dataType})`).join('\n');
                md.appendCodeblock(`-- VIEW: ${tableName}\n${colList}`, 'sql');
            } else {
                md.appendMarkdown('*View definition loading...*');
            }
            return md;
        }

        // TABLE → CREATE TABLE script
        if (!obj.columns || obj.columns.length === 0) {
            md.appendMarkdown('*Schema loading...*');
            return md;
        }

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

        // PK + Indexes
        const indexes = this.schemaCache.getIndexes(tableName);
        const pk = indexes.find(idx => idx.isPrimaryKey);
        if (pk) {
            lines.push('GO');
            lines.push(`ALTER TABLE [dbo].[${tableName}] ADD CONSTRAINT [${pk.name}] PRIMARY KEY (${pk.columns})`);
        }

        const otherIndexes = indexes.filter(idx => !idx.isPrimaryKey);
        for (const idx of otherIndexes) {
            lines.push('GO');
            const unique = idx.isUnique ? 'UNIQUE ' : '';
            lines.push(`CREATE ${unique}${idx.type} INDEX [${idx.name}] ON [dbo].[${tableName}] (${idx.columns})`);
        }

        // FK relationships
        const tableFks = this.schemaCache.getForeignKeysForTable(tableName);
        if (tableFks.length > 0) {
            for (const fk of tableFks) {
                lines.push('GO');
                lines.push(`ALTER TABLE [dbo].[${fk.parentTable}] ADD CONSTRAINT [${fk.fkName}] FOREIGN KEY ([${fk.parentColumn}]) REFERENCES [dbo].[${fk.referencedTable}] ([${fk.referencedColumn}])`);
            }
        }

        md.appendCodeblock(lines.join('\n'), 'sql');

        // Triggers
        const triggers = this.schemaCache.getTriggers(tableName);
        if (triggers.length > 0) {
            md.appendMarkdown(`\n\n---\n\n**⚡ Triggers (${triggers.length}):**\n\n`);
            for (const trig of triggers) {
                md.appendMarkdown(`**${trig.name}**\n\n`);
                if (trig.definition) {
                    md.appendCodeblock(trig.definition.trim(), 'sql');
                }
            }
        }

        return md;
    }


    /** Get PK and FK column sets for a table */
    private getColumnKeyInfo(tableName: string): { pkColumns: Set<string>; fkColumns: Set<string> } {
        const pkColumns = new Set<string>();
        const fkColumns = new Set<string>();

        const indexes = this.schemaCache.getIndexes(tableName);
        const pk = indexes.find(idx => idx.isPrimaryKey);
        if (pk) {
            for (const col of pk.columns.split(',')) {
                pkColumns.add(col.trim().toLowerCase());
            }
        }

        const fks = this.schemaCache.getForeignKeysForTable(tableName);
        for (const fk of fks) {
            if (fk.parentTable.toLowerCase() === tableName.toLowerCase()) {
                fkColumns.add(fk.parentColumn.toLowerCase());
            }
        }

        return { pkColumns, fkColumns };
    }

    /** Build detail string for a column: type + nullable + PK/FK indicator */
    private buildColumnDetail(col: { name: string; dataType: string; maxLength: number | null; isNullable: boolean }, pkColumns: Set<string>, fkColumns: Set<string>): { detail: string; icon: string } {
        let typeStr = col.dataType;
        if (col.maxLength && col.maxLength > 0) {
            typeStr += `(${col.maxLength})`;
        }
        typeStr += col.isNullable ? ' null' : ' not null';

        const colLower = col.name.toLowerCase();
        let icon = '';
        if (pkColumns.has(colLower)) {
            icon = '🔑';
            typeStr += ' 🔑';
        } else if (fkColumns.has(colLower)) {
            icon = '🔗';
            typeStr += ' 🔗';
        }

        return { detail: typeStr, icon };
    }

    /** Generate a short alias from a table name */
    private generateAlias(tableName: string): string | null {
        const config = vscode.workspace.getConfiguration('tsql-intellisense');
        const assignAliases = config.get<boolean>('aliases.assignAliases', true);
        if (!assignAliases) return null;

        const prefixes = config.get<string[]>('aliases.prefixesToIgnore', []);
        const capitalise = config.get<boolean>('aliases.capitaliseAliases', false);

        // Remove configured prefixes (longest match first)
        let withoutPrefix = tableName;
        if (prefixes.length > 0) {
            const sorted = [...prefixes].sort((a, b) => b.length - a.length);
            for (const pfx of sorted) {
                if (tableName.startsWith(pfx)) {
                    withoutPrefix = tableName.slice(pfx.length);
                    break;
                }
            }
        }

        // Fallback: remove generic prefix pattern (RN06_, CV04_, etc.)
        if (withoutPrefix === tableName) {
            withoutPrefix = tableName.replace(/^[A-Z]{1,4}\d{1,3}_/, '');
        }

        if (!withoutPrefix) return null;

        // Get uppercase letters as alias (e.g. StokAmbarNo → SAN, HareketFisM → HFM)
        const uppers = withoutPrefix.match(/[A-Z]/g);
        let alias: string;
        if (uppers && uppers.length >= 2) {
            alias = uppers.join('');
        } else {
            alias = withoutPrefix[0].toUpperCase();
        }

        return capitalise ? alias.toUpperCase() : alias.toLowerCase();
    }

    private completeProcedureNames(prefix?: string, dbName?: string): vscode.CompletionList {
        const items: vscode.CompletionItem[] = [];
        const procedures = dbName
            ? Array.from(this.schemaCache.getObjectsForDb(dbName).values()).filter(o => o.type === 'PROCEDURE')
            : this.schemaCache.getProcedures();

        for (const obj of procedures) {
            const item = new vscode.CompletionItem(obj.name);
            item.kind = vscode.CompletionItemKind.Method;
            item.detail = 'PROCEDURE';
            item.sortText = `0_${obj.name}`;
            item.filterText = obj.name;
            // When selected, fetch params and insert snippet
            item.command = {
                command: 'tsql-intellisense.insertSpParams',
                title: 'Insert SP Parameters',
                arguments: [obj.name],
            };
            items.push(item);
        }

        return new vscode.CompletionList(items, true);
    }

    /** Complete columns with alias prefix (for SELECT/WHERE context) */
    private async completeColumnsWithAlias(tableName: string, prefix?: string, alias?: string, position?: vscode.Position, dbName?: string, textBeforeCursor?: string, aliases?: AliasMapping[]): Promise<vscode.CompletionList> {
        const items: vscode.CompletionItem[] = [];
        const columns = dbName
            ? await this.schemaCache.loadColumnsForDbTable(dbName, tableName)
            : await this.schemaCache.getColumns(tableName);
        const aliasPrefix = alias ? `${alias}.` : '';

        // Calculate range that includes * or typed prefix
        let replaceRange: vscode.Range | undefined;
        if (position && prefix) {
            replaceRange = new vscode.Range(
                position.line, position.character - prefix.length,
                position.line, position.character
            );
        }

        // Add "* (expand all)" snippet — only when user typed '*'
        const showStar = columns.length > 0 && prefix === '*';
        if (prefix === '*' && !showStar) {
            // Show info item explaining why expand is not available
            const reason = columns.length === 0 ? `Table '${tableName}' not found in schema` : 'No alias found';
            const infoItem = new vscode.CompletionItem(`* (expand unavailable: ${reason})`, vscode.CompletionItemKind.Text);
            infoItem.sortText = '0_0000';
            infoItem.filterText = '*';
            infoItem.insertText = '*';
            items.push(infoItem);
        }
        if (showStar) {
            // Collect columns from ALL tables/aliases in the query
            const allExpandedCols: string[] = [];
            if (aliases && aliases.length > 0) {
                for (const am of aliases) {
                    const cols = dbName
                        ? await this.schemaCache.loadColumnsForDbTable(dbName, am.tableName)
                        : await this.schemaCache.getColumns(am.tableName);
                    // Use alias if available, otherwise use table name as prefix
                    const ap = am.alias ? `${am.alias}.` : (aliases.length > 1 ? `${am.tableName}.` : '');
                    for (const c of cols) {
                        allExpandedCols.push(`${ap}${c.name}`);
                    }
                }
            }

            const totalTables = aliases ? aliases.length : 1;
            const starItem = new vscode.CompletionItem('* (expand all columns)', vscode.CompletionItemKind.Snippet);
            starItem.detail = `${allExpandedCols.length} columns from ${totalTables} table${totalTables > 1 ? 's' : ''}`;
            starItem.sortText = '0_0000';
            starItem.filterText = '*';
            const allCols = TsqlCompletionProvider.formatExpandedColumns(allExpandedCols);
            starItem.insertText = new vscode.SnippetString(allCols);
            if (prefix === '*') {
                starItem.preselect = true;
                if (replaceRange) {
                    starItem.range = replaceRange;
                }
            }
            items.push(starItem);
        }

        // Add SQL function snippets
        const sqlFunctions = [
            { label: 'COUNT', snippet: 'COUNT(${1:*})', detail: 'Aggregate: count rows' },
            { label: 'SUM', snippet: 'SUM(${1:column})', detail: 'Aggregate: sum values' },
            { label: 'AVG', snippet: 'AVG(${1:column})', detail: 'Aggregate: average' },
            { label: 'MIN', snippet: 'MIN(${1:column})', detail: 'Aggregate: minimum' },
            { label: 'MAX', snippet: 'MAX(${1:column})', detail: 'Aggregate: maximum' },
            { label: 'ROW_NUMBER', snippet: 'ROW_NUMBER() OVER(${1:ORDER BY ${2:column}})', detail: 'Window: row number' },
            { label: 'RANK', snippet: 'RANK() OVER(${1:ORDER BY ${2:column}})', detail: 'Window: rank' },
            { label: 'DENSE_RANK', snippet: 'DENSE_RANK() OVER(${1:ORDER BY ${2:column}})', detail: 'Window: dense rank' },
            { label: 'NTILE', snippet: 'NTILE(${1:n}) OVER(${2:ORDER BY ${3:column}})', detail: 'Window: ntile' },
            { label: 'LAG', snippet: 'LAG(${1:column}, ${2:1}) OVER(${3:ORDER BY ${4:column}})', detail: 'Window: previous row value' },
            { label: 'LEAD', snippet: 'LEAD(${1:column}, ${2:1}) OVER(${3:ORDER BY ${4:column}})', detail: 'Window: next row value' },
            { label: 'CAST', snippet: 'CAST(${1:expression} AS ${2:datatype})', detail: 'Convert data type' },
            { label: 'CONVERT', snippet: 'CONVERT(${1:datatype}, ${2:expression})', detail: 'Convert data type' },
            { label: 'ISNULL', snippet: 'ISNULL(${1:expression}, ${2:replacement})', detail: 'Replace NULL' },
            { label: 'COALESCE', snippet: 'COALESCE(${1:expr1}, ${2:expr2})', detail: 'First non-NULL' },
            { label: 'CASE', snippet: 'CASE WHEN ${1:condition} THEN ${2:result} ELSE ${3:default} END', detail: 'Conditional expression' },
            { label: 'LEFT', snippet: 'LEFT(${1:string}, ${2:length})', detail: 'String: left substring' },
            { label: 'RIGHT', snippet: 'RIGHT(${1:string}, ${2:length})', detail: 'String: right substring' },
            { label: 'SUBSTRING', snippet: 'SUBSTRING(${1:string}, ${2:start}, ${3:length})', detail: 'String: substring' },
            { label: 'LEN', snippet: 'LEN(${1:string})', detail: 'String: length' },
            { label: 'REPLACE', snippet: 'REPLACE(${1:string}, ${2:old}, ${3:new})', detail: 'String: replace' },
            { label: 'TRIM', snippet: 'TRIM(${1:string})', detail: 'String: trim whitespace' },
            { label: 'UPPER', snippet: 'UPPER(${1:string})', detail: 'String: to uppercase' },
            { label: 'LOWER', snippet: 'LOWER(${1:string})', detail: 'String: to lowercase' },
            { label: 'GETDATE', snippet: 'GETDATE()', detail: 'Date: current datetime' },
            { label: 'DATEADD', snippet: 'DATEADD(${1:datepart}, ${2:number}, ${3:date})', detail: 'Date: add interval' },
            { label: 'DATEDIFF', snippet: 'DATEDIFF(${1:datepart}, ${2:startdate}, ${3:enddate})', detail: 'Date: difference' },
            { label: 'FORMAT', snippet: 'FORMAT(${1:value}, ${2:format})', detail: 'Format value' },
            { label: 'STRING_AGG', snippet: 'STRING_AGG(${1:expression}, ${2:\', \'})', detail: 'Aggregate: concatenate strings' },
        ];

        // Snippet-based functions (with tab stops)
        const snippetLabels = new Set<string>();
        for (const fn of sqlFunctions) {
            snippetLabels.add(fn.label);
            const item = new vscode.CompletionItem(fn.label, vscode.CompletionItemKind.Function);
            item.detail = fn.detail;
            item.sortText = `1_${fn.label}`;
            item.filterText = fn.label;
            item.insertText = new vscode.SnippetString(fn.snippet);
            if (replaceRange) {
                item.range = replaceRange;
            }
            items.push(item);
        }

        // System global variables (@@ROWCOUNT, @@IDENTITY, etc.)
        for (const fnName of FUNCTIONS) {
            if (!fnName.startsWith('@@')) continue;
            const item = new vscode.CompletionItem(fnName, vscode.CompletionItemKind.Variable);
            item.detail = 'System variable';
            item.sortText = `1_${fnName}`;
            item.filterText = fnName;
            item.insertText = fnName;
            if (replaceRange) {
                item.range = replaceRange;
            }
            items.push(item);
        }

        // All remaining built-in functions from tokenizer (simple parentheses)
        for (const fnName of FUNCTIONS) {
            if (fnName.startsWith('@@')) continue; // already added above as variables
            if (snippetLabels.has(fnName)) continue; // already added as snippet
            const item = new vscode.CompletionItem(fnName, vscode.CompletionItemKind.Function);
            item.detail = 'Built-in function';
            item.sortText = `2_${fnName}`;
            item.filterText = fnName;
            item.insertText = new vscode.SnippetString(`${fnName}(\${1})`);
            if (replaceRange) {
                item.range = replaceRange;
            }
            items.push(item);
        }

        // SELECT keywords: DISTINCT, TOP, ALL, NULL, CASE, EXISTS
        const selectKeywords = [
            { label: 'DISTINCT', detail: 'Remove duplicate rows' },
            { label: 'TOP', snippet: 'TOP ${1:100}', detail: 'Limit result rows' },
            { label: 'ALL', detail: 'Return all rows (default)' },
            { label: 'NULL', detail: 'NULL value' },
            { label: 'EXISTS', snippet: 'EXISTS(${1:SELECT 1 FROM ${2:table}})', detail: 'Existence check' },
        ];
        for (const kw of selectKeywords) {
            const item = new vscode.CompletionItem(kw.label, vscode.CompletionItemKind.Keyword);
            item.detail = kw.detail;
            item.sortText = `3_${kw.label}`;
            item.filterText = kw.label;
            if ((kw as any).snippet) {
                item.insertText = new vscode.SnippetString((kw as any).snippet);
            }
            if (replaceRange) {
                item.range = replaceRange;
            }
            items.push(item);
        }

        const { pkColumns, fkColumns } = this.getColumnKeyInfo(tableName);

        for (const col of columns) {
            const displayName = alias ? `${aliasPrefix}${col.name}` : col.name;
            const { detail } = this.buildColumnDetail(col, pkColumns, fkColumns);
            const item = new vscode.CompletionItem({
                label: displayName,
                detail: `  ${detail}`,
                description: '',
            });
            item.kind = vscode.CompletionItemKind.Field;
            item.sortText = `0_${String(col.ordinalPosition).padStart(4, '0')}`;
            item.filterText = col.name;
            item.insertText = displayName;
            if (replaceRange) {
                item.range = replaceRange;
            }
            items.push(item);
        }

        return new vscode.CompletionList(items, false);
    }

    /** Complete columns without alias (for alias.dot context) */
    private async completeColumns(tableName: string, prefix?: string, dbName?: string): Promise<vscode.CompletionList> {
        const items: vscode.CompletionItem[] = [];
        const columns = dbName
            ? await this.schemaCache.loadColumnsForDbTable(dbName, tableName)
            : await this.schemaCache.getColumns(tableName);
        const { pkColumns, fkColumns } = this.getColumnKeyInfo(tableName);

        for (const col of columns) {
            const { detail } = this.buildColumnDetail(col, pkColumns, fkColumns);
            const item = new vscode.CompletionItem({
                label: col.name,
                detail: `  ${detail}`,
                description: '',
            });
            item.kind = vscode.CompletionItemKind.Field;
            item.sortText = `0_${String(col.ordinalPosition).padStart(4, '0')}`;
            item.filterText = col.name;
            item.insertText = col.name;
            items.push(item);
        }

        return new vscode.CompletionList(items, false);
    }

    /**
     * INSERT INTO completion: show table names, on select insert column list + VALUES template.
     */
    private completeInsertTable(prefix?: string, position?: vscode.Position, dbName?: string): vscode.CompletionList {
        const items: vscode.CompletionItem[] = [];
        const tablesAndViews = dbName
            ? Array.from(this.schemaCache.getObjectsForDb(dbName).values()).filter(o => o.type === 'TABLE' || o.type === 'VIEW')
            : this.schemaCache.getTablesAndViews();

        for (const obj of tablesAndViews) {
            const hasTrigger = this.schemaCache.hasTriggers(obj.name);
            const label = hasTrigger ? `${obj.name} ⚡` : obj.name;
            const item = new vscode.CompletionItem(label);
            item.kind = obj.type === 'TABLE'
                ? vscode.CompletionItemKind.Class
                : vscode.CompletionItemKind.Interface;
            item.detail = `INSERT INTO ${obj.name}`;
            item.sortText = `0_${obj.name}`;
            item.filterText = obj.name;

            const config = vscode.workspace.getConfiguration('tsql-intellisense');
            const qualifyWithOwner = config.get<boolean>('qualifyWithOwner', true);
            const qualifiedName = qualifyWithOwner ? `dbo.${obj.name}` : obj.name;
            item.insertText = qualifiedName;

            // Trigger insertInsertTemplate command after accepting
            item.command = {
                command: 'tsql-intellisense.insertInsertTemplate',
                title: 'Insert columns + VALUES',
                arguments: [obj.name, dbName],
            };

            // Reuse table documentation
            const doc = this.buildTableDocumentation(obj.name);
            if (doc) {
                item.documentation = doc;
            } else {
                item.documentation = new vscode.MarkdownString(`**${obj.name}** (${obj.type})`);
            }

            items.push(item);
        }

        return new vscode.CompletionList(items, true);
    }

    /**
     * Format expanded column list according to style settings (maxLineLength, commas before).
     */
    private static formatExpandedColumns(cols: string[]): string {
        const config = vscode.workspace.getConfiguration('tsql-intellisense');
        const maxLine = config.get<number>('maxLineLength', 120);
        const commasBefore = config.get<any>('styleOverrides')?.lists?.placeCommasBeforeItems ?? true;
        const padding = 8; // typical SELECT padding width

        if (cols.length === 0) return '';

        const lines: string[] = [];
        let currentLine = cols[0];

        for (let i = 1; i < cols.length; i++) {
            const test = currentLine + ', ' + cols[i];
            if (maxLine > 0 && test.length + padding > maxLine) {
                lines.push(currentLine);
                if (commasBefore) {
                    currentLine = ', ' + cols[i];
                } else {
                    lines[lines.length - 1] += ',';
                    currentLine = cols[i];
                }
            } else {
                currentLine = test;
            }
        }
        lines.push(currentLine);

        return lines.join('\n');
    }
}
