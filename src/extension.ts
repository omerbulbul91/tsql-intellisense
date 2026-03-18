import * as vscode from 'vscode';
import { ConnectionManager, TYPES } from './connection/connectionManager';
import { SchemaCache } from './cache/schemaCache';
import { TsqlCompletionProvider } from './providers/completionProvider';
import { AlterProcProvider } from './providers/alterProcProvider';
import { QueryRunner } from './providers/queryRunner';
import { TsqlRenameProvider } from './providers/renameProvider';
import { TsqlDefinitionProvider } from './providers/definitionProvider';
import { ProjectSync } from './sync/projectSync';
import { SnippetProvider } from './providers/snippetProvider';
import { ConnectionTreeProvider } from './providers/connectionTreeProvider';
import { ConnectionFormProvider } from './providers/connectionFormProvider';

let connectionManager: ConnectionManager;
let schemaCache: SchemaCache;
let alterProcProvider: AlterProcProvider;
let queryRunner: QueryRunner;

export function activate(context: vscode.ExtensionContext) {
    // Mark extension as active (for keybinding priority over mssql)
    vscode.commands.executeCommand('setContext', 'tsqlIntellisense.active', true);

    // Initialize core components
    connectionManager = new ConnectionManager();
    schemaCache = new SchemaCache(connectionManager);
    alterProcProvider = new AlterProcProvider(connectionManager, schemaCache);
    queryRunner = new QueryRunner(connectionManager);

    // Register sidebar tree view
    const treeProvider = new ConnectionTreeProvider(connectionManager, schemaCache);
    const treeView = vscode.window.createTreeView('tsqlConnections', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

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

    // Register definition provider (F12 → Go to Definition)
    const definitionProvider = new TsqlDefinitionProvider(connectionManager, schemaCache);
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(
            { language: 'sql', scheme: '*' },
            definitionProvider
        )
    );

    // Register snippet provider for Redgate SQL Prompt snippets
    const snippetOutputChannel = vscode.window.createOutputChannel('T-SQL Snippets');
    const snippetProvider = new SnippetProvider(snippetOutputChannel);
    snippetProvider.loadSnippets();
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'sql', scheme: '*' },
            snippetProvider
        )
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('tsql-intellisense.snippetFolder')) {
                snippetProvider.loadSnippets();
            }
        })
    );

    // Set Snippet Folder command (folder picker)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.setSnippetFolder', async () => {
            const current = vscode.workspace.getConfiguration('tsql-intellisense').get<string>('snippetFolder', '');
            const result = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Snippet Dizini Seç',
                defaultUri: current ? vscode.Uri.file(current) : undefined
            });
            if (result && result[0]) {
                await vscode.workspace.getConfiguration('tsql-intellisense').update('snippetFolder', result[0].fsPath, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Snippet dizini ayarlandı: ${result[0].fsPath}`);
            }
        })
    );

    // New SQL File command (Ctrl+Alt+S)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.newSqlFile', async () => {
            const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: '' });
            await vscode.window.showTextDocument(doc);
        })
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

    // Set project path for current connection via folder picker
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.setProjectPath', async () => {
            const profile = connectionManager.currentProfile;
            if (!profile) {
                vscode.window.showWarningMessage('T-SQL IntelliSense: Not connected to a database');
                return;
            }

            const result = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                openLabel: 'Select SQL Project Folder',
                title: `Set project path for ${profile.name}`,
            });

            if (!result || result.length === 0) { return; }

            const selectedPath = result[0].fsPath;

            // Update the connection profile in settings
            const config = vscode.workspace.getConfiguration('tsql-intellisense');
            const connections = config.get<any[]>('connections', []);
            const idx = connections.findIndex(
                c => c.name === profile.name && c.server === profile.server && c.database === profile.database
            );

            if (idx >= 0) {
                connections[idx].projectPath = selectedPath;
                const target = vscode.workspace.workspaceFolders
                    ? vscode.ConfigurationTarget.Workspace
                    : vscode.ConfigurationTarget.Global;
                await config.update('connections', connections, target);
                profile.projectPath = selectedPath;
                connectionManager.refreshStatusBar();
                vscode.window.showInformationMessage(`Project path set: ${selectedPath}`);
            } else {
                vscode.window.showWarningMessage('Connection not found in settings. Add it to tsql-intellisense.connections first.');
            }
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
        vscode.commands.registerCommand('tsql-intellisense.alterProc', (arg: any) => {
            if (arg?.objectName) {
                vscode.commands.executeCommand('tsql-intellisense.fetchProcCode', arg.objectName);
            } else {
                alterProcProvider.showAlterProcPicker();
            }
        })
    );

    // Open object definition (used by ALTER TABLE/VIEW/FUNCTION/TRIGGER completion)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.openObjectDefinition', async (objName: string) => {
            if (!connectionManager.isConnected) { return; }

            let script: string | null = null;
            const obj = schemaCache.findObject(objName);

            if (obj && obj.type === 'TABLE') {
                script = buildObjectScript(objName);
            } else {
                // SP, VIEW, FUNCTION, TRIGGER — use OBJECT_DEFINITION
                try {
                    const result = await connectionManager.executeQuery(
                        `SELECT COALESCE(
                            OBJECT_DEFINITION(OBJECT_ID(@objectName)),
                            OBJECT_DEFINITION(OBJECT_ID(@objectName, 'TR'))
                        ) AS [definition]`,
                        { objectName: { type: TYPES.NVarChar, value: objName } }
                    );
                    if (result.rows.length > 0 && result.rows[0]['definition']) {
                        script = result.rows[0]['definition'] as string;
                        // CREATE → ALTER dönüşümü
                        script = script.replace(/^(\s*)CREATE\s+/i, '$1ALTER ');
                    }
                } catch {}
            }

            if (!script) {
                vscode.window.showWarningMessage(`Could not retrieve definition for ${objName}`);
                return;
            }

            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const fullRange = new vscode.Range(
                    editor.document.positionAt(0),
                    editor.document.positionAt(editor.document.getText().length)
                );
                await editor.edit(editBuilder => {
                    editBuilder.replace(fullRange, script!);
                });
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.runQuery', () => {
            queryRunner.runQuery();
        })
    );

    // Insert SP parameters when SP is selected from completion
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.insertSpParams', async (arg: any) => {
            const spName = typeof arg === 'string' ? arg : arg?.objectName;
            if (!spName) { return; }
            const editor = vscode.window.activeTextEditor;
            if (!editor || !connectionManager.isConnected) { return; }

            try {
                const result = await connectionManager.executeQuery(
                    `SELECT PARAMETER_NAME, DATA_TYPE, PARAMETER_MODE, CHARACTER_MAXIMUM_LENGTH
                     FROM INFORMATION_SCHEMA.PARAMETERS
                     WHERE SPECIFIC_SCHEMA = 'dbo' AND SPECIFIC_NAME = @spName
                     ORDER BY ORDINAL_POSITION`,
                    { spName: { type: TYPES.NVarChar, value: spName } }
                );

                if (result.rows.length === 0) { return; }

                const params = result.rows.map(row => ({
                    name: row['PARAMETER_NAME'] as string,
                    type: row['DATA_TYPE'] as string,
                    mode: row['PARAMETER_MODE'] as string,
                    maxLen: row['CHARACTER_MAXIMUM_LENGTH'] as number | null,
                }));

                // Build DECLARE for OUTPUT params
                const outputParams = params.filter(p => p.mode === 'INOUT');
                const declares: string[] = [];
                for (const p of outputParams) {
                    let typeStr = p.type.toUpperCase();
                    if (p.maxLen && p.maxLen > 0) { typeStr += `(${p.maxLen})`; }
                    declares.push(`Declare ${p.name} ${typeStr};`);
                }

                // Build parameter list
                const paramLines: string[] = [];
                const maxNameLen = Math.max(...params.map(p => p.name.length));

                for (let i = 0; i < params.length; i++) {
                    const p = params[i];
                    let typeStr = p.type;
                    if (p.maxLen && p.maxLen > 0) { typeStr += `(${p.maxLen})`; }

                    const padding = ' '.repeat(Math.max(1, maxNameLen - p.name.length + 1));
                    const defaultVal = getDefaultValue(p.type);
                    const outputSuffix = p.mode === 'INOUT' ? ` Output` : '';
                    const comment = `-- ${typeStr}`;
                    const prefix = i === 0 ? ' ' : ',';

                    paramLines.push(`${' '.repeat(30)}${prefix} ${p.name} = ${defaultVal}${outputSuffix}${padding}${comment}`);
                }

                // Build full snippet
                const lines: string[] = [];
                if (declares.length > 0) {
                    lines.push(...declares);
                    lines.push('');
                }

                // Insert after current SP name
                const snippet = '\n' + paramLines.join('\n');

                await editor.edit(editBuilder => {
                    const pos = editor.selection.active;
                    // Insert declares before the EXEC line if needed
                    if (declares.length > 0) {
                        // Find the start of the current line
                        const lineStart = new vscode.Position(pos.line, 0);
                        editBuilder.insert(lineStart, declares.join('\n') + '\n\n');
                    }
                    editBuilder.insert(pos, snippet);
                });
            } catch (err: any) {
                console.error('insertSpParams failed:', err.message);
            }
        })
    );

    function getDefaultValue(dataType: string): string {
        switch (dataType.toLowerCase()) {
            case 'int': case 'bigint': case 'smallint': case 'tinyint': case 'decimal': case 'numeric': case 'float': case 'real': case 'money': case 'smallmoney':
                return '0';
            case 'bit':
                return '0';
            case 'datetime': case 'datetime2': case 'smalldatetime': case 'date':
                return 'GETDATE()';
            case 'uniqueidentifier':
                return 'NEWID()';
            default:
                return "''";
        }
    }

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
        vscode.commands.registerCommand('tsql-intellisense.copyTableScript', async (arg: any) => {
            const tableName = typeof arg === 'string' ? arg : arg?.objectName;
            if (!tableName) { return; }
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
        vscode.commands.registerCommand('tsql-intellisense.openTableScript', async (arg: any) => {
            const tableName = typeof arg === 'string' ? arg : arg?.objectName;
            if (!tableName) { return; }
            let script = buildObjectScript(tableName);
            // For functions/SPs — buildObjectScript only handles TABLE/VIEW, fallback to OBJECT_DEFINITION
            if (!script && connectionManager.isConnected) {
                try {
                    const result = await connectionManager.executeQuery(
                        `SELECT OBJECT_DEFINITION(OBJECT_ID(@objectName)) AS [definition]`,
                        { objectName: { type: TYPES.NVarChar, value: tableName } }
                    );
                    if (result.rows.length > 0 && result.rows[0]['definition']) {
                        script = result.rows[0]['definition'] as string;
                    }
                } catch {}
            }
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

    // Project Sync: auto-update SQL project files after DDL execution
    const projectSync = new ProjectSync(connectionManager, schemaCache);
    queryRunner.onQueryExecuted(async ({ sql }) => {
        const profile = connectionManager.currentProfile;
        if (!profile?.projectPath) { return; }

        try {
            await projectSync.syncAfterExecution(sql, profile.projectPath, buildObjectScript);
        } catch (err: any) {
            vscode.window.showWarningMessage(`Project Sync error: ${err.message}`);
        }
    });

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

    // Tree: Add Connection
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.addConnection', () => {
            ConnectionFormProvider.show(context, connectionManager, treeProvider);
        })
    );

    // Tree: Edit Connection
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.editConnection', (item: any) => {
            if (!item?.profileName) { return; }
            const profiles = connectionManager.getSavedProfiles();
            const profile = profiles.find(p => p.name === item.profileName);
            if (profile) {
                ConnectionFormProvider.show(context, connectionManager, treeProvider, profile);
            }
        })
    );

    // Tree: Delete Connection
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.deleteConnection', async (item: any) => {
            if (!item?.profileName) { return; }
            const activeProfile = connectionManager.currentProfile;
            const isActive = activeProfile && activeProfile.name === item.profileName;

            const confirmMsg = isActive
                ? `This connection is active. Disconnect and delete "${item.profileName}"?`
                : `Delete connection "${item.profileName}"?`;

            const answer = await vscode.window.showWarningMessage(confirmMsg, { modal: true }, 'Delete');
            if (answer !== 'Delete') { return; }

            if (isActive) {
                await connectionManager.disconnect();
            }

            const config = vscode.workspace.getConfiguration('tsql-intellisense');
            const connections = config.get<any[]>('connections', []);
            const filtered = connections.filter(c => c.name !== item.profileName);
            const target = vscode.workspace.workspaceFolders
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;
            await config.update('connections', filtered, target);
            treeProvider.refresh();
        })
    );

    // Tree: Connect to a profile (handles both string from TreeItem.command and ConnectionItem from context menu)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.treeConnect', async (arg: any) => {
            const profileName = typeof arg === 'string' ? arg : arg?.profileName;
            if (!profileName) { return; }
            const profiles = connectionManager.getSavedProfiles();
            const profile = profiles.find(p => p.name === profileName);
            if (!profile) { return; }

            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Connecting to ${profileName}...` },
                    () => connectionManager.connect(profile)
                );
            } catch (err: any) {
                treeProvider.setConnectionError(err.message);
                vscode.window.showErrorMessage(err.message);
            }
        })
    );

    // Tree: SELECT TOP 100 from table
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.selectTop100', async (item: any) => {
            if (!item?.objectName || !connectionManager.isConnected) { return; }
            const safeName = item.objectName.replace(/\]/g, ']]');
            await queryRunner.runQueryText(`SELECT TOP 100 * FROM [${safeName}]`);
        })
    );

    // Tree: New Query (opens empty SQL file when clicking from connected connection)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.newQueryFromTree', async () => {
            const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: '' });
            await vscode.window.showTextDocument(doc);
        })
    );

    // Tree: Switch database (click on a different DB in the Databases folder)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.switchDatabase', async (profileName: string, dbName: string) => {
            const profiles = connectionManager.getSavedProfiles();
            const profile = profiles.find(p => p.name === profileName);
            if (!profile) { return; }

            // Create a modified profile pointing to the new database
            const switchedProfile = { ...profile, database: dbName };
            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Switching to ${dbName}...` },
                    () => connectionManager.connect(switchedProfile)
                );
            } catch (err: any) {
                vscode.window.showErrorMessage(err.message);
            }
        })
    );

    // Tree: Open project folder in Explorer
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.openInExplorer', (item: any) => {
            if (!item?.projectPath) { return; }
            vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(item.projectPath));
        })
    );

    // When connection changes, load schema and remember last profile
    connectionManager.onConnectionChanged(async (profile) => {
        treeProvider.refresh();
        vscode.commands.executeCommand('setContext', 'tsqlIntellisense.connected', !!profile);
        if (profile) {
            // Remember last connected profile name
            context.globalState.update('lastConnectionName', profile.name);
            try {
                // Load database list for the Databases folder in tree
                try {
                    const dbResult = await connectionManager.executeQuery(
                        `SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name`
                    );
                    treeProvider.setDatabaseList(dbResult.rows.map(r => r['name'] as string));
                } catch {
                    treeProvider.setDatabaseList([]);
                }
                treeProvider.refresh();

                await schemaCache.loadObjectNames();
                schemaCache.startAutoRefresh();
                vscode.window.showInformationMessage(
                    `T-SQL IntelliSense: Schema loaded (${schemaCache.objectCount} objects)`
                );
                // Load detailed metadata in background with status bar indicator
                const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
                statusItem.text = '$(sync~spin) T-SQL: Loading schema details...';
                statusItem.show();
                // Sequential — tedious can only run one query at a time on a single connection
                await schemaCache.loadAllColumns().catch(e => console.error('loadAllColumns failed:', e));
                await schemaCache.loadForeignKeys().catch(e => console.error('loadForeignKeys failed:', e));
                await schemaCache.loadIndexes().catch(e => console.error('loadIndexes failed:', e));
                await schemaCache.loadTriggers().catch(e => console.error('loadTriggers failed:', e));
                await schemaCache.loadViewDefinitions().catch(e => console.error('loadViewDefinitions failed:', e));
                statusItem.text = schemaCache.isFullyLoaded
                    ? '$(check) T-SQL: Schema ready'
                    : '$(warning) T-SQL: Schema partially loaded';
                setTimeout(() => statusItem.dispose(), 5000);
                treeProvider.refresh(); // refresh tree after schema fully loaded
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
            treeProvider.dispose();
        }
    });

    console.log('T-SQL IntelliSense activated');
}

export function deactivate() {
    connectionManager?.dispose();
    schemaCache?.dispose();
}
