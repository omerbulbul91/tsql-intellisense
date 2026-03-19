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
import { ConnectionTreeProvider, FilterTarget } from './providers/connectionTreeProvider';
import { DatabaseItem, ObjectItem, ObjectType } from './providers/connectionTreeItems';
import { TsqlCodeLensProvider } from './providers/sqlCodeLensProvider';
import { ConnectionFormProvider } from './providers/connectionFormProvider';
import { StyleLoader } from './formatter/styleLoader';
import { FormatterProvider } from './providers/formatterProvider';
import { StyleFormProvider } from './providers/styleFormProvider';

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
    // loadCrossDbSchema is defined below — wrap in arrow so it resolves at call time
    const treeProvider = new ConnectionTreeProvider(
        connectionManager,
        schemaCache,
        (profileName: string, dbName: string) => loadCrossDbSchema(profileName, dbName)
    );

    let currentDatabases: string[] = [];

    /** Full schema load for the currently active DB — called via Ctrl+Shift+D refresh */
    async function loadSchemaForActiveDb(): Promise<void> {
        const profile = connectionManager.currentProfile;
        if (!profile) { return; }
        const dbName = profile.database;
        await schemaCache.loadObjectNames();
        schemaCache.startAutoRefresh();
        vscode.window.showInformationMessage(
            `T-SQL IntelliSense: Schema loaded (${schemaCache.objectCount} objects) — ${dbName}`
        );
        const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
        statusItem.text = '$(sync~spin) T-SQL: Loading schema details...';
        statusItem.show();
        await schemaCache.loadAllColumns().catch(e => console.error('loadAllColumns failed:', e));
        await schemaCache.loadForeignKeys().catch(e => console.error('loadForeignKeys failed:', e));
        await schemaCache.loadIndexes().catch(e => console.error('loadIndexes failed:', e));
        await schemaCache.loadTriggers().catch(e => console.error('loadTriggers failed:', e));
        await schemaCache.loadViewDefinitions().catch(e => console.error('loadViewDefinitions failed:', e));
        statusItem.text = schemaCache.isFullyLoaded
            ? '$(check) T-SQL: Schema ready'
            : '$(warning) T-SQL: Schema partially loaded';
        setTimeout(() => statusItem.dispose(), 5000);
        // Persist for offline tree browsing
        const tables = schemaCache.getTablesAndViews().filter(o => o.type === 'TABLE').map(o => o.name);
        const views  = schemaCache.getTablesAndViews().filter(o => o.type === 'VIEW').map(o => o.name);
        const sps    = schemaCache.getProcedures().map(o => o.name);
        const funcs  = schemaCache.getFunctions().map(o => o.name);
        treeProvider.setCachedData(profile.name, { databases: currentDatabases, tables, views, sps, funcs });
        // Also update perDbCache so tree node shows correct counts for this DB
        treeProvider.setDbCache(profile.name, dbName, { tables, views, sps, funcs });
        // Only refresh the active DB node — don't collapse other servers' trees
        treeProvider.fireDbChange(profile.name, dbName);
    }

    /** Load tables/views/SPs/funcs for a DB via cross-DB query (no reconnect needed) */
    async function loadCrossDbSchema(profileName: string, dbName: string): Promise<void> {
        if (treeProvider.hasDbCache(profileName, dbName)) { return; }
        if (!connectionManager.isConnected) { return; }
        // Only run for the ACTIVE connection — prevents querying wrong server
        if (connectionManager.currentProfile?.name !== profileName) { return; }
        // No initial refresh — "Loading..." is already shown by getDatabaseChildren when cache is empty
        try {
            const safe = dbName.replace(/\]/g, ']]');
            const result = await connectionManager.executeQuery(
                `SELECT name, type FROM (
                    SELECT TABLE_NAME as name,
                        CASE TABLE_TYPE WHEN 'BASE TABLE' THEN 'TABLE' ELSE 'VIEW' END as type
                    FROM [${safe}].INFORMATION_SCHEMA.TABLES
                    UNION ALL
                    SELECT ROUTINE_NAME, ROUTINE_TYPE
                    FROM [${safe}].INFORMATION_SCHEMA.ROUTINES
                ) t ORDER BY name`
            );
            treeProvider.setDbCache(profileName, dbName, {
                tables: result.rows.filter(r => r['type'] === 'TABLE').map(r => r['name'] as string),
                views:  result.rows.filter(r => r['type'] === 'VIEW').map(r => r['name'] as string),
                sps:    result.rows.filter(r => r['type'] === 'PROCEDURE').map(r => r['name'] as string),
                funcs:  result.rows.filter(r => r['type'] === 'FUNCTION').map(r => r['name'] as string),
            });
        } catch (err: any) {
            console.error(`Cross-DB schema load failed for ${dbName}:`, err.message);
            treeProvider.setDbCache(profileName, dbName, { tables: [], views: [], sps: [], funcs: [] });
        }
        // Targeted refresh — only update this DB node, don't collapse other expanded nodes
        treeProvider.fireDbChange(profileName, dbName);
    }
    const treeView = vscode.window.createTreeView('tsqlConnections', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    // Track folder expand/collapse for icon changes + lazy schema loading
    treeView.onDidExpandElement(async e => {
        const item = e.element;
        if ('setExpanded' in item && typeof (item as any).setExpanded === 'function') {
            (item as any).setExpanded(true);
            treeProvider.fireChange(item);
        }

        if (item instanceof DatabaseItem && !item.isCached) {
            const activeProfile = connectionManager.currentProfile;
            if (activeProfile && activeProfile.name === item.parentProfileName) {
                // All databases on the active server load via cross-DB query — no active-DB special case
                await loadCrossDbSchema(item.parentProfileName, item.dbName);
                // Load IntelliSense schema in the background for the connected DB
                if (item.dbName.toLowerCase() === activeProfile.database.toLowerCase()
                    && schemaCache.loadedDbName?.toLowerCase() !== item.dbName.toLowerCase()) {
                    schemaCache.loadObjectNames()
                        .then(() => { schemaCache.startAutoRefresh(); })
                        .catch(e => console.error('loadObjectNames failed:', e));
                }
            }
        }
    });
    treeView.onDidCollapseElement(e => {
        const item = e.element;
        if ('setExpanded' in item && typeof (item as any).setExpanded === 'function') {
            (item as any).setExpanded(false);
            treeProvider.fireChange(item);
        }
    });

    // Register query results panel in bottom area
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('tsqlResults', queryRunner)
    );

    // Register CodeLens provider — shows ▷ Run + server/db at batch start lines
    const codeLensProvider = new TsqlCodeLensProvider(queryRunner);
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { language: 'sql', scheme: '*' },
            codeLensProvider
        )
    );

    // Register completion provider for SQL files
    const completionProvider = new TsqlCompletionProvider(schemaCache, queryRunner);
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
    const definitionProvider = new TsqlDefinitionProvider(connectionManager, schemaCache, queryRunner);
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

    // ── SQL Formatter (style-based casing) ──
    const styleOutputChannel = vscode.window.createOutputChannel('T-SQL Formatter');
    const styleLoader = new StyleLoader(styleOutputChannel);
    const styleFile = vscode.workspace.getConfiguration('tsql-intellisense').get<string>('styleFile', '');
    const maxLineLength = vscode.workspace.getConfiguration('tsql-intellisense').get<number>('maxLineLength', 120);
    styleLoader.setMaxLineLength(maxLineLength);
    styleLoader.loadFromFile(styleFile);
    const styleOverrides = vscode.workspace.getConfiguration('tsql-intellisense').get<any>('styleOverrides');
    if (styleOverrides) { styleLoader.applyOverrides(styleOverrides); }

    const formatterProvider = new FormatterProvider(styleLoader);
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider({ language: 'sql', scheme: '*' }, formatterProvider),
        vscode.languages.registerDocumentRangeFormattingEditProvider({ language: 'sql', scheme: '*' }, formatterProvider)
    );

    // Ctrl+K Y — format SQL
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.formatSql', () => {
            formatterProvider.formatActiveEditor();
        })
    );

    // Set Style File command
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.setStyleFile', async () => {
            const current = vscode.workspace.getConfiguration('tsql-intellisense').get<string>('styleFile', '');
            const result = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                openLabel: 'Stil Dosyası Seç',
                filters: { 'JSON Style': ['json'] },
                defaultUri: current ? vscode.Uri.file(current) : undefined
            });
            if (result && result[0]) {
                await vscode.workspace.getConfiguration('tsql-intellisense').update('styleFile', result[0].fsPath, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Stil dosyası ayarlandı: ${result[0].fsPath}`);
            }
        })
    );

    // Open Style Settings UI
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.openStyleSettings', () => {
            StyleFormProvider.show(context, styleLoader);
        })
    );

    // Reload style on config change
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('tsql-intellisense.styleFile')) {
                const file = vscode.workspace.getConfiguration('tsql-intellisense').get<string>('styleFile', '');
                styleLoader.loadFromFile(file);
            }
            if (e.affectsConfiguration('tsql-intellisense.maxLineLength')) {
                const ml = vscode.workspace.getConfiguration('tsql-intellisense').get<number>('maxLineLength', 120);
                styleLoader.setMaxLineLength(ml);
            }
        })
    );

    // New SQL File command (Ctrl+Alt+S)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.newSqlFile', async () => {
            // Inherit DB from the currently active SQL file; fall back to current profile
            const activeEditor = vscode.window.activeTextEditor;
            const sourceDb = activeEditor?.document.languageId === 'sql'
                ? queryRunner.getDocumentDatabase(activeEditor.document.uri)
                : null;
            const current = connectionManager.currentProfile;
            const dbAssoc = sourceDb ?? (current ? { profileName: current.name, dbName: current.database } : null);

            const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: '' });
            if (dbAssoc) {
                queryRunner.setDocumentDatabase(doc.uri, dbAssoc);
            }
            await vscode.window.showTextDocument(doc);
        })
    );

    // Per-tab active DB tracking:
    // - New SQL docs are auto-associated with the current active DB
    // - Tab switch: only updates status bar + softSwitchDatabase (no schema load)
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (!editor || editor.document.languageId !== 'sql') { return; }
            const docDb = queryRunner.getDocumentDatabase(editor.document.uri);
            if (!docDb) {
                // First time this doc becomes active — associate with current DB
                const current = connectionManager.currentProfile;
                if (current) {
                    queryRunner.setDocumentDatabase(editor.document.uri, {
                        profileName: current.name,
                        dbName: current.database,
                    });
                }
            } else {
                // Switch DB context for IntelliSense — doesn't affect tree or status bar
                connectionManager.softSwitchDatabase(docDb.dbName).catch(() => {});
            }
            codeLensProvider.refresh();
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

            const currentDb = profile.database;
            if (!currentDb) {
                vscode.window.showWarningMessage('No database selected');
                return;
            }

            const result = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                openLabel: 'Select SQL Project Folder',
                title: `Set project path for ${currentDb}`,
            });

            if (!result || result.length === 0) { return; }

            const selectedPath = result[0].fsPath;

            // Update databaseProjects in the connection profile settings
            const config = vscode.workspace.getConfiguration('tsql-intellisense');
            const inspected = config.inspect<any[]>('connections');
            // Deep-copy to get a mutable array; detect correct scope
            let saveTarget = vscode.ConfigurationTarget.Global;
            let rawConns: any[];
            if (inspected?.workspaceFolderValue !== undefined) {
                saveTarget = vscode.ConfigurationTarget.WorkspaceFolder;
                rawConns = JSON.parse(JSON.stringify(inspected.workspaceFolderValue));
            } else if (inspected?.workspaceValue !== undefined) {
                saveTarget = vscode.ConfigurationTarget.Workspace;
                rawConns = JSON.parse(JSON.stringify(inspected.workspaceValue));
            } else {
                rawConns = JSON.parse(JSON.stringify(inspected?.globalValue || []));
            }
            const idx = rawConns.findIndex(
                (c: any) => c.name === profile.name && c.server === profile.server
            );

            if (idx >= 0) {
                if (!rawConns[idx].databaseProjects) { rawConns[idx].databaseProjects = {}; }
                rawConns[idx].databaseProjects[currentDb] = selectedPath;
                try {
                    await config.update('connections', rawConns, saveTarget);
                    if (!profile.databaseProjects) { profile.databaseProjects = {}; }
                    profile.databaseProjects[currentDb] = selectedPath;
                    connectionManager.refreshStatusBar();
                    // Only refresh this DB node — don't collapse other servers' trees
                    treeProvider.fireDbChange(profile.name, currentDb);
                    vscode.window.showInformationMessage(`Project path set: ${selectedPath}`);
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Failed to save project path: ${err.message}`);
                }
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

    // Refresh schema cache for the current file's DB (CodeLens $(sync) button + Ctrl+Shift+D)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.refreshDocumentCache', async (uri?: vscode.Uri) => {
            if (!connectionManager.isConnected) {
                vscode.window.showWarningMessage('T-SQL IntelliSense: Not connected');
                return;
            }
            const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
            const docDb = targetUri ? queryRunner.getDocumentDatabase(targetUri) : null;
            const dbName = docDb?.dbName ?? connectionManager.currentProfile?.database;
            if (!dbName) { return; }
            await connectionManager.softSwitchDatabase(dbName);
            const actualDb = connectionManager.currentProfile?.database;
            if (!actualDb || actualDb.toLowerCase() !== dbName.toLowerCase()) {
                vscode.window.showWarningMessage(
                    `T-SQL IntelliSense: "${dbName}" is not accessible on this connection. Connect to the right server first.`
                );
                return;
            }
            await loadSchemaForActiveDb();
        })
    );

    // Toggle bottom panel (Ctrl+R — SSMS style: alt paneli aşağı indir / kaldır)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.toggleResultsPanel', () => {
            vscode.commands.executeCommand('workbench.action.togglePanel');
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
                        // CREATE → CREATE OR ALTER dönüşümü
                        script = script.replace(/^(\s*)CREATE\s+/i, '$1CREATE OR ALTER ');
                    }
                } catch {}
            }

            if (!script) {
                vscode.window.showWarningMessage(`Could not retrieve definition for ${objName}`);
                return;
            }

            const editor = vscode.window.activeTextEditor;
            if (editor) {
                // Format the script with current style settings (casing, layout)
                const { SqlFormatter } = require('./formatter/sqlFormatter');
                const fmt = new SqlFormatter(styleLoader);
                const formatted = fmt.format(script! + '\nGO\n');
                const cursorLine = editor.selection.active.line;
                const lineRange = editor.document.lineAt(cursorLine).rangeIncludingLineBreak;
                await editor.edit(editBuilder => {
                    editBuilder.replace(lineRange, formatted);
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
        if (!profile) { return; }

        // Get project path for current database from databaseProjects only (no legacy fallback)
        const currentDb = profile.database;
        const projectPath = profile.databaseProjects?.[currentDb];

        if (!projectPath) {
            // Check if SQL contains DDL — only warn for DDL statements
            const ddlPattern = /^\s*(CREATE|ALTER|CREATE\s+OR\s+ALTER)\s+(PROC(EDURE)?|VIEW|FUNCTION|TRIGGER|TABLE)\b/im;
            if (ddlPattern.test(sql)) {
                const action = await vscode.window.showWarningMessage(
                    `"${currentDb}" için proje klasörü tanımlı değil. DDL değişiklikleri senkronize edilemez.`,
                    'Set Project Path'
                );
                if (action === 'Set Project Path') {
                    const editCopy = { ...profile, database: currentDb };
                    ConnectionFormProvider.show(context, connectionManager, treeProvider, editCopy);
                }
            }
            return;
        }

        try {
            await projectSync.syncAfterExecution(sql, projectPath, buildObjectScript);
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

    // Tree: Edit Connection (from ConnectionItem or DatabaseItem)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.editConnection', (item: any) => {
            // DatabaseItem has parentProfileName + dbName; ConnectionItem has profileName
            const profileName = item?.profileName || item?.parentProfileName;
            if (!profileName) { return; }
            const profiles = connectionManager.getSavedProfiles();
            const profile = profiles.find(p => p.name === profileName);
            if (profile) {
                // If triggered from a DatabaseItem, override database to that DB
                if (item?.dbName && item?.parentProfileName) {
                    const editCopy = { ...profile, database: item.dbName };
                    ConnectionFormProvider.show(context, connectionManager, treeProvider, editCopy);
                } else {
                    ConnectionFormProvider.show(context, connectionManager, treeProvider, profile);
                }
            }
        })
    );

    // Tree: Delete Connection
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.deleteConnection', async (item: any) => {
            if (!item?.profileName) {
                vscode.window.showErrorMessage(`[DEBUG] Delete called but item.profileName missing. item=${JSON.stringify(item)}`);
                return;
            }
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

            let deleted = false;

            // 1. Try tsql-intellisense settings (all scopes)
            const config = vscode.workspace.getConfiguration('tsql-intellisense');
            const inspected = config.inspect<any[]>('connections');
            for (const [value, target] of [
                [inspected?.globalValue, vscode.ConfigurationTarget.Global],
                [inspected?.workspaceValue, vscode.ConfigurationTarget.Workspace],
            ] as [any[] | undefined, vscode.ConfigurationTarget][]) {
                if (value?.some((c: any) => c.name === item.profileName)) {
                    await config.update('connections', value.filter((c: any) => c.name !== item.profileName), target);
                    deleted = true;
                }
            }

            // 2. Try mssql extension settings (connection may have originated from there)
            if (!deleted) {
                const mssqlConfig = vscode.workspace.getConfiguration('mssql');
                const mssqlInspected = mssqlConfig.inspect<any[]>('connections');
                const expectedName = item.profileName as string;
                for (const [value, target] of [
                    [mssqlInspected?.globalValue, vscode.ConfigurationTarget.Global],
                    [mssqlInspected?.workspaceValue, vscode.ConfigurationTarget.Workspace],
                ] as [any[] | undefined, vscode.ConfigurationTarget][]) {
                    if (value?.some((c: any) => {
                        const generatedName = c.profileName || `${c.server}/${c.database || 'default'}`;
                        return generatedName === expectedName;
                    })) {
                        await mssqlConfig.update('connections', value.filter((c: any) => {
                            const generatedName = c.profileName || `${c.server}/${c.database || 'default'}`;
                            return generatedName !== expectedName;
                        }), target);
                        deleted = true;
                    }
                }
            }

            treeProvider.fireAllConnections();
        })
    );

    // Tree: Connect to a profile (handles both string from TreeItem.command and ConnectionItem from context menu)
    let connectingInProgress = false;
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.treeConnect', async (arg: any) => {
            const profileName = typeof arg === 'string' ? arg : arg?.profileName;
            if (!profileName) { return; }

            // Already connecting → cancel instead of opening a second connection
            if (connectingInProgress) {
                connectionManager.cancelConnect();
                connectingInProgress = false;
                treeProvider.fireAllConnections();
                return;
            }

            const profiles = connectionManager.getSavedProfiles();
            const profile = profiles.find(p => p.name === profileName);
            if (!profile) { return; }

            connectingInProgress = true;
            let succeeded = false;
            try {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Connecting to ${profileName}...`,
                        cancellable: true,
                    },
                    async (_progress, token) => {
                        token.onCancellationRequested(() => {
                            connectionManager.cancelConnect();
                            connectingInProgress = false;
                            treeProvider.fireAllConnections();
                        });
                        await connectionManager.connect(profile);
                        succeeded = true;
                    }
                );
            } catch (err: any) {
                if (!connectingInProgress) { return; } // was cancelled
                vscode.window.showErrorMessage(err.message);
            } finally {
                connectingInProgress = false;
                treeProvider.fireAllConnections();
            }

            // Auto-expand the connected server node
            if (succeeded) {
                const rootItems = await treeProvider.getChildren(undefined);
                const connItem = rootItems?.find((i: any) => i.profileName === profileName);
                if (connItem) {
                    try { await treeView.reveal(connItem, { expand: 1, select: false }); } catch { /* ignore */ }
                }
            }
        })
    );

    // CodeLens: run the batch starting at a specific line (up to next GO or end of file)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.runBatchAtLine', async (uri: vscode.Uri, startLine: number) => {
            const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
            if (!doc) { return; }

            const lines = doc.getText().split('\n');
            const batchLines: string[] = [];
            for (let i = startLine; i < lines.length; i++) {
                if (/^\s*GO\s*$/i.test(lines[i])) { break; }
                batchLines.push(lines[i]);
            }
            const batchText = batchLines.join('\n').trim();
            if (batchText) {
                await queryRunner.runQueryText(batchText);
            }
        })
    );

    // CodeLens: change the DB associated with the current document
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.changeDocDatabase', async (uri: vscode.Uri) => {
            const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
            if (!targetUri) { return; }

            // Step 1: Pick connection (server)
            const savedProfiles: any[] = vscode.workspace.getConfiguration('tsql-intellisense').get('connections', []);
            const activeProfile = connectionManager.currentProfile;

            interface ConnPickItem extends vscode.QuickPickItem { profileName: string; isActive: boolean; }
            interface DbPickItem extends vscode.QuickPickItem { dbName: string; }

            const connItems: ConnPickItem[] = savedProfiles.map((p: any) => {
                const isActive = activeProfile?.name === p.name;
                return {
                    label: `$(server) ${p.name}`,
                    description: p.server,
                    detail: isActive ? '$(circle-filled) active connection' : undefined,
                    profileName: p.name as string,
                    isActive,
                };
            });

            if (connItems.length === 0) {
                vscode.window.showWarningMessage('No saved connections found');
                return;
            }

            const current = queryRunner.getDocumentDatabase(targetUri);
            const pickedConn = await vscode.window.showQuickPick<ConnPickItem>(connItems, {
                placeHolder: 'Select server connection',
                title: 'Change File Connection & Database (1/2)',
            });
            if (!pickedConn) { return; }

            // Step 2: Pick database for selected connection
            let dbNames: string[] = [];
            if (pickedConn.isActive) {
                // Active connection: try live query first, fall back to cached
                try {
                    const result = await connectionManager.executeQuery(
                        `SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name`
                    );
                    dbNames = result.rows.map(r => r['name'] as string);
                } catch {
                    dbNames = treeProvider.getActiveDatabaseList();
                }
            } else {
                // Non-active connection: use cached DB list from tree
                dbNames = treeProvider.getCachedDatabases(pickedConn.profileName);
                if (dbNames.length === 0) {
                    // Fallback: show just the profile's configured default DB
                    const profile = savedProfiles.find((p: any) => p.name === pickedConn.profileName);
                    if (profile?.database) { dbNames = [profile.database]; }
                }
            }

            if (dbNames.length === 0) {
                vscode.window.showWarningMessage(`No databases available for ${pickedConn.profileName}. Expand it in the tree first.`);
                return;
            }

            const dbItems: DbPickItem[] = dbNames.map(name => ({
                label: `$(database) ${name}`,
                description: (name.toLowerCase() === (current?.dbName ?? '').toLowerCase()
                    && pickedConn.profileName === current?.profileName) ? '(current)' : '',
                dbName: name,
            }));

            const pickedDb = await vscode.window.showQuickPick<DbPickItem>(dbItems, {
                placeHolder: 'Select database for this file',
                title: `Change File Database — ${pickedConn.profileName} (2/2)`,
            });
            if (!pickedDb) { return; }

            queryRunner.setDocumentDatabase(targetUri, { profileName: pickedConn.profileName, dbName: pickedDb.dbName });
            codeLensProvider.refresh();
        })
    );

    // Refresh schema for a DB — switch if needed, cross-DB query if same server
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.loadDatabaseSchema', async (arg: any) => {
            const profileName: string = arg?.parentProfileName;
            const dbName: string = arg?.dbName;
            if (!profileName || !dbName) { return; }

            const current = connectionManager.currentProfile;
            const isSameServer = current?.name === profileName;
            const isActiveDb = isSameServer && current?.database.toLowerCase() === dbName.toLowerCase();

            if (isActiveDb) {
                // Already on this DB — just refresh schema
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Refreshing schema cache...' },
                    () => schemaCache.refresh()
                );
                // Only refresh this DB node — don't collapse other servers' trees
                treeProvider.fireDbChange(profileName, dbName);
            } else if (isSameServer) {
                // Same server, different DB — reload via cross-DB (clear cache first)
                treeProvider.clearDbCache(profileName);
                await loadCrossDbSchema(profileName, dbName);
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

    // Tree: New Query — from DB node (remembers which DB) or server node (asks DB with picker)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.newQueryFromTree', async (arg: any) => {
            if (arg?.dbName && arg?.parentProfileName) {
                // Opened from a DatabaseItem → bind to that DB directly
                const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: '' });
                // Set association BEFORE showTextDocument so onDidChangeActiveTextEditor doesn't override it
                queryRunner.setDocumentDatabase(doc.uri, {
                    profileName: arg.parentProfileName,
                    dbName: arg.dbName,
                });
                await vscode.window.showTextDocument(doc);
                codeLensProvider.refresh();
                // Refresh object names only (fast) — columns load lazily on first alias.col use
                void (async () => {
                    await connectionManager.softSwitchDatabase(arg.dbName);
                    await schemaCache.loadObjectNames();
                    schemaCache.startAutoRefresh();
                    vscode.window.showInformationMessage(
                        `T-SQL IntelliSense: Objects loaded (${schemaCache.objectCount}) — ${arg.dbName}`
                    );
                })();
            } else if (arg?.profileName) {
                // Opened from a ConnectionItem (server level) → ask which DB
                const currentProfile = connectionManager.currentProfile;
                let dbName = currentProfile?.database || '';

                try {
                    const dbResult = await connectionManager.executeQuery(
                        `SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name`
                    );
                    const dbNames = dbResult.rows.map(r => r['name'] as string);
                    // Build QuickPickItems with current DB marked as default
                    const items: vscode.QuickPickItem[] = dbNames.map(name => ({
                        label: name,
                        description: name.toLowerCase() === dbName.toLowerCase() ? '(current)' : '',
                    }));
                    const picked = await vscode.window.showQuickPick(items, {
                        placeHolder: 'Select database for this query',
                        title: 'New Query — Select Database',
                    });
                    if (!picked) { return; } // cancelled
                    dbName = picked.label;
                } catch {
                    // If DB list fails, use current DB
                }

                if (!dbName) { return; }

                // Switch DB if needed
                if (currentProfile && currentProfile.database.toLowerCase() !== dbName.toLowerCase()) {
                    const switchedProfile = { ...currentProfile, database: dbName };
                    try {
                        await connectionManager.connect(switchedProfile);
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to switch to ${dbName}: ${err.message}`);
                        return;
                    }
                }

                const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: '' });
                await vscode.window.showTextDocument(doc);
                queryRunner.setDocumentDatabase(doc.uri, {
                    profileName: arg.profileName,
                    dbName,
                });
            } else {
                // Command palette — no association, runs against current DB
                const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: '' });
                await vscode.window.showTextDocument(doc);
            }
        })
    );

    // Tree: Switch database (click on a different DB in the Databases folder)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.switchDatabase', async (profileNameOrItem: any, dbName?: string) => {
            // Handle both (profileName, dbName) from tree command and (DatabaseItem) from context menu
            let targetProfileName: string;
            let targetDb: string;
            if (typeof profileNameOrItem === 'string') {
                targetProfileName = profileNameOrItem;
                targetDb = dbName || '';
            } else {
                targetProfileName = profileNameOrItem?.parentProfileName;
                targetDb = profileNameOrItem?.dbName;
            }
            if (!targetProfileName || !targetDb) { return; }

            const profiles = connectionManager.getSavedProfiles();
            const profile = profiles.find(p => p.name === targetProfileName);
            if (!profile) { return; }

            // Keep the same profile name — just switch database
            const switchedProfile = { ...profile, database: targetDb };
            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Switching to ${targetDb}...` },
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

    // Tree: Filter items in a folder
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.filterItems', async (item: any) => {
            // Determine filter target from contextValue
            let target: FilterTarget | undefined;
            if (item?.contextValue === 'folder.databases') {
                target = 'databases';
            } else if (item?.folderType) {
                target = item.folderType as FilterTarget;
            }
            if (!target) { return; }

            const labels: Record<FilterTarget, string> = {
                databases: 'Databases',
                tables: 'Tables',
                views: 'Views',
                sps: 'Stored Procedures',
                functions: 'Functions',
            };

            const current = treeProvider.getFilter(target) || '';
            const value = await vscode.window.showInputBox({
                prompt: `Filter ${labels[target]} — Name Contains`,
                value: current,
                placeHolder: 'Type to filter by name (leave empty to clear)',
            });

            if (value === undefined) { return; } // cancelled
            treeProvider.setFilter(target, value);
        })
    );

    // Select in Object Explorer (editor right-click)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.selectInObjectExplorer', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active, /[\w]+/);
            if (!wordRange) { return; }
            const word = editor.document.getText(wordRange);

            const obj = schemaCache.findObject(word);
            if (!obj) {
                vscode.window.showWarningMessage(`"${word}" not found in schema cache`);
                return;
            }

            const profile = connectionManager.currentProfile;
            if (!profile) {
                vscode.window.showWarningMessage('Not connected to a database');
                return;
            }

            const typeMap: Record<string, ObjectType> = {
                TABLE: 'table', VIEW: 'view', PROCEDURE: 'sp', FUNCTION: 'func'
            };
            const objType: ObjectType = typeMap[obj.type] ?? 'table';

            const item = treeProvider.createObjectItem(obj.name, objType, profile.name, profile.database);
            try {
                await treeView.reveal(item, { select: true, focus: true, expand: true });
            } catch {
                vscode.window.showWarningMessage(`Could not reveal "${word}" in explorer`);
            }
        })
    );

    // Open project file (tree context menu OR editor Ctrl+F11)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.openProjectFile', async (item?: ObjectItem) => {
            const profile = connectionManager.currentProfile;
            if (!profile) {
                vscode.window.showWarningMessage('Not connected to a database');
                return;
            }

            // Called from editor (Ctrl+F11): resolve object from cursor word
            let objectName: string;
            let objectType: ObjectType;
            if (!item) {
                const editor = vscode.window.activeTextEditor;
                if (!editor) { return; }
                const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active, /[\w]+/);
                if (!wordRange) { return; }
                const word = editor.document.getText(wordRange);
                const obj = schemaCache.findObject(word);
                if (obj) {
                    const typeMap: Record<string, ObjectType> = { TABLE: 'table', VIEW: 'view', PROCEDURE: 'sp', FUNCTION: 'func' };
                    objectName = obj.name;
                    objectType = typeMap[obj.type] ?? 'sp';
                } else {
                    // Schema'da bulunamadı — tüm klasörlerde ara
                    objectName = word;
                    objectType = 'sp'; // will try all folders below
                }
            } else {
                objectName = item.objectName;
                objectType = item.objectType;
            }

            const dbName = item?.dbName ?? profile.database;
            const projectPath = profile.databaseProjects?.[dbName]
                ?? profile.databaseProjects?.[dbName.toLowerCase()]
                ?? profile.projectPath;
            if (!projectPath) {
                vscode.window.showWarningMessage('No project path configured for this database');
                return;
            }

            const folderMap: Record<ObjectType, string> = {
                table: 'Tables',
                view: 'Views',
                sp: 'Stored Procedures',
                func: 'Functions',
            };
            const subFolder = folderMap[objectType];

            // Try multiple folder patterns to find the file
            const searchPaths = [
                `${projectPath}/dbo/${subFolder}/${objectName}.sql`,
                `${projectPath}/${subFolder}/${objectName}.sql`,
            ];
            // If objectType came from fallback, try all folders
            if (!schemaCache.findObject(objectName)) {
                const allFolders = ['Views', 'Stored Procedures', 'Functions', 'Tables'];
                for (const f of allFolders) {
                    searchPaths.push(`${projectPath}/dbo/${f}/${objectName}.sql`);
                    searchPaths.push(`${projectPath}/${f}/${objectName}.sql`);
                }
            }
            for (const sp of searchPaths) {
                try {
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(sp));
                    await vscode.window.showTextDocument(doc);
                    return;
                } catch { /* try next */ }
            }
            vscode.window.showWarningMessage(`File not found: ${objectName}.sql in ${projectPath}`);
        })
    );

    // Tree: Clear filter
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.clearFilter', (item: any) => {
            let target: FilterTarget | undefined;
            if (item?.contextValue === 'folder.databases') {
                target = 'databases';
            } else if (item?.folderType) {
                target = item.folderType as FilterTarget;
            }
            if (target) {
                treeProvider.clearFilter(target);
            }
        })
    );

    // When connection changes: update icons, load DB list, refresh that server's folder
    connectionManager.onConnectionChanged(async (profile) => {
        // Update server icons only — no tree collapse
        treeProvider.fireAllConnections();
        vscode.commands.executeCommand('setContext', 'tsqlIntellisense.connected', !!profile);
        if (profile) {
            context.globalState.update('lastConnectionName', profile.name);
            try {
                const dbResult = await connectionManager.executeQuery(
                    `SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name`
                );
                currentDatabases = dbResult.rows.map(r => r['name'] as string);
                treeProvider.setDatabaseList(currentDatabases);
                treeProvider.setCachedData(profile.name, {
                    databases: currentDatabases,
                    tables: [], views: [], sps: [], funcs: [],
                });
            } catch {
                currentDatabases = [];
                treeProvider.setDatabaseList([]);
            }
            // Pre-load the connected DB's objects into cache (background)
            loadCrossDbSchema(profile.name, profile.database);
            // Refresh only this profile's Databases folder
            treeProvider.fireDbFolderChange(profile.name);
        } else {
            currentDatabases = [];
            schemaCache.stopAutoRefresh();
        }
    });

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
