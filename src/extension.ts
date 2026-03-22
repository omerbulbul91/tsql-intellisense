import * as vscode from 'vscode';
import { ConnectionManager, ConnectionProfile, TYPES } from './connection/connectionManager';
import { SchemaCache } from './cache/schemaCache';
import { SchemaCacheManager } from './cache/schemaCacheManager';
import { TsqlCompletionProvider } from './providers/completionProvider';
import { AlterProcProvider } from './providers/alterProcProvider';
import { QueryRunner } from './providers/queryRunner';
import { TsqlRenameProvider } from './providers/renameProvider';
import { TsqlDefinitionProvider } from './providers/definitionProvider';
import { ProjectSync } from './sync/projectSync';
import { SnippetProvider } from './providers/snippetProvider';
import { SnippetManagerProvider } from './providers/snippetManagerProvider';
import { ConnectionTreeProvider } from './providers/connectionTreeProvider';
import { DatabaseTreeItem, NodeType, FolderType } from './models/DatabaseNode';
import { TreeQueryService } from './services/TreeQueryService';
import { ScriptGenerator, ScriptAction } from './services/ScriptGenerator';
import { buildConnectionHeader, parseConnectionHeader } from './utils/connectionHeader';
import { TsqlCodeLensProvider } from './providers/sqlCodeLensProvider';
import { ConnectionFormProvider } from './providers/connectionFormProvider';
import { StyleLoader } from './formatter/styleLoader';
import { FormatterProvider } from './providers/formatterProvider';
import { StyleFormProvider } from './providers/styleFormProvider';
import { TranslationEditor } from './providers/translationEditor';
import { QueryHistoryProvider, QueryHistoryEntry } from './providers/queryHistoryProvider';

let connectionManager: ConnectionManager;
let schemaCacheManager: SchemaCacheManager;
let alterProcProvider: AlterProcProvider;
let queryRunner: QueryRunner;

