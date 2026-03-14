import * as vscode from 'vscode';
import { ConnectionManager } from './connection/connectionManager';
import { SchemaCache } from './cache/schemaCache';
import { TsqlCompletionProvider } from './providers/completionProvider';
import { AlterProcProvider } from './providers/alterProcProvider';

let connectionManager: ConnectionManager;
let schemaCache: SchemaCache;
let alterProcProvider: AlterProcProvider;

export function activate(context: vscode.ExtensionContext) {
    // Initialize core components
    connectionManager = new ConnectionManager();
    schemaCache = new SchemaCache(connectionManager);
    alterProcProvider = new AlterProcProvider(connectionManager, schemaCache);

    // Register completion provider for SQL files
    const completionProvider = new TsqlCompletionProvider(schemaCache);
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'sql', scheme: '*' },
            completionProvider,
            '.', ' '
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

    // When connection changes, load schema
    connectionManager.onConnectionChanged(async (profile) => {
        if (profile) {
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

    // Auto-connect if there is exactly one saved profile
    const profiles = connectionManager.getSavedProfiles();
    if (profiles.length === 1) {
        connectionManager.connect(profiles[0]).catch(() => {});
    }

    // Disposables
    context.subscriptions.push({
        dispose: () => {
            connectionManager.dispose();
            schemaCache.dispose();
        }
    });

    console.log('T-SQL IntelliSense activated');
}

export function deactivate() {
    connectionManager?.dispose();
    schemaCache?.dispose();
}
