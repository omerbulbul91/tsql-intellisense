import * as vscode from 'vscode';
import { ConnectionManager, TYPES } from './connection/connectionManager';
import { SchemaCache } from './cache/schemaCache';
import { TsqlCompletionProvider } from './providers/completionProvider';
import { AlterProcProvider } from './providers/alterProcProvider';
import { QueryRunner } from './providers/queryRunner';
import { TsqlRenameProvider } from './providers/renameProvider';

let connectionManager: ConnectionManager;
let schemaCache: SchemaCache;
let alterProcProvider: AlterProcProvider;
let queryRunner: QueryRunner;

export function activate(context: vscode.ExtensionContext) {
    // Initialize core components
    connectionManager = new ConnectionManager();
    schemaCache = new SchemaCache(connectionManager);
    alterProcProvider = new AlterProcProvider(connectionManager, schemaCache);
    queryRunner = new QueryRunner(connectionManager);

    // Register query results panel in bottom area
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('tsqlResults', queryRunner)
    );

    // Register completion provider for SQL files
    const completionProvider = new TsqlCompletionProvider(schemaCache);
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'sql', scheme: '*' },
            completionProvider,
            '.', ' ', '*'
        )
    );

    // Register rename provider for alias renaming (F2)
    const renameProvider = new TsqlRenameProvider();
    context.subscriptions.push(
        vscode.languages.registerRenameProvider(
            { language: 'sql', scheme: '*' },
            renameProvider
        )
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.connect', () => {
            connectionManager.promptConnect();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.disconnect', () => {
            connectionManager.disconnect();
            vscode.window.showInformationMessage('T-SQL IntelliSense: Disconnected');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.refreshSchema', async () => {
            if (!connectionManager.isConnected) {
                vscode.window.showWarningMessage('T-SQL IntelliSense: Not connected');
                return;
            }
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Refreshing schema cache...' },
                () => schemaCache.refresh()
            );
            vscode.window.showInformationMessage(
                `T-SQL IntelliSense: Schema refreshed (${schemaCache.objectCount} objects)`
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.alterProc', () => {
            alterProcProvider.showAlterProcPicker();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.runQuery', () => {
            queryRunner.runQuery();
        })
    );

    // Query shortcuts (SSMS-style: Alt+F1 → sp_help, Ctrl+1 → sp_who, etc.)
    for (let i = 0; i < 10; i++) {
        context.subscriptions.push(
            vscode.commands.registerCommand(`tsql-intellisense.queryShortcut${i}`, async () => {
                const config = vscode.workspace.getConfiguration('tsql-intellisense');
                const shortcuts = config.get<{ key: string; query: string }[]>('queryShortcuts', []);
                const shortcut = shortcuts[i];
                if (!shortcut || !shortcut.query) {
                    vscode.window.showInformationMessage(`Query shortcut ${i} is not configured`);
                    return;
                }

                // Get word under cursor
                const editor = vscode.window.activeTextEditor;
                let word = '';
                if (editor) {
                    const pos = editor.selection.active;
                    const wordRange = editor.document.getWordRangeAtPosition(pos, /[\w.\[\]]+/);
                    if (wordRange) {
                        word = editor.document.getText(wordRange);
                    }
                }

                // Replace @WORD placeholder
                const sql = shortcut.query.replace(/@WORD/g, word);
                await queryRunner.runQueryText(sql);
            })
        );
    }

    // Copy table/view script to clipboard
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.copyTableScript', async (tableName: string) => {
            const script = buildObjectScript(tableName);
            if (!script) {
                vscode.window.showWarningMessage(`No schema info for ${tableName}`);
                return;
            }
            await vscode.env.clipboard.writeText(script);
            vscode.window.showInformationMessage(`Script copied for ${tableName}`);
        })
    );

    // Open table/view script in new editor tab
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.openTableScript', async (tableName: string) => {
            const script = buildObjectScript(tableName);
            if (!script) {
                vscode.window.showWarningMessage(`No schema info for ${tableName}`);
                return;
            }
            const doc = await vscode.workspace.openTextDocument({ content: script, language: 'sql' });
            await vscode.window.showTextDocument(doc, { preview: false });
        })
    );

    /** Build CREATE TABLE or VIEW definition script */
    function buildObjectScript(tableName: string): string | null {
        const obj = schemaCache.findObject(tableName);
        if (!obj) { return null; }

        // VIEW → return actual definition
        if (obj.type === 'VIEW') {
            const viewDef = schemaCache.getViewDefinition(tableName);
            return viewDef ? viewDef.trim() : null;
        }

        // TABLE → CREATE TABLE + PK + Index + FK
        if (!obj.columns || obj.columns.length === 0) { return null; }

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

        const indexes = schemaCache.getIndexes(tableName);
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

        const fks = schemaCache.getForeignKeysForTable(tableName);
        for (const fk of fks) {
            lines.push(`ALTER TABLE [dbo].[${fk.parentTable}] ADD CONSTRAINT [${fk.fkName}] FOREIGN KEY ([${fk.parentColumn}]) REFERENCES [dbo].[${fk.referencedTable}] ([${fk.referencedColumn}])`);
            lines.push('GO');
        }

        const triggers = schemaCache.getTriggers(tableName);
        for (const trig of triggers) {
            if (trig.definition) {
                lines.push(trig.definition.trim());
                lines.push('GO');
            }
        }

        return lines.join('\n');
    }

    // Fetch SP code when selected from ALTER PROC completion
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.fetchProcCode', async (spName: string) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }

            try {
                const result = await connectionManager.executeQuery(
                    `SELECT OBJECT_DEFINITION(OBJECT_ID(@objectName)) AS [definition]`,
                    { objectName: { type: TYPES.NVarChar, value: spName } }
                );

                if (result.rows.length === 0 || !result.rows[0]['definition']) {
                    vscode.window.showWarningMessage(`Could not retrieve definition for ${spName}`);
                    return;
                }

                let definition = result.rows[0]['definition'] as string;
                definition = definition.replace(/^(\s*)CREATE\s+(PROC(EDURE)?)/i, '$1ALTER $2');

                // Replace entire editor content with SP code
                const fullRange = new vscode.Range(
                    editor.document.positionAt(0),
                    editor.document.positionAt(editor.document.getText().length)
                );
                await editor.edit(editBuilder => {
                    editBuilder.replace(fullRange, definition);
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to fetch SP: ${err.message}`);
            }
        })
    );

    // When connection changes, load schema and remember last profile
    connectionManager.onConnectionChanged(async (profile) => {
        if (profile) {
            // Remember last connected profile name
            context.globalState.update('lastConnectionName', profile.name);
            try {
                await schemaCache.loadObjectNames();
                schemaCache.startAutoRefresh();
                // Load columns, FK, indexes, triggers in background
                schemaCache.loadAllColumns().catch(() => {});
                schemaCache.loadForeignKeys().catch(() => {});
                schemaCache.loadIndexes().catch(() => {});
                schemaCache.loadTriggers().catch(() => {});
                schemaCache.loadViewDefinitions().catch(() => {});
                vscode.window.showInformationMessage(
                    `T-SQL IntelliSense: Schema loaded (${schemaCache.objectCount} objects)`
                );
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to load schema: ${err.message}`);
            }
        } else {
            schemaCache.stopAutoRefresh();
        }
    });

    // Auto-connect: try last used profile, or the only saved profile
    const profiles = connectionManager.getSavedProfiles();
    const lastConnectionName = context.globalState.get<string>('lastConnectionName');
    const autoProfile = profiles.find(p => p.name === lastConnectionName)
        || (profiles.length === 1 ? profiles[0] : null);

    if (autoProfile) {
        connectionManager.connect(autoProfile).catch(() => {});
    }

    // Disposables
    context.subscriptions.push({
        dispose: () => {
            connectionManager.dispose();
            schemaCache.dispose();
            queryRunner.dispose();
        }
    });

    console.log('T-SQL IntelliSense activated');
}

export function deactivate() {
    connectionManager?.dispose();
    schemaCache?.dispose();
}
