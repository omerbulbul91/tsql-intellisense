import * as vscode from 'vscode';
import { ConnectionManager, TYPES } from './connection/connectionManager';
import { SchemaCache } from './cache/schemaCache';
import { TsqlCompletionProvider } from './providers/completionProvider';
import { AlterProcProvider } from './providers/alterProcProvider';
import { QueryRunner } from './providers/queryRunner';

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
                // Load columns in background
                schemaCache.loadAllColumns().catch(() => {});
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
