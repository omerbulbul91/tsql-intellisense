import * as vscode from 'vscode';
import { ConnectionManager, BatchResult, QueryResult, SqlMessage } from '../connection/connectionManager';
import { createGridRenderer } from './grids/gridRenderer';
import { MessagePanel } from './messagePanel';
import { ts } from '../utils/timestamp';

export class QueryRunner implements vscode.WebviewViewProvider {
    private webviewView: vscode.WebviewView | null = null;
    private lastResult: BatchResult | null = null;
    private lastMeta: { startTime: Date; startLine: number } | null = null;
    /** Per-document query results — keyed by document URI string */
    private documentResults = new Map<string, BatchResult>();
    /** Per-document query metadata — keyed by document URI string */
    private documentMeta = new Map<string, { startTime: Date; startLine: number }>();
    private _onQueryExecuted = new vscode.EventEmitter<{ sql: string; result: BatchResult }>();
    public readonly onQueryExecuted = this._onQueryExecuted.event;
    private messagePanel: MessagePanel | null = null;

    /** Tracks which database each document belongs to (URI → {profileName, dbName}) */
    private documentDbMap = new Map<string, { profileName: string; dbName: string } | null>();

    constructor(private connectionManager: ConnectionManager, private extensionUri?: vscode.Uri) {
        // Switch query results when active editor changes
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (!editor || !this.webviewView) { return; }
            const key = editor.document.uri.toString();
            const result = this.documentResults.get(key);
            if (result) {
                this.webviewView.webview.html = this.buildHtml(result);
            } else {
                this.webviewView.webview.html = this.buildEmptyHtml();
            }
        });
    }

    /** Set the message panel to send messages to */
    setMessagePanel(panel: MessagePanel): void {
        this.messagePanel = panel;
    }

    /** Get the query metadata for a document */
    getQueryMeta(uri?: vscode.Uri): { startTime: Date; startLine: number } | undefined {
        if (uri) { return this.documentMeta.get(uri.toString()); }
        return this.lastMeta || undefined;
    }

    /** Associate a document with a specific database (or null for server-level) */
    setDocumentDatabase(uri: vscode.Uri, info: { profileName: string; dbName: string } | null): void {
        this.documentDbMap.set(uri.toString(), info);
    }

    /** Get the database association for a document */
    getDocumentDatabase(uri: vscode.Uri): { profileName: string; dbName: string } | null | undefined {
        return this.documentDbMap.get(uri.toString());
    }

    /** Called by VS Code when the panel view becomes visible */
    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.webviewView = webviewView;

        const localRoots: vscode.Uri[] = [];
        if (this.extensionUri) {
            // Allow all grid libraries' assets
            localRoots.push(vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'tabulator-tables'));
            localRoots.push(vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'ag-grid-community'));
            localRoots.push(vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'handsontable'));
        }
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: localRoots.length > 0 ? localRoots : undefined,
        };

        // Handle messages from webview
        webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg.type === 'openInExcel') {
                this.openInExcel(msg.data);
            }
        });

        // Show last result if available
        if (this.lastResult) {
            webviewView.webview.html = this.buildHtml(this.lastResult);
        } else {
            webviewView.webview.html = this.buildEmptyHtml();
        }
    }

    /** Run the current query (selected text or full file) */
    async runQuery(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor');
            return;
        }

        // Check document database association
        const docDb = this.documentDbMap.get(editor.document.uri.toString());

        if (!this.connectionManager.isConnected) {
            // Try to connect using file's association
            if (docDb) {
                const profile = this.connectionManager.getSavedProfiles().find(p => p.name === docDb.profileName);
                if (profile) {
                    try {
                        await this.connectionManager.connect({ ...profile, database: docDb.dbName });
                    } catch {
                        const action = await vscode.window.showWarningMessage(
                            'T-SQL IntelliSense: Not connected to a database', 'Connect');
                        if (action === 'Connect') { await this.connectionManager.promptConnect(); }
                        return;
                    }
                }
            } else {
                const action = await vscode.window.showWarningMessage(
                    'T-SQL IntelliSense: Not connected to a database', 'Connect');
                if (action === 'Connect') { await this.connectionManager.promptConnect(); }
                return;
            }
        }

        // Ensure we're on the correct server + database for this file
        if (docDb) {
            if (this.connectionManager.currentProfile?.name !== docDb.profileName) {
                const profile = this.connectionManager.getSavedProfiles().find(p => p.name === docDb.profileName);
                if (profile) {
                    await this.connectionManager.connect({ ...profile, database: docDb.dbName });
                }
            } else if (this.connectionManager.currentProfile?.database?.toLowerCase() !== docDb.dbName.toLowerCase()) {
                await this.connectionManager.softSwitchDatabase(docDb.dbName);
            }
        }

        // docDb === null means server-level query → ask which DB
        if (docDb === null) {
            const picked = await this.promptSelectDatabase();
            if (!picked) { return; }
        }

        // Get selected text or full document
        const selection = editor.selection;
        const sql = selection.isEmpty
            ? editor.document.getText()
            : editor.document.getText(selection);

        if (!sql.trim()) {
            vscode.window.showWarningMessage('No SQL to execute');
            return;
        }

        // Capture query metadata for SSMS-style messages
        const startLine = selection.isEmpty ? 1 : selection.start.line + 1;
        const meta = { startTime: new Date(), startLine };
        this.lastMeta = meta;
        this.documentMeta.set(editor.document.uri.toString(), meta);

        const preview = sql.replace(/\s+/g, ' ').trim().substring(0, 200);
        this.connectionManager.log.appendLine(`[${ts()}] Query (F5): ${preview}`);

        // Show progress — retry once on connection failure
        let result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Executing query...',
                cancellable: true,
            },
            async (_progress, token) => {
                token.onCancellationRequested(() => {
                    this.connectionManager.cancelQuery();
                });
                try {
                    return await this.connectionManager.executeBatch(sql);
                } catch (err: any) {
                    // Connection may have dropped — reconnect and retry
                    const docDb2 = this.documentDbMap.get(editor.document.uri.toString());
                    if (docDb2) {
                        const profile = this.connectionManager.getSavedProfiles().find(p => p.name === docDb2.profileName);
                        if (profile) {
                            await this.connectionManager.connect({ ...profile, database: docDb2.dbName });
                            return await this.connectionManager.executeBatch(sql);
                        }
                    }
                    throw err;
                }
            }
        );

        this.lastResult = result;
        this.documentResults.set(editor.document.uri.toString(), result);
        this.showResults(result);
        if (!result.error) {
            this._onQueryExecuted.fire({ sql, result });
        }
    }

    /** Prompt user to select a database from the server's database list */
    private async promptSelectDatabase(): Promise<boolean> {
        if (!this.connectionManager.isConnected) { return false; }

        try {
            const result = await this.connectionManager.executeQuery(
                `SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name`
            );
            const dbNames = result.rows.map(r => r['name'] as string);

            const picked = await vscode.window.showQuickPick(dbNames, {
                placeHolder: 'Select database to run query against',
            });

            if (!picked) { return false; }

            const currentProfile = this.connectionManager.currentProfile;
            if (currentProfile && currentProfile.database.toLowerCase() !== picked.toLowerCase()) {
                const switchedProfile = { ...currentProfile, database: picked };
                await this.connectionManager.connect(switchedProfile);
            }

            // Associate this document with the chosen DB
            const editor = vscode.window.activeTextEditor;
            if (editor && currentProfile) {
                this.setDocumentDatabase(editor.document.uri, { profileName: currentProfile.name, dbName: picked });
            }

            return true;
        } catch {
            return true; // proceed with current DB on error
        }
    }

    /** Run a specific SQL text (for query shortcuts) */
    async runQueryText(sql: string): Promise<void> {
        if (!this.connectionManager.isConnected) {
            const action = await vscode.window.showWarningMessage(
                'T-SQL IntelliSense: Not connected to a database',
                'Connect'
            );
            if (action === 'Connect') {
                await this.connectionManager.promptConnect();
            }
            return;
        }

        if (!sql.trim()) { return; }

        const editor = vscode.window.activeTextEditor;
        const startLine = editor ? (editor.selection.isEmpty ? 1 : editor.selection.start.line + 1) : 1;
        const meta = { startTime: new Date(), startLine };
        this.lastMeta = meta;
        if (editor) { this.documentMeta.set(editor.document.uri.toString(), meta); }

        const result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Executing query...',
                cancellable: true,
            },
            (_progress, token) => {
                token.onCancellationRequested(() => {
                    this.connectionManager.cancelQuery();
                });
                return this.connectionManager.executeBatch(sql);
            }
        );

        this.lastResult = result;
        if (editor) { this.documentResults.set(editor.document.uri.toString(), result); }
        this.showResults(result);
        if (!result.error) {
            this._onQueryExecuted.fire({ sql, result });
        }
    }

    /** Display results in the bottom panel */
    private showResults(result: BatchResult): void {
        if (this.webviewView) {
            this.webviewView.webview.html = this.buildHtml(result);
        }

        // Send messages to the separate messages panel
        if (this.messagePanel) {
            this.messagePanel.showMessages(result, this.lastMeta || undefined);
        }

        // Focus: error → Messages panel, success → Results panel
        if (result.error) {
            vscode.commands.executeCommand('tsqlMessages.focus');
        } else {
            vscode.commands.executeCommand('tsqlResults.focus');
        }
    }

    private buildEmptyHtml(): string {
        return `<!DOCTYPE html>
<html><head><style>
    body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-descriptionForeground);
        display: flex; align-items: center; justify-content: center;
        height: 100vh; margin: 0;
    }
</style></head>
<body>Run a query (F5) to see results here</body></html>`;
    }

    private buildHtml(result: BatchResult): string {
        if (!this.webviewView || !this.extensionUri) { return this.buildEmptyHtml(); }

        const config = vscode.workspace.getConfiguration('tsql-intellisense');
        const displayMode = config.get<string>('resultDisplayMode', 'tabs');
        const gridLibrary = config.get<string>('gridLibrary', 'tabulator');
        const isStacked = displayMode === 'stacked' && result.resultSets.length > 1;

        const renderer = createGridRenderer(gridLibrary);
        const grid = renderer.render(
            this.webviewView.webview,
            this.extensionUri,
            result.resultSets.map(rs => ({ columns: rs.columns, rows: rs.rows })),
            isStacked,
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${grid.headHtml}
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
        height: 100%;
        overflow: hidden;
        font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
        font-size: var(--vscode-font-size, 13px);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        display: flex;
        flex-direction: column;
    }
    /* ── Toolbar ─────────────────────────────────── */
    .toolbar {
        display: flex; align-items: center; gap: 6px; padding: 3px 8px;
        background: var(--vscode-editorWidget-background);
        border-bottom: 1px solid var(--vscode-editorWidget-border);
        flex-shrink: 0;
    }
    .toolbar label { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
    .toolbar input[type="text"] {
        flex: 1; padding: 2px 6px; font-size: 11px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 2px; outline: none;
    }
    .toolbar input[type="text"]:focus { border-color: var(--vscode-focusBorder); }
    .toolbar input[type="text"]::placeholder { color: var(--vscode-input-placeholderForeground); }
    .toolbar button {
        padding: 2px 8px; font-size: 11px; cursor: pointer;
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: none; border-radius: 2px; white-space: nowrap;
    }
    .toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    /* ── Column Chooser Popup ────────────────────── */
    .col-chooser {
        position: fixed; z-index: 1000;
        background: var(--vscode-menu-background, #252526);
        border: 1px solid var(--vscode-menu-border, #454545);
        border-radius: 4px; padding: 6px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
        max-height: 300px; overflow-y: auto; min-width: 180px;
    }
    .col-chooser label {
        display: flex; align-items: center; gap: 6px; padding: 2px 4px;
        font-size: 11px; cursor: pointer;
        color: var(--vscode-menu-foreground, #ccc);
    }
    .col-chooser label:hover { background: var(--vscode-menu-selectionBackground, #094771); border-radius: 2px; }
    .col-chooser .col-chooser-actions {
        display: flex; gap: 4px; padding: 4px 0 2px; border-top: 1px solid var(--vscode-menu-separatorBackground, #454545);
        margin-top: 4px;
    }
    .col-chooser .col-chooser-actions button { flex: 1; font-size: 10px; padding: 2px 4px; }
    /* ── Tabs (multi result set) ────────────────────── */
    .tabs {
        display: flex;
        background: var(--vscode-editorWidget-background);
        border-bottom: 1px solid var(--vscode-editorWidget-border);
        flex-shrink: 0;
    }
    .tab {
        padding: 4px 12px; font-size: 11px; cursor: pointer;
        border-bottom: 2px solid transparent;
        color: var(--vscode-descriptionForeground);
    }
    .tab.active {
        color: var(--vscode-foreground);
        border-bottom-color: var(--vscode-focusBorder);
    }
    /* ── Grid containers ─────────────────────────── */
    .grid-wrapper { flex: 1; overflow: hidden; }
    .grid-container { width: 100%; height: 100%; overflow: auto; }
    .stacked-wrapper { flex: 1; overflow: auto; display: flex; flex-direction: column; }
    .stacked-section { flex: 1; min-height: 100px; display: flex; flex-direction: column; overflow: hidden; }
    .stacked-header {
        display: flex; align-items: center; gap: 6px;
        padding: 2px 8px; font-size: 11px;
        background: var(--vscode-editorWidget-background);
        border-bottom: 1px solid var(--vscode-editorWidget-border);
        color: var(--vscode-foreground); flex-shrink: 0;
    }
    .stacked-header .sh-title { font-weight: bold; white-space: nowrap; }
    .stacked-header input[type="text"] {
        flex: 1; max-width: 180px; padding: 1px 5px; font-size: 10px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 2px; outline: none;
    }
    .stacked-header input[type="text"]:focus { border-color: var(--vscode-focusBorder); }
    .stacked-header input[type="text"]::placeholder { color: var(--vscode-input-placeholderForeground); }
    .stacked-header button {
        padding: 1px 6px; font-size: 10px; cursor: pointer;
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: none; border-radius: 2px; white-space: nowrap;
    }
    .stacked-header button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .stacked-grid { width: 100%; flex: 1; overflow: auto; }
    /* ── Splitter ────────────────────────────────── */
    .stacked-splitter {
        height: 3px; cursor: row-resize; flex-shrink: 0;
        background: var(--vscode-focusBorder);
        opacity: 0.4; transition: opacity 0.15s;
    }
    .stacked-splitter:hover, .stacked-splitter.active {
        opacity: 1;
    }
    /* ── Status bar ───────────────────────────────── */
    .status-bar {
        padding: 2px 8px; font-size: 11px;
        color: var(--vscode-descriptionForeground);
        background: var(--vscode-editorWidget-background);
        border-bottom: 1px solid var(--vscode-editorWidget-border);
        flex-shrink: 0;
    }
    .error-bar {
        color: var(--vscode-errorForeground);
        background: var(--vscode-inputValidation-errorBackground);
        padding: 4px 8px; border-left: 3px solid var(--vscode-inputValidation-errorBorder);
        font-size: 11px; flex-shrink: 0;
    }
    /* ── Context menu (common) ───────────────────── */
    .grid-context-menu {
        position: fixed; z-index: 2000;
        background: rgba(43, 43, 43, 0.95);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 8px;
        padding: 4px;
        min-width: 220px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 1px 3px rgba(0, 0, 0, 0.3);
    }
    .grid-context-menu .ctx-item {
        padding: 5px 12px;
        font-size: 12.5px;
        color: #e0e0e0;
        display: flex;
        justify-content: space-between;
        align-items: center;
        cursor: pointer;
        border-radius: 5px;
        margin: 1px 0;
    }
    .grid-context-menu .ctx-item:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
    }
    .grid-context-menu .ctx-sep {
        height: 1px;
        background: rgba(255, 255, 255, 0.08);
        margin: 4px 8px;
    }
    ${grid.themeStyles}
</style>
</head>
<body>
    ${result.error ? `<div class="error-bar">${this.formatErrorBar(result)}</div>` : ''}
    ${result.resultSets.length > 0 && !isStacked ? `
    <div class="toolbar">
        <label>Filter:</label>
        <input type="text" id="quickFilter" placeholder="Filter any column..." oninput="onQuickFilter(this.value)">
        <button onclick="toggleColumnChooser(event)">Columns</button>
        <button onclick="exportCsv()">CSV</button>
    </div>
    ` : ''}
    ${!isStacked && result.resultSets.length > 1 ? `
        <div class="tabs">
            ${result.resultSets.map((_, i) => `
                <div class="tab ${i === 0 ? 'active' : ''}" onclick="switchTab(${i})">
                    Result ${i + 1}
                </div>
            `).join('')}
        </div>
    ` : ''}
    <div class="status-bar">${result.resultSets.reduce((sum, rs) => sum + rs.rows.length, 0)} rows | ${(result.elapsed / 1000).toFixed(3)}s</div>
    ${isStacked ? `
        <div class="stacked-wrapper">
            ${result.resultSets.map((rs, i) => `
                ${i > 0 ? '<div class="stacked-splitter" data-index="' + i + '"></div>' : ''}
                <div class="stacked-section">
                    <div class="stacked-header">
                        <span class="sh-title">Result ${i + 1} (${rs.rows.length} rows)</span>
                        <input type="text" placeholder="Filter..." oninput="onStackedFilter(${i}, this.value)">
                        <button onclick="toggleStackedColumnChooser(event, ${i})">Columns</button>
                        <button onclick="exportStackedCsv(${i})">CSV</button>
                    </div>
                    <div id="grid-${i}" class="stacked-grid"></div>
                </div>
            `).join('')}
        </div>
    ` : `
        ${result.resultSets.map((_, i) => `
            <div class="grid-wrapper" id="tab-${i}" style="${i > 0 ? 'display:none' : ''}">
                <div id="grid-${i}" class="grid-container"></div>
            </div>
        `).join('')}
    `}
<script>const vscodeApi = acquireVsCodeApi();</script>
<script>
console.log('[TSQL] Grid init starting...');
console.log('[TSQL] grid-0 exists:', !!document.getElementById('grid-0'));
</script>
${grid.initScript}
<script>
console.log('[TSQL] Grid init completed, gridApi:', typeof window.gridApi);
</script>
<script>
    const isStacked = ${isStacked};

    // ── Common: Keyboard shortcuts ──────────────────
    document.addEventListener('keydown', (e) => {
        const idx = Math.max(0, typeof currentTab !== 'undefined' ? currentTab : 0);
        if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !e.shiftKey) {
            e.preventDefault();
            if (gridApi && gridApi.copy) gridApi.copy(idx, false);
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'C') {
            e.preventDefault();
            if (gridApi && gridApi.copy) gridApi.copy(idx, true);
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
            e.preventDefault();
            if (gridApi && gridApi.selectAllRows) gridApi.selectAllRows(idx);
        }
    });

    // ── Common: Quick Filter ────────────────────────
    function onQuickFilter(value) {
        if (!gridApi) return;
        const count = gridApi.getTableCount ? gridApi.getTableCount() : 0;
        for (let i = 0; i < count; i++) {
            gridApi.setQuickFilter(i, value);
        }
    }

    // ── Common: Column Chooser ──────────────────────
    let chooserEl = null;
    function toggleColumnChooser(event) {
        if (chooserEl) { chooserEl.remove(); chooserEl = null; return; }
        if (!gridApi) return;
        const idx = Math.max(0, typeof currentTab !== 'undefined' ? currentTab : 0);
        buildChooserPopup(event, idx);
    }
    function toggleStackedColumnChooser(event, idx) {
        if (chooserEl) { chooserEl.remove(); chooserEl = null; return; }
        if (!gridApi) return;
        buildChooserPopup(event, idx);
    }
    function buildChooserPopup(event, idx) {
        const cols = gridApi.getColumns ? gridApi.getColumns(idx) : [];
        if (cols.length === 0) return;
        chooserEl = document.createElement('div');
        chooserEl.className = 'col-chooser';
        cols.forEach(col => {
            const field = col.field || col;
            const title = col.title || col.field || col;
            const lbl = document.createElement('label');
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = gridApi.isColumnVisible ? gridApi.isColumnVisible(idx, field) : true;
            cb.onchange = () => { if (gridApi.toggleColumnVisibility) gridApi.toggleColumnVisibility(idx, field); };
            lbl.appendChild(cb);
            lbl.appendChild(document.createTextNode(title));
            chooserEl.appendChild(lbl);
        });
        const actions = document.createElement('div');
        actions.className = 'col-chooser-actions';
        const showAll = document.createElement('button');
        showAll.textContent = 'Show All';
        showAll.onclick = () => { if (gridApi.showAllColumns) gridApi.showAllColumns(idx); chooserEl.querySelectorAll('input').forEach(cb => cb.checked = true); };
        const hideAll = document.createElement('button');
        hideAll.textContent = 'Hide All';
        hideAll.onclick = () => { if (gridApi.hideAllColumns) gridApi.hideAllColumns(idx); chooserEl.querySelectorAll('input').forEach(cb => cb.checked = false); };
        actions.appendChild(showAll);
        actions.appendChild(hideAll);
        chooserEl.appendChild(actions);
        const btn = event.target;
        const rect = btn.getBoundingClientRect();
        chooserEl.style.top = rect.bottom + 2 + 'px';
        chooserEl.style.right = (window.innerWidth - rect.right) + 'px';
        document.body.appendChild(chooserEl);
    }
    document.addEventListener('click', (e) => {
        if (chooserEl && !chooserEl.contains(e.target) && !e.target.closest('.toolbar button') && !e.target.closest('.stacked-header button')) {
            chooserEl.remove(); chooserEl = null;
        }
    });

    // ── Common: CSV Export ───────────────────────────
    function exportCsv() {
        const idx = Math.max(0, typeof currentTab !== 'undefined' ? currentTab : 0);
        if (gridApi && gridApi.exportCsv) gridApi.exportCsv(idx, 'query_results.csv');
    }
    function exportStackedCsv(idx) {
        if (gridApi && gridApi.exportCsv) gridApi.exportCsv(idx, 'query_results_' + (idx + 1) + '.csv');
    }

    // ── Common: Stacked filter ──────────────────────
    function onStackedFilter(idx, value) {
        if (gridApi && gridApi.setQuickFilter) gridApi.setQuickFilter(idx, value);
    }

    // ── Common: Context menu ────────────────────────
    function showContextMenu(e, idx) {
        e.preventDefault();
        // Remove any existing menu
        const old = document.querySelector('.grid-context-menu');
        if (old) old.remove();

        const menu = document.createElement('div');
        menu.className = 'grid-context-menu';
        const items = [
            { label: 'Copy', shortcut: 'Ctrl+C', action: () => gridApi.copy(idx, false) },
            { label: 'Copy with Headers', shortcut: 'Ctrl+Shift+C', action: () => gridApi.copy(idx, true) },
            { label: 'Select All', shortcut: 'Ctrl+A', action: () => gridApi.selectAllRows(idx) },
            { sep: true },
            { label: 'Script as INSERT', action: () => gridApi.scriptAsInsert(idx) },
            { label: 'Copy as IN clause', action: () => gridApi.copyAsInClause(idx) },
            { label: 'Open in Excel', action: () => gridApi.openInExcel(idx) },
        ];
        items.forEach(item => {
            if (item.sep) {
                const sep = document.createElement('div');
                sep.className = 'ctx-sep';
                menu.appendChild(sep);
                return;
            }
            const el = document.createElement('div');
            el.className = 'ctx-item';
            el.innerHTML = item.shortcut
                ? item.label + "<span style='opacity:0.6;margin-left:24px'>" + item.shortcut + "</span>"
                : item.label;
            el.onclick = () => { menu.remove(); if (item.action) item.action(); };
            menu.appendChild(el);
        });
        menu.style.left = e.clientX + 'px';
        menu.style.top = e.clientY + 'px';
        document.body.appendChild(menu);
        // Close on outside click
        setTimeout(() => {
            document.addEventListener('click', function handler() {
                menu.remove();
                document.removeEventListener('click', handler);
            });
        }, 0);
    }

    // ── Common: Splitter drag ───────────────────────
    if (isStacked) {
        document.querySelectorAll('.stacked-splitter').forEach(splitter => {
            let startY, prevSection, nextSection, prevH, nextH;
            splitter.addEventListener('mousedown', (e) => {
                e.preventDefault();
                startY = e.clientY;
                prevSection = splitter.previousElementSibling;
                nextSection = splitter.nextElementSibling;
                prevH = prevSection.offsetHeight;
                nextH = nextSection.offsetHeight;
                splitter.classList.add('active');
                const onMove = (e2) => {
                    const dy = e2.clientY - startY;
                    const newPrev = Math.max(80, prevH + dy);
                    const newNext = Math.max(80, nextH - dy);
                    prevSection.style.flex = 'none';
                    nextSection.style.flex = 'none';
                    prevSection.style.height = newPrev + 'px';
                    nextSection.style.height = newNext + 'px';
                };
                const onUp = () => {
                    splitter.classList.remove('active');
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    if (gridApi && gridApi.redrawAll) gridApi.redrawAll();
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        });
    }

    // ── Common: Tab Switching ───────────────────────
    ${!isStacked ? `
    let currentTab = 0;
    function switchTab(index) {
        document.querySelectorAll('.tab').forEach((t, i) => {
            t.classList.toggle('active', i === index);
        });
        const rsCount = gridApi ? gridApi.getTableCount() : 0;
        for (let i = 0; i < rsCount; i++) {
            const el = document.getElementById('tab-' + i);
            if (el) el.style.display = i === index ? '' : 'none';
        }
        currentTab = index;
        if (index >= 0 && gridApi && gridApi.redraw) {
            setTimeout(() => gridApi.redraw(index), 50);
        }
    }
    ` : ''}

    // Disable browser default context menu
    document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
    });
</script>
</body>
</html>`;
    }

    /** Format error bar with SSMS-style details */
    private formatErrorBar(result: BatchResult): string {
        const errMsgs = result.messages.filter(m => (m.severity ?? 0) >= 11);
        if (errMsgs.length > 0) {
            return errMsgs.map(m => {
                const parts: string[] = [];
                parts.push(`Msg ${m.number ?? 0}`);
                parts.push(`Level ${m.severity ?? 0}`);
                parts.push(`State ${m.state ?? 0}`);
                if (m.procName) { parts.push(`Procedure ${m.procName}`); }
                if (m.lineNumber != null) { parts.push(`Line ${m.lineNumber}`); }
                return `${this.escapeHtml(parts.join(', '))}\n${this.escapeHtml(m.message)}`;
            }).join('\n\n');
        }
        return this.escapeHtml(result.error || '');
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    private async openInExcel(data: string): Promise<void> {
        const os = require('os');
        const path = require('path');
        const fs = require('fs');
        const tmpFile = path.join(os.tmpdir(), `tsql_result_${Date.now()}.csv`);
        const csvData = data.split('\n').map((line: string) =>
            line.split('\t').map((cell: string) => {
                if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
                    return '"' + cell.replace(/"/g, '""') + '"';
                }
                return cell;
            }).join(',')
        ).join('\n');
        fs.writeFileSync(tmpFile, '\uFEFF' + csvData, 'utf-8');
        const uri = vscode.Uri.file(tmpFile);
        await vscode.env.openExternal(uri);
    }

    dispose(): void {
        // WebviewView is managed by VS Code
    }
}