export function activate(context: vscode.ExtensionContext) {
    // Mark extension as active (for keybinding priority over mssql)
    vscode.commands.executeCommand('setContext', 'tsqlIntellisense.active', true);

    // Initialize core components
    connectionManager = new ConnectionManager();
    schemaCacheManager = new SchemaCacheManager();
    const initialCache = schemaCacheManager.getOrCreate(
        connectionManager.currentProfile?.name ?? '__default__',
        connectionManager.currentProfile?.database ?? '__default__',
        connectionManager
    );
    schemaCacheManager.active = initialCache;

    // Proxy that always delegates to schemaCacheManager.active
    // This way all providers always use the current active cache
    const schemaCache = new Proxy(initialCache, {
        get(_target, prop, receiver) {
            const active = schemaCacheManager.active;
            if (!active) { return undefined; }
            const val = (active as any)[prop];
            return typeof val === 'function' ? val.bind(active) : val;
        }
    }) as SchemaCache;
    alterProcProvider = new AlterProcProvider(connectionManager, schemaCache);
    queryRunner = new QueryRunner(connectionManager, context.extensionUri);

    // Register sidebar tree view
    const treeQueryService = new TreeQueryService(connectionManager);
    const treeProvider = new ConnectionTreeProvider(treeQueryService, context.extensionUri);

    /** Full schema load for the currently active DB — called via Ctrl+Shift+D refresh */
    async function loadSchemaForActiveDb(): Promise<void> {
        const profile = connectionManager.currentProfile;
        if (!profile) { return; }
        const dbName = profile.database;
        const cache = schemaCacheManager.getOrCreate(profile.name, dbName, connectionManager);
        schemaCacheManager.active = cache;
        await cache.loadObjectNames();
        cache.startAutoRefresh();
        vscode.window.showInformationMessage(
            `T-SQL IntelliSense: Schema loaded (${cache.objectCount} objects) — ${dbName}`
        );
        const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
        statusItem.text = '$(sync~spin) T-SQL: Loading schema details...';
        statusItem.show();
        await cache.loadAllColumns().catch(e => console.error('loadAllColumns failed:', e));
        await cache.loadForeignKeys().catch(e => console.error('loadForeignKeys failed:', e));
        await cache.loadIndexes().catch(e => console.error('loadIndexes failed:', e));
        await cache.loadTriggers().catch(e => console.error('loadTriggers failed:', e));
        await cache.loadViewDefinitions().catch(e => console.error('loadViewDefinitions failed:', e));
        statusItem.text = cache.isFullyLoaded
            ? '$(check) T-SQL: Schema ready'
            : '$(warning) T-SQL: Schema partially loaded';
        setTimeout(() => statusItem.dispose(), 5000);
    }

    const treeView = vscode.window.createTreeView('tsqlConnections', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    // Register Query History view
    const historyProvider = new QueryHistoryProvider(context.globalState);
    const historyView = vscode.window.createTreeView('tsqlQueryHistory', {
        treeDataProvider: historyProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(historyView);

    // Single-click / double-click detection for history tree
    let historyLastClickTime = 0;
    let historyLastClickId = '';
    let historyClickTimer: ReturnType<typeof setTimeout> | null = null;
    let historyPreviewDoc: vscode.TextDocument | null = null;

    /** Find a unique untitled URI: try base name, then (1), (2), ... */
    function findUniqueUntitledUri(baseName: string): vscode.Uri {
        const openUris = new Set(vscode.workspace.textDocuments.map(d => d.uri.toString()));
        const candidate = vscode.Uri.parse(`untitled:${baseName}`);
        if (!openUris.has(candidate.toString())) { return candidate; }
        const ext = baseName.includes('.') ? baseName.slice(baseName.lastIndexOf('.')) : '';
        const stem = baseName.includes('.') ? baseName.slice(0, baseName.lastIndexOf('.')) : baseName;
        for (let i = 1; i < 100; i++) {
            const uri = vscode.Uri.parse(`untitled:${stem}(${i})${ext}`);
            if (!openUris.has(uri.toString())) { return uri; }
        }
        return vscode.Uri.parse(`untitled:${stem}(${Date.now()})${ext}`);
    }

    /** Check if a file path exists on disk */
    function fileExists(filePath: string): boolean {
        try { return require('fs').existsSync(filePath); } catch { return false; }
    }

    async function openHistoryFile(entry: QueryHistoryEntry, preview: boolean): Promise<void> {
        let doc: vscode.TextDocument;
        const isRealFile = fileExists(entry.filePath);

        if (isRealFile) {
            const uri = vscode.Uri.file(entry.filePath);
            doc = await vscode.workspace.openTextDocument(uri);
        } else if (preview) {
            // Single click — reuse tracked preview document
            const isPreviewOpen = historyPreviewDoc && vscode.workspace.textDocuments.some(d => d.uri.toString() === historyPreviewDoc!.uri.toString());
            if (isPreviewOpen && historyPreviewDoc) {
                doc = historyPreviewDoc;
                const edit = new vscode.WorkspaceEdit();
                const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
                edit.replace(doc.uri, fullRange, entry.sql);
                await vscode.workspace.applyEdit(edit);
            } else {
                const previewUri = vscode.Uri.parse(`untitled:HistoryPreview.sql`);
                doc = await vscode.workspace.openTextDocument(previewUri);
                const edit = new vscode.WorkspaceEdit();
                edit.insert(doc.uri, new vscode.Position(0, 0), entry.sql);
                await vscode.workspace.applyEdit(edit);
                historyPreviewDoc = doc;
            }
        } else {
            // Double click — open with original file name (.sql ensured), unique if taken
            const name = entry.fileName.endsWith('.sql') ? entry.fileName : entry.fileName + '.sql';
            const uri = findUniqueUntitledUri(name);
            doc = await vscode.workspace.openTextDocument(uri);
            const edit = new vscode.WorkspaceEdit();
            edit.insert(doc.uri, new vscode.Position(0, 0), entry.sql);
            await vscode.workspace.applyEdit(edit);
        }

        await vscode.window.showTextDocument(doc, { preview });
        queryRunner.setDocumentDatabase(doc.uri, {
            profileName: entry.connectionName,
            dbName: entry.databaseName,
        });
        const profile = connectionManager.getSavedProfiles().find(p => p.name === entry.connectionName);
        if (profile) {
            if (!connectionManager.isConnected || connectionManager.currentProfile?.name !== entry.connectionName) {
                await connectionManager.connect({ ...profile, database: entry.databaseName });
            } else if (connectionManager.currentProfile?.database?.toLowerCase() !== entry.databaseName.toLowerCase()) {
                await connectionManager.softSwitchDatabase(entry.databaseName);
            }
        }
    }

    // Click handler: command fires on every click (works for same-item re-clicks too)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.historyItemClicked', (entry: QueryHistoryEntry) => {
            const now = Date.now();
            const isDoubleClick = (now - historyLastClickTime < 400) && historyLastClickId === entry.id;
            historyLastClickTime = now;
            historyLastClickId = entry.id;

            if (historyClickTimer) { clearTimeout(historyClickTimer); historyClickTimer = null; }

            if (isDoubleClick) {
                // Double click → open with original file name (pinned)
                openHistoryFile(entry, false);
            } else {
                // Single click → preview (wait to rule out double click)
                historyClickTimer = setTimeout(() => {
                    openHistoryFile(entry, true);
                }, 400);
            }
        })
    );

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

    // Open Snippet Manager
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.openSnippetManager', () => {
            SnippetManagerProvider.createOrShow(context.extensionUri, snippetProvider);
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

    // Open Translation Editor
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.editTranslations', () => {
            TranslationEditor.show(context);
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

    // Helper: create untitled SQL doc with SSMS-style SQLQuery{N}.sql name
    async function createSqlDocument(content: string = ''): Promise<vscode.TextDocument> {
        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const lastDate = context.globalState.get<string>('tsql.lastQueryDate', '');
        const lastNum = lastDate === today ? context.globalState.get<number>('tsql.lastQueryNumber', 0) : 0;
        const nextNum = lastNum + 1;
        await context.globalState.update('tsql.lastQueryNumber', nextNum);
        await context.globalState.update('tsql.lastQueryDate', today);
        const uri = vscode.Uri.parse(`untitled:SQLQuery${nextNum}.sql`);
        const doc = await vscode.workspace.openTextDocument(uri);
        if (content) {
            const edit = new vscode.WorkspaceEdit();
            edit.insert(doc.uri, new vscode.Position(0, 0), content);
            await vscode.workspace.applyEdit(edit);
        }
        return doc;
    }

    // New SQL File command (Ctrl+Alt+S) — SSMS-style SQLQuery{N}.sql naming
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.newSqlFile', async () => {
            // Inherit DB from the currently active SQL file; fall back to current profile
            const activeEditor = vscode.window.activeTextEditor;
            const sourceDb = activeEditor?.document.languageId === 'sql'
                ? queryRunner.getDocumentDatabase(activeEditor.document.uri)
                : null;
            const current = connectionManager.currentProfile;
            const dbAssoc = sourceDb ?? (current ? { profileName: current.name, dbName: current.database } : null);

            const doc = await createSqlDocument();
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
            let docDb = queryRunner.getDocumentDatabase(editor.document.uri);
            if (!docDb) {
                // Try to parse from connection header comment
                const firstLine = editor.document.lineAt(0).text;
                const header = parseConnectionHeader(firstLine);
                if (header) {
                    docDb = { profileName: header.profileName, dbName: header.database };
                    queryRunner.setDocumentDatabase(editor.document.uri, docDb);
                } else {
                    // No header, no association — associate with current DB
                    const current = connectionManager.currentProfile;
                    if (current) {
                        docDb = { profileName: current.name, dbName: current.database };
                        queryRunner.setDocumentDatabase(editor.document.uri, docDb);
                    }
                }
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
                    // Refresh tree to pick up the new project path
                    treeProvider.fullRefresh();
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
            const activeCache = schemaCacheManager.active;
            if (!activeCache) { return; }
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Refreshing schema cache...' },
                () => activeCache.refresh()
            );
            vscode.window.showInformationMessage(
                `T-SQL IntelliSense: Schema refreshed (${activeCache.objectCount} objects)`
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
            // If focus is in the panel (Query Results), minimize it
            if (!vscode.window.activeTextEditor) {
                vscode.commands.executeCommand('workbench.action.togglePanel');
            } else {
                // Focus is in editor, open/focus Query Results panel
                vscode.commands.executeCommand('tsqlResults.focus');
            }
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
            const obj = schemaCacheManager.active?.findObject(objName);

            if (obj && obj.type === 'TABLE') {
                script = buildObjectScript(objName);
            } else {
                // Always fetch from DB — no formatting, preserve DB definition as-is
                try {
                    const result = await connectionManager.executeQuery(
                        `SELECT COALESCE(
                            OBJECT_DEFINITION(OBJECT_ID(@objectName)),
                            OBJECT_DEFINITION(OBJECT_ID(@objectName, 'TR'))
                        ) AS [definition]`,
                        { objectName: { type: TYPES.NVarChar, value: objName } }
                    );
                    if (result.rows.length > 0 && result.rows[0]['definition']) {
                        script = (result.rows[0]['definition'] as string).replace(/^\s*\n/, '').trimStart();
                        // Only CREATE → CREATE OR ALTER, with casing rule applied to the prefix
                        const { applyCasing } = require('./formatter/casingRule');
                        const { tokenize } = require('./formatter/sqlTokenizer');
                        const prefixTokens = tokenize('CREATE OR ALTER ');
                        const casedPrefix = applyCasing(prefixTokens, styleLoader.getCasingOptions());
                        script = script.replace(/^(\s*)CREATE\s+/i, '$1' + casedPrefix);
                        // Ensure schema prefix (dbo.) is present after object type keyword
                        script = script.replace(
                            /^(.*?(?:VIEW|PROC(?:EDURE)?|FUNCTION|TRIGGER)\s+)(?![\w]*\.)([\w]+)/i,
                            '$1dbo.$2'
                        );
                    }
                } catch {}
            }

            if (!script) {
                vscode.window.showWarningMessage(`Could not retrieve definition for ${objName}`);
                return;
            }

            const editor = vscode.window.activeTextEditor;
            if (editor) {
                // GO with active casing
                const { applyCasing: caseFn } = require('./formatter/casingRule');
                const { tokenize: tok } = require('./formatter/sqlTokenizer');
                const goText = caseFn(tok('GO'), styleLoader.getCasingOptions());
                const scriptWithGo = script!.replace(/[\r\n\s]+$/, '') + '\n' + goText + '\n';
                const cursorLine = editor.selection.active.line;
                const lineRange = editor.document.lineAt(cursorLine).rangeIncludingLineBreak;
                await editor.edit(editBuilder => {
                    editBuilder.replace(lineRange, scriptWithGo);
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

    // INSERT INTO table → column list + VALUES template
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.insertInsertTemplate', async (tableName: string, dbName?: string) => {
            if (!tableName) { return; }
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }

            try {
                const allColumns = dbName
                    ? await schemaCacheManager.active?.loadColumnsForDbTable(dbName, tableName) ?? []
                    : await schemaCacheManager.active?.getColumns(tableName) ?? [];
                if (allColumns.length === 0) { return; }

                // Skip IDENTITY columns
                const columns = allColumns.filter(c => !c.isIdentity);
                if (columns.length === 0) { return; }

                const config = vscode.workspace.getConfiguration('tsql-intellisense');
                const maxLine = config.get<number>('maxLineLength', 120);
                const commasBefore = config.get<any>('styleOverrides')?.lists?.placeCommasBeforeItems ?? true;

                const qualifyWithOwner = config.get<boolean>('qualifyWithOwner', true);
                const qualifiedName = qualifyWithOwner ? `dbo.${tableName}` : tableName;
                const insertPrefix = `Insert Into ${qualifiedName} (`;
                const indentForWrap = ' '.repeat(insertPrefix.length);

                // Build column list with line wrapping
                const colNames = columns.map(c => c.name);
                const colLines: string[] = [];
                let currentLine = colNames[0];

                for (let i = 1; i < colNames.length; i++) {
                    const test = currentLine + ', ' + colNames[i];
                    if (maxLine > 0 && (colLines.length === 0 ? insertPrefix.length + test.length + 1 : indentForWrap.length + test.length + 1) > maxLine) {
                        if (commasBefore) {
                            colLines.push(currentLine);
                            currentLine = ', ' + colNames[i];
                        } else {
                            colLines.push(currentLine + ',');
                            currentLine = colNames[i];
                        }
                    } else {
                        currentLine = test;
                    }
                }
                colLines.push(currentLine);

                // Format: first line after "(", subsequent lines indented
                let colListStr: string;
                if (colLines.length === 1) {
                    colListStr = colLines[0];
                } else {
                    colListStr = colLines[0] + '\n' + colLines.slice(1).map(l => indentForWrap + l).join('\n');
                }

                // Build full type string: nvarchar(100), varchar(max), int, etc.
                function getFullType(col: { dataType: string; maxLength: number | null }): string {
                    const dt = col.dataType;
                    if (col.maxLength === null || col.maxLength === undefined) { return dt; }
                    const needsLen = ['varchar', 'nvarchar', 'char', 'nchar', 'binary', 'varbinary'].includes(dt.toLowerCase());
                    if (!needsLen) { return dt; }
                    const len = col.maxLength === -1 ? 'max' : String(col.maxLength);
                    return `${dt}(${len})`;
                }

                // Determine default value for each column
                function getInsertDefault(col: { dataType: string; isNullable: boolean; hasDefault?: boolean }): string {
                    if (col.hasDefault) { return 'Default'; }
                    if (col.isNullable) { return 'Null'; }
                    return getDefaultValue(col.dataType);
                }

                // Build VALUES with type comments, aligned
                const defaults = columns.map(c => getInsertDefault(c));
                const maxDefaultLen = Math.max(...defaults.map(v => v.length));
                const valuesLines: string[] = [];

                for (let i = 0; i < columns.length; i++) {
                    const col = columns[i];
                    const defaultVal = defaults[i];
                    const valPadding = ' '.repeat(Math.max(1, maxDefaultLen - defaultVal.length + 1));
                    const fullType = getFullType(col);
                    const comment = `-- ${col.name} - ${fullType}`;

                    if (i === 0) {
                        valuesLines.push(`Values (${defaultVal}${valPadding}${comment}`);
                    } else if (commasBefore) {
                        valuesLines.push(`      , ${defaultVal}${valPadding}${comment}`);
                    } else {
                        valuesLines[valuesLines.length - 1] = valuesLines[valuesLines.length - 1].replace(/(\s+--\s)/, ',$1');
                        valuesLines.push(`        ${defaultVal}${valPadding}${comment}`);
                    }
                }
                valuesLines.push('    )');

                const snippet = ` (${colListStr})\n${valuesLines.join('\n')}`;

                const pos = editor.selection.active;
                await editor.edit(editBuilder => {
                    editBuilder.insert(pos, snippet);
                });
            } catch (err: any) {
                console.error('insertInsertTemplate failed:', err.message);
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
        const obj = schemaCacheManager.active?.findObject(tableName);
        if (!obj) { return null; }

        // VIEW → return actual definition
        if (obj.type === 'VIEW') {
            const viewDef = schemaCacheManager.active?.getViewDefinition(tableName);
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

        const indexes = schemaCacheManager.active?.getIndexes(tableName) ?? [];
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

        const fks = schemaCacheManager.active?.getForeignKeysForTable(tableName) ?? [];
        for (const fk of fks) {
            lines.push(`ALTER TABLE [dbo].[${fk.parentTable}] ADD CONSTRAINT [${fk.fkName}] FOREIGN KEY ([${fk.parentColumn}]) REFERENCES [dbo].[${fk.referencedTable}] ([${fk.referencedColumn}])`);
            lines.push('GO');
        }

        const triggers = schemaCacheManager.active?.getTriggers(tableName) ?? [];
        for (const trig of triggers) {
            if (trig.definition) {
                lines.push(trig.definition.trim());
                lines.push('GO');
            }
        }

        return lines.join('\n');
    }

    // Query History: record on run, only if content changed since last history entry
    const lastHistorySql = new Map<string, string>();
    queryRunner.onQueryExecuted(({ sql }) => {
        const editor = vscode.window.activeTextEditor;
        const profile = connectionManager.currentProfile;
        if (!profile || !editor) { return; }
        // Use URI string as key (works for both file and untitled schemes)
        const uriKey = editor.document.uri.toString();
        const isUntitled = editor.document.uri.scheme === 'untitled';
        const filePath = isUntitled ? uriKey : editor.document.uri.fsPath;
        // Skip if SQL content hasn't changed since last history entry
        if (lastHistorySql.get(uriKey) === sql) { return; }
        lastHistorySql.set(uriKey, sql);
        const docDb = queryRunner.getDocumentDatabase(editor.document.uri);
        const dbName = docDb?.dbName ?? profile.database;
        const fileName = isUntitled
            ? (editor.document.uri.path || 'Untitled')
            : require('path').basename(filePath);
        historyProvider.addEntry({
            fileName,
            filePath,
            sql,
            connectionName: profile.name,
            databaseName: dbName,
        });
    });

    // Query History commands
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.refreshQueryHistory', () => {
            historyProvider.refresh();
        }),
        vscode.commands.registerCommand('tsql-intellisense.clearQueryHistory', () => {
            historyProvider.clearAll();
        }),
        vscode.commands.registerCommand('tsql-intellisense.openQueryHistorySettings', () => {
            StyleFormProvider.show(context, styleLoader, 'history');
        }),
        vscode.commands.registerCommand('tsql-intellisense.openConnectionSettings', () => {
            StyleFormProvider.show(context, styleLoader, 'connections');
        }),
        vscode.commands.registerCommand('tsql-intellisense.deleteHistoryEntry', (item: any) => {
            if (item?.entry?.id) {
                historyProvider.deleteEntry(item.entry.id);
            }
        }),
        vscode.commands.registerCommand('tsql-intellisense.openHistoryEntry', async (entry: QueryHistoryEntry) => {
            await openHistoryFile(entry, true);
        })
    );

    // Project Sync: auto-update SQL project files after DDL execution
    const projectSync = new ProjectSync(connectionManager, schemaCache); // uses initial cache; ProjectSync reacts to onSchemaLoaded events
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

    // Tree: Edit Connection (from DatabaseTreeItem — connection or database node)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.editConnection', (item: any) => {
            const profileName = item instanceof DatabaseTreeItem ? item.profileName : (item?.profileName || item?.parentProfileName);
            if (!profileName) { return; }
            const profiles = connectionManager.getSavedProfiles();
            const profile = profiles.find(p => p.name === profileName);
            if (profile) {
                const dbName = item instanceof DatabaseTreeItem ? item.databaseName : item?.dbName;
                if (dbName && item?.nodeType === NodeType.Database) {
                    const editCopy = { ...profile, database: dbName };
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

            treeProvider.fullRefresh();
        })
    );

    // Tree: Connect to a profile (handles both string from TreeItem.command and DatabaseTreeItem from context menu)
    let connectingInProgress = false;
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.treeConnect', async (arg: any) => {
            const profileName = typeof arg === 'string'
                ? arg
                : (arg instanceof DatabaseTreeItem ? arg.profileName : arg?.profileName);
            if (!profileName) { return; }

            // Already connecting → cancel instead of opening a second connection
            if (connectingInProgress) {
                connectionManager.cancelConnect();
                connectingInProgress = false;
                treeProvider.fullRefresh();
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
                            treeProvider.fullRefresh();
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
                treeProvider.fullRefresh();
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

            // Step 2: Pick database — connect via TreeQueryService pool if needed
            let dbNames: string[] = [];
            try {
                if (!treeQueryService.isConnected(pickedConn.profileName)) {
                    await treeQueryService.connect(pickedConn.profileName);
                }
                const result = await treeQueryService.execute(
                    `SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name`,
                    undefined,
                    pickedConn.profileName
                );
                dbNames = result.rows.map(r => r['name'] as string);
            } catch {
                // Fallback: show just the profile's configured default DB
                const profile = savedProfiles.find((p: any) => p.name === pickedConn.profileName);
                if (profile?.database) { dbNames = [profile.database]; }
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

            // Load SchemaCache for IntelliSense
            void (async () => {
                if (connectionManager.currentProfile?.name !== pickedConn.profileName) {
                    const p = connectionManager.getSavedProfiles().find(x => x.name === pickedConn.profileName);
                    if (p) { await connectionManager.connect({ ...p, database: pickedDb.dbName }); }
                } else {
                    await connectionManager.softSwitchDatabase(pickedDb.dbName);
                }
                const cache = schemaCacheManager.getOrCreate(pickedConn.profileName, pickedDb.dbName, connectionManager);
                schemaCacheManager.active = cache;
                if (!cache.isLoaded) {
                    await cache.loadObjectNames();
                    cache.startAutoRefresh();
                }
                vscode.window.showInformationMessage(`T-SQL IntelliSense: Objects loaded (${cache.objectCount}) — ${pickedDb.dbName}`);
            })();
        })
    );

    // CodeLens: switch database only (same connection) — skips connection picker
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.switchDocDatabase', async (uri: vscode.Uri) => {
            const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
            if (!targetUri) { return; }

            const current = queryRunner.getDocumentDatabase(targetUri);
            const profileName = current?.profileName ?? connectionManager.currentProfile?.name;
            if (!profileName) {
                // No connection yet — fall back to full 2-step picker
                vscode.commands.executeCommand('tsql-intellisense.changeDocDatabase', targetUri);
                return;
            }

            // Query DB list from this profile's pool
            let dbNames: string[] = [];
            try {
                if (!treeQueryService.isConnected(profileName)) {
                    await treeQueryService.connect(profileName);
                }
                const result = await treeQueryService.execute(
                    `SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name`,
                    undefined, profileName
                );
                dbNames = result.rows.map(r => r['name'] as string);
            } catch {
                const profile = connectionManager.getSavedProfiles().find(p => p.name === profileName);
                if (profile?.database) { dbNames = [profile.database]; }
            }

            if (dbNames.length === 0) { return; }

            // Add disconnect option
            interface DbPickItem extends vscode.QuickPickItem { dbName: string; }
            const dbItems: DbPickItem[] = dbNames.map(name => ({
                label: `$(database) ${name}`,
                description: name.toLowerCase() === (current?.dbName ?? '').toLowerCase() ? '(current)' : '',
                dbName: name,
            }));
            dbItems.push({
                label: '$(debug-disconnect) Disconnect',
                description: 'Close the current connection',
                dbName: '__disconnect__',
            });

            const picked = await vscode.window.showQuickPick(dbItems, {
                placeHolder: 'Choose a database from the list below',
                title: `Change File Database — ${profileName}`,
            });
            if (!picked) { return; }

            if (picked.dbName === '__disconnect__') {
                await connectionManager.disconnect();
                codeLensProvider.refresh();
                return;
            }

            queryRunner.setDocumentDatabase(targetUri, { profileName, dbName: picked.dbName });
            codeLensProvider.refresh();

            // Load SchemaCache for IntelliSense
            void (async () => {
                if (connectionManager.currentProfile?.name !== profileName) {
                    const p = connectionManager.getSavedProfiles().find(x => x.name === profileName);
                    if (p) { await connectionManager.connect({ ...p, database: picked.dbName }); }
                } else {
                    await connectionManager.softSwitchDatabase(picked.dbName);
                }
                const cache = schemaCacheManager.getOrCreate(profileName, picked.dbName, connectionManager);
                schemaCacheManager.active = cache;
                if (!cache.isLoaded) {
                    await cache.loadObjectNames();
                    cache.startAutoRefresh();
                }
                vscode.window.showInformationMessage(`T-SQL IntelliSense: Objects loaded (${cache.objectCount}) — ${picked.dbName}`);
            })();
        })
    );

    // Refresh schema for a DB — switch if needed, cross-DB query if same server
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.loadDatabaseSchema', async (arg: any) => {
            const profileName: string = arg instanceof DatabaseTreeItem ? (arg.profileName ?? '') : (arg?.parentProfileName ?? arg?.profileName ?? '');
            const dbName: string = arg instanceof DatabaseTreeItem ? (arg.databaseName ?? '') : (arg?.dbName ?? arg?.databaseName ?? '');
            if (!profileName || !dbName) { return; }

            const current = connectionManager.currentProfile;
            const isSameServer = current?.name === profileName;
            const isActiveDb = isSameServer && current?.database.toLowerCase() === dbName.toLowerCase();

            if (isActiveDb) {
                // Already on this DB — just refresh schema
                const dbCache = schemaCacheManager.getOrCreate(profileName, dbName, connectionManager);
                schemaCacheManager.active = dbCache;
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Refreshing schema cache...' },
                    () => dbCache.refresh()
                );
                // Only refresh this DB node — don't collapse other servers' trees
                treeProvider.fullRefresh();
            } else if (isSameServer) {
                // Same server, different DB — refresh tree
                treeProvider.fullRefresh();
            }
        })
    );

    // Tree: SELECT TOP 1000 from table
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.selectTop100', async (node: DatabaseTreeItem) => {
            if (!node?.objectName || !connectionManager.isConnected) { return; }
            const safeName = node.objectName.replace(/\]/g, ']]');
            const safeSchema = (node.schemaName ?? 'dbo').replace(/\]/g, ']]');
            await queryRunner.runQueryText(`SELECT TOP 1000 * FROM [${safeSchema}].[${safeName}]`);
        })
    );

    // Tree: New Query — from DB node (remembers which DB) or server node (asks DB with picker)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.newQueryFromTree', async (node?: DatabaseTreeItem) => {
            const profileName = node?.profileName ?? connectionManager.currentProfile?.name ?? '';
            const dbName = node?.databaseName ?? connectionManager.currentProfile?.database ?? '';

            if (node?.databaseName && node?.profileName) {
                // Opened from a Database node → bind to that DB directly
                const profile = connectionManager.getSavedProfiles().find(p => p.name === profileName);
                const projectPath = getProjectPathForNode(profile, node);
                const header = buildConnectionHeader(profileName, dbName, projectPath);
                const doc = await createSqlDocument(header + '\n\n');
                // Set association BEFORE showTextDocument so onDidChangeActiveTextEditor doesn't override it
                queryRunner.setDocumentDatabase(doc.uri, {
                    profileName,
                    dbName,
                });
                await vscode.window.showTextDocument(doc);
                codeLensProvider.refresh();
                // Refresh object names only (fast) — columns load lazily on first alias.col use
                void (async () => {
                    // Ensure ConnectionManager is connected to the right server + database
                    if (connectionManager.currentProfile?.name !== profileName) {
                        const p = connectionManager.getSavedProfiles().find(x => x.name === profileName);
                        if (p) { await connectionManager.connect({ ...p, database: dbName }); }
                    } else {
                        await connectionManager.softSwitchDatabase(dbName);
                    }
                    const dbCache = schemaCacheManager.getOrCreate(profileName, dbName, connectionManager);
                    schemaCacheManager.active = dbCache;
                    await dbCache.loadObjectNames();
                    dbCache.startAutoRefresh();
                    vscode.window.showInformationMessage(
                        `T-SQL IntelliSense: Objects loaded (${dbCache.objectCount}) — ${dbName}`
                    );
                })();
            } else if (node?.profileName) {
                // Opened from a Connection node (server level) → ask which DB
                let selectedDb = '';

                try {
                    // Use tree pool to query DB list (works even if ConnectionManager is on another server)
                    if (!treeQueryService.isConnected(node.profileName)) {
                        await treeQueryService.connect(node.profileName);
                    }
                    const dbResult = await treeQueryService.execute(
                        `SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name`,
                        undefined, node.profileName
                    );
                    const dbNames = dbResult.rows.map(r => r['name'] as string);
                    const items: vscode.QuickPickItem[] = dbNames.map(name => ({
                        label: name,
                        description: name.toLowerCase() === selectedDb.toLowerCase() ? '(current)' : '',
                    }));
                    const picked = await vscode.window.showQuickPick(items, {
                        placeHolder: 'Select database for this query',
                        title: 'New Query — Select Database',
                    });
                    if (!picked) { return; }
                    selectedDb = picked.label;
                } catch {
                    // If DB list fails, use current DB
                }

                if (!selectedDb) { return; }

                // Switch ConnectionManager to this server + DB
                const connProfile = connectionManager.getSavedProfiles().find(p => p.name === node.profileName);
                if (connProfile && connectionManager.currentProfile?.name !== node.profileName) {
                    const switchedProfile = { ...connProfile, database: selectedDb };
                    try {
                        await connectionManager.connect(switchedProfile);
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to switch to ${selectedDb}: ${err.message}`);
                        return;
                    }
                }

                const profile = connectionManager.getSavedProfiles().find(p => p.name === node.profileName);
                const projectPath = profile?.databaseProjects?.[selectedDb] ?? profile?.projectPath ?? null;
                const header = buildConnectionHeader(node.profileName, selectedDb, projectPath);
                const doc = await createSqlDocument(header + '\n\n');
                await vscode.window.showTextDocument(doc);
                queryRunner.setDocumentDatabase(doc.uri, {
                    profileName: node.profileName,
                    dbName: selectedDb,
                });
            } else {
                // Command palette — no association, runs against current DB
                const doc = await createSqlDocument();
                await vscode.window.showTextDocument(doc);
            }
        })
    );

    // Tree: Switch database (click on a different DB in the Databases folder)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.switchDatabase', async (nodeOrProfileName: any, dbName?: string) => {
            // Handle both (profileName, dbName) from tree command and (DatabaseTreeItem) from context menu
            let targetProfileName: string;
            let targetDb: string;
            if (typeof nodeOrProfileName === 'string') {
                targetProfileName = nodeOrProfileName;
                targetDb = dbName || '';
            } else if (nodeOrProfileName instanceof DatabaseTreeItem) {
                targetProfileName = nodeOrProfileName.profileName ?? '';
                targetDb = nodeOrProfileName.databaseName ?? '';
            } else {
                targetProfileName = nodeOrProfileName?.profileName;
                targetDb = nodeOrProfileName?.databaseName;
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

    // Tree management: Refresh & Filter commands
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.RefreshDatabases', (node: DatabaseTreeItem) => treeProvider.refresh(node)),
        vscode.commands.registerCommand('tsql-intellisense.FilterDatabases', async () => {
            const value = await vscode.window.showInputBox({ prompt: 'Filter databases (empty to clear)', value: treeProvider.getDatabaseFilter() });
            if (value !== undefined) { treeProvider.setDatabaseFilter(value); treeProvider.fullRefresh(); }
        }),
        vscode.commands.registerCommand('tsql-intellisense.RefreshDatabase', (node: DatabaseTreeItem) => treeProvider.refresh(node)),
        vscode.commands.registerCommand('tsql-intellisense.RefreshFolder', (node: DatabaseTreeItem) => treeProvider.refresh(node)),
        vscode.commands.registerCommand('tsql-intellisense.FilterFolder', async (node: DatabaseTreeItem) => {
            const value = await vscode.window.showInputBox({ prompt: 'Filter items (empty to clear)', value: treeProvider.getFolderFilter(node) });
            if (value !== undefined) { treeProvider.setFolderFilter(node, value); treeProvider.refresh(node); }
        }),
    );

    // New* commands — open SQL editor with DDL template
    const newObjectTemplates: [string, string][] = [
        ['tsql-intellisense.NewDatabase', 'CREATE DATABASE [NewDatabase];\nGO'],
        ['tsql-intellisense.NewSchema', 'CREATE SCHEMA [NewSchema];\nGO'],
        ['tsql-intellisense.NewTable', 'CREATE TABLE [{schema}].[NewTable]\n(\n    [Id] INT NOT NULL PRIMARY KEY,\n    [Column1] NVARCHAR(50) NULL\n);\nGO'],
        ['tsql-intellisense.NewView', 'CREATE VIEW [{schema}].[NewView]\nAS\n    SELECT 1 AS [Column1];\nGO'],
        ['tsql-intellisense.NewScalarFunction', 'CREATE FUNCTION [{schema}].[NewFunction]\n(\n    @Param1 INT\n)\nRETURNS INT\nAS\nBEGIN\n    RETURN @Param1;\nEND;\nGO'],
        ['tsql-intellisense.NewTableValuedFunction', 'CREATE FUNCTION [{schema}].[NewFunction]\n(\n    @Param1 INT\n)\nRETURNS TABLE\nAS\nRETURN\n(\n    SELECT @Param1 AS [Column1]\n);\nGO'],
        ['tsql-intellisense.NewProcedure', 'CREATE PROCEDURE [{schema}].[NewProcedure]\n    @Param1 INT\nAS\nBEGIN\n    SET NOCOUNT ON;\n    SELECT @Param1;\nEND;\nGO'],
        ['tsql-intellisense.NewTrigger', 'CREATE TRIGGER [{schema}].[NewTrigger]\nON [{schema}].[TableName]\nAFTER INSERT\nAS\nBEGIN\n    SET NOCOUNT ON;\nEND;\nGO'],
    ];

    for (const [cmdId, template] of newObjectTemplates) {
        context.subscriptions.push(
            vscode.commands.registerCommand(cmdId, async (node?: DatabaseTreeItem) => {
                const schema = node?.schemaName ?? 'dbo';
                const content = template.replace(/\{schema\}/g, schema);
                const profileName = node?.profileName ?? connectionManager.currentProfile?.name ?? '';
                const dbNameForNew = node?.databaseName ?? connectionManager.currentProfile?.database ?? '';
                const profile = connectionManager.getSavedProfiles().find(p => p.name === profileName);
                const projectPath = getProjectPathForNode(profile, node ? node : undefined);
                const header = buildConnectionHeader(profileName, dbNameForNew, projectPath);
                const doc = await vscode.workspace.openTextDocument({ content: header + '\n\n' + content, language: 'sql' });
                await vscode.window.showTextDocument(doc, { preview: false });
            })
        );
    }

    // Backup / Restore database scripts
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.backupDatabase', async (node?: DatabaseTreeItem) => {
            const dbName = node?.databaseName ?? connectionManager.currentProfile?.database ?? 'MyDatabase';
            const profileName = node?.profileName ?? connectionManager.currentProfile?.name ?? '';
            const profile = connectionManager.getSavedProfiles().find(p => p.name === profileName);
            const projectPath = getProjectPathForNode(profile, node);
            const header = buildConnectionHeader(profileName, dbName, projectPath);
            const script = [
                `-- Backup Database: ${dbName}`,
                `BACKUP DATABASE [${dbName}]`,
                `TO DISK = N'C:\\Backup\\${dbName}_\${YYYY}\${MM}\${DD}.bak'`,
                `WITH FORMAT,`,
                `     MEDIANAME = '${dbName}_Backup',`,
                `     NAME = '${dbName} Full Backup',`,
                `     COMPRESSION,`,
                `     STATS = 10;`,
                `GO`,
                ``,
                `-- Backup with COPY_ONLY (does not affect backup chain)`,
                `-- BACKUP DATABASE [${dbName}]`,
                `-- TO DISK = N'C:\\Backup\\${dbName}_CopyOnly.bak'`,
                `-- WITH COPY_ONLY, FORMAT, COMPRESSION, STATS = 10;`,
                `-- GO`,
                ``,
                `-- Backup Transaction Log`,
                `-- BACKUP LOG [${dbName}]`,
                `-- TO DISK = N'C:\\Backup\\${dbName}_Log.trn'`,
                `-- WITH FORMAT, STATS = 10;`,
                `-- GO`,
            ].join('\n');
            const doc = await vscode.workspace.openTextDocument({ content: header + '\n\n' + script, language: 'sql' });
            await vscode.window.showTextDocument(doc, { preview: false });
        }),
        vscode.commands.registerCommand('tsql-intellisense.restoreDatabase', async (node?: DatabaseTreeItem) => {
            const dbName = node?.databaseName ?? connectionManager.currentProfile?.database ?? 'MyDatabase';
            const profileName = node?.profileName ?? connectionManager.currentProfile?.name ?? '';
            const profile = connectionManager.getSavedProfiles().find(p => p.name === profileName);
            const projectPath = getProjectPathForNode(profile, node);
            const header = buildConnectionHeader(profileName, dbName, projectPath);
            const script = [
                `-- Restore Database: ${dbName}`,
                `USE [master];`,
                `GO`,
                ``,
                `-- Set database to single user mode (disconnect all users)`,
                `ALTER DATABASE [${dbName}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;`,
                `GO`,
                ``,
                `RESTORE DATABASE [${dbName}]`,
                `FROM DISK = N'C:\\Backup\\${dbName}.bak'`,
                `WITH REPLACE,`,
                `     STATS = 10;`,
                `GO`,
                ``,
                `-- Return to multi-user mode`,
                `ALTER DATABASE [${dbName}] SET MULTI_USER;`,
                `GO`,
                ``,
                `-- Restore with MOVE (change file locations)`,
                `-- RESTORE DATABASE [${dbName}]`,
                `-- FROM DISK = N'C:\\Backup\\${dbName}.bak'`,
                `-- WITH REPLACE,`,
                `--      MOVE N'${dbName}' TO N'C:\\Data\\${dbName}.mdf',`,
                `--      MOVE N'${dbName}_log' TO N'C:\\Data\\${dbName}_log.ldf',`,
                `--      STATS = 10;`,
                `-- GO`,
                ``,
                `-- Restore with NORECOVERY (for log restore chain)`,
                `-- RESTORE DATABASE [${dbName}]`,
                `-- FROM DISK = N'C:\\Backup\\${dbName}.bak'`,
                `-- WITH NORECOVERY, REPLACE, STATS = 10;`,
                `-- GO`,
                `-- RESTORE LOG [${dbName}]`,
                `-- FROM DISK = N'C:\\Backup\\${dbName}_Log.trn'`,
                `-- WITH RECOVERY;`,
                `-- GO`,
            ].join('\n');
            const doc = await vscode.workspace.openTextDocument({ content: header + '\n\n' + script, language: 'sql' });
            await vscode.window.showTextDocument(doc, { preview: false });
        })
    );

    // Script As commands — generate DDL/DML scripts for tree objects
    const scriptActions: [string, ScriptAction][] = [
        ['tsql-intellisense.Script.Create', 'Create'],
        ['tsql-intellisense.Script.Alter', 'Alter'],
        ['tsql-intellisense.Script.CreateOrAlter', 'CreateOrAlter'],
        ['tsql-intellisense.Script.Drop', 'Drop'],
        ['tsql-intellisense.Script.DropAndCreate', 'DropAndCreate'],
        ['tsql-intellisense.Script.Select', 'Select'],
        ['tsql-intellisense.Script.Insert', 'Insert'],
        ['tsql-intellisense.Script.Update', 'Update'],
        ['tsql-intellisense.Script.Delete', 'Delete'],
        ['tsql-intellisense.Script.Execute', 'Execute'],
    ];

    for (const [commandId, action] of scriptActions) {
        context.subscriptions.push(
            vscode.commands.registerCommand(commandId, async (node: DatabaseTreeItem) => {
                if (!node) { return; }
                try {
                    const generator = new ScriptGenerator(treeQueryService);
                    const script = await generator.generate(node, action);
                    // Build connection header
                    const profile = connectionManager.getSavedProfiles().find(p => p.name === node.profileName);
                    const projectPath = getProjectPathForNode(profile, node);
                    const header = buildConnectionHeader(
                        node.profileName ?? '',
                        node.databaseName ?? '',
                        projectPath
                    );
                    const doc = await vscode.workspace.openTextDocument({
                        content: header + '\n\n' + script,
                        language: 'sql'
                    });
                    await vscode.window.showTextDocument(doc, { preview: false });
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Script generation failed: ${err.message}`);
                }
            })
        );
    }

    // Select in Object Explorer (editor right-click)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.selectInObjectExplorer', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active, /[\w]+/);
            if (!wordRange) { return; }
            const word = editor.document.getText(wordRange);

            const obj = schemaCacheManager.active?.findObject(word);
            if (!obj) {
                vscode.window.showWarningMessage(`"${word}" not found in schema cache`);
                return;
            }

            const profile = connectionManager.currentProfile;
            if (!profile) {
                vscode.window.showWarningMessage('Not connected to a database');
                return;
            }

            // Try to find and reveal the node in the tree
            vscode.window.showInformationMessage(`Found "${word}" (${obj.type}) in schema cache`);
        })
    );

    // Open project file (tree context menu OR editor Ctrl+F11)
    context.subscriptions.push(
        vscode.commands.registerCommand('tsql-intellisense.openProjectFile', async (nodeOrUri?: DatabaseTreeItem | vscode.Uri) => {
            const profile = connectionManager.currentProfile;
            if (!profile) {
                vscode.window.showWarningMessage('Open Project File: Not connected');
                return;
            }

            type ObjectType = 'table' | 'view' | 'sp' | 'func';

            // Called from editor (Ctrl+F11): resolve object from cursor word
            let objectName: string;
            let objectType: ObjectType;
            let nodeDbName: string | undefined;
            let nodeProjectPath: string | undefined;

            if (nodeOrUri instanceof DatabaseTreeItem) {
                objectName = nodeOrUri.objectName ?? '';
                const nodeTypeMap: Record<string, ObjectType> = {
                    [NodeType.Table]: 'table', [NodeType.View]: 'view',
                    [NodeType.Procedure]: 'sp', [NodeType.Function]: 'func',
                };
                objectType = nodeTypeMap[nodeOrUri.nodeType] ?? 'sp';
                nodeDbName = nodeOrUri.databaseName;
                nodeProjectPath = nodeOrUri.projectPath;
            } else {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showWarningMessage('Open Project File: No active editor');
                    return;
                }
                let word: string | undefined;
                if (!editor.selection.isEmpty) {
                    word = editor.document.getText(editor.selection).trim();
                } else {
                    const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active, /[a-zA-Z0-9_\u00C0-\u024F\u0100-\u017F]+/);
                    if (wordRange) {
                        word = editor.document.getText(wordRange);
                    }
                }
                if (!word) {
                    vscode.window.showWarningMessage('Open Project File: No word at cursor. Place cursor on an object name or select it.');
                    return;
                }
                const obj = schemaCacheManager.active?.findObject(word);
                if (obj) {
                    const typeMap: Record<string, ObjectType> = { TABLE: 'table', VIEW: 'view', PROCEDURE: 'sp', FUNCTION: 'func' };
                    objectName = obj.name;
                    objectType = typeMap[obj.type] ?? 'sp';
                } else {
                    objectName = word;
                    objectType = 'sp';
                }
            }

            const dbName = nodeDbName ?? profile.database;
            const projectPath = nodeProjectPath
                ?? profile.databaseProjects?.[dbName]
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

            const searchPaths = [
                `${projectPath}/dbo/${subFolder}/${objectName}.sql`,
                `${projectPath}/${subFolder}/${objectName}.sql`,
            ];
            if (!schemaCacheManager.active?.findObject(objectName)) {
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

    // When connection changes: update icons, refresh tree
    connectionManager.onConnectionChanged(async (profile) => {
        treeProvider.fullRefresh();
        codeLensProvider.refresh();
        vscode.commands.executeCommand('setContext', 'tsqlIntellisense.connected', !!profile);
        if (profile) {
            context.globalState.update('lastConnectionName', profile.name);
            // Only set document association if the document has NO existing association
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'sql') {
                const existing = queryRunner.getDocumentDatabase(editor.document.uri);
                if (!existing) {
                    queryRunner.setDocumentDatabase(editor.document.uri, {
                        profileName: profile.name,
                        dbName: profile.database,
                    });
                }
            }
        } else {
            schemaCacheManager.active?.stopAutoRefresh();
        }
    });

    // Disposables
    // Tab switch handler — parse connection header and set active cache
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            if (!editor || editor.document.languageId !== 'sql') { return; }
            const firstLine = editor.document.lineAt(0).text;
            const header = parseConnectionHeader(firstLine);
            if (!header) { return; }

            const cache = schemaCacheManager.getOrCreate(header.profileName, header.database, connectionManager);
            schemaCacheManager.active = cache;

            if (!cache.isLoaded) {
                const profile = connectionManager.getSavedProfiles().find(p => p.name === header.profileName);
                if (profile) {
                    if (connectionManager.currentProfile?.name !== header.profileName) {
                        await connectionManager.connect({ ...profile, database: header.database });
                    } else {
                        await connectionManager.softSwitchDatabase(header.database);
                    }
                    await cache.loadObjectNames();
                }
            }
        })
    );

    context.subscriptions.push({
        dispose: () => {
            connectionManager.dispose();
            schemaCacheManager.dispose();
            queryRunner.dispose();
            treeProvider.dispose();
        }
    });

    console.log('T-SQL IntelliSense activated');
}

function getProjectPathForNode(profile: ConnectionProfile | undefined, node: DatabaseTreeItem | undefined): string | null {
    if (!profile || !node?.databaseName) { return null; }
    if (profile.databaseProjects) {
        const p = profile.databaseProjects[node.databaseName] || profile.databaseProjects[node.databaseName.toLowerCase()];
        if (p) { return p; }
    }
    if (profile.projectPath && profile.database.toLowerCase() === (node.databaseName || '').toLowerCase()) {
        return profile.projectPath;
    }
    return null;
}

export function deactivate() {
    connectionManager?.dispose();
    schemaCacheManager?.dispose();
}
