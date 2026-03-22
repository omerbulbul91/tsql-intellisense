import * as vscode from 'vscode';
import { ConnectionManager, BatchResult, QueryResult } from '../connection/connectionManager';

export class QueryRunner implements vscode.WebviewViewProvider {
    private webviewView: vscode.WebviewView | null = null;
    private lastResult: BatchResult | null = null;
    /** Per-document query results — keyed by document URI string */
    private documentResults = new Map<string, BatchResult>();
    private _onQueryExecuted = new vscode.EventEmitter<{ sql: string; result: BatchResult }>();
    public readonly onQueryExecuted = this._onQueryExecuted.event;

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
            localRoots.push(vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'tabulator-tables'));
        }
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: localRoots.length > 0 ? localRoots : undefined,
        };

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

        // Show progress — retry once on connection failure
        let result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Executing query...',
                cancellable: false,
            },
            async () => {
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

        const result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Executing query...',
                cancellable: false,
            },
            () => this.connectionManager.executeBatch(sql)
        );

        this.lastResult = result;
        const editor = vscode.window.activeTextEditor;
        if (editor) { this.documentResults.set(editor.document.uri.toString(), result); }
        this.showResults(result);
        if (!result.error) {
            this._onQueryExecuted.fire({ sql, result });
        }
    }

    /** Display results in the bottom panel */
    private showResults(result: BatchResult): void {
        // Make sure the panel is visible
        vscode.commands.executeCommand('tsqlResults.focus');

        if (this.webviewView) {
            this.webviewView.webview.html = this.buildHtml(result);
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

    private getTabulatorUris(webview: vscode.Webview): { js: vscode.Uri; css: vscode.Uri } | null {
        if (!this.extensionUri) { return null; }
        const base = vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'tabulator-tables', 'dist');
        return {
            js: webview.asWebviewUri(vscode.Uri.joinPath(base, 'js', 'tabulator.min.js')),
            css: webview.asWebviewUri(vscode.Uri.joinPath(base, 'css', 'tabulator_midnight.min.css')),
        };
    }

    private buildHtml(result: BatchResult): string {
        if (!this.webviewView) { return this.buildEmptyHtml(); }
        const uris = this.getTabulatorUris(this.webviewView.webview);

        const config = vscode.workspace.getConfiguration('tsql-intellisense');
        const displayMode = config.get<string>('resultDisplayMode', 'tabs');
        const messagesHtml = this.buildMessages(result);
        const resultSetsJson = JSON.stringify(result.resultSets.map(rs => ({ columns: rs.columns, rows: rs.rows })));
        const isStacked = displayMode === 'stacked' && result.resultSets.length > 1;

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${uris ? `<link rel="stylesheet" href="${uris.css}">` : ''}
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
    /* ── Tabs ─────────────────────────────────────── */
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
    .grid-container { width: 100%; height: 100%; }
    .stacked-wrapper { flex: 1; overflow: auto; }
    .stacked-section { margin-bottom: 4px; }
    .stacked-header {
        padding: 4px 8px; font-size: 11px; font-weight: bold;
        background: var(--vscode-editorWidget-background);
        border-bottom: 2px solid var(--vscode-focusBorder);
        color: var(--vscode-foreground);
    }
    .stacked-grid { width: 100%; }
    /* ── Status bar ──────────────────────────────── */
    .status-bar {
        display: flex; align-items: center; gap: 12px; padding: 2px 8px;
        background: var(--vscode-editorWidget-background);
        border-top: 1px solid var(--vscode-editorWidget-border);
        flex-shrink: 0; font-size: 11px;
        color: var(--vscode-descriptionForeground);
    }
    /* ── Messages / Error ────────────────────────── */
    .messages {
        padding: 6px 8px; font-family: var(--vscode-editor-fontFamily, monospace);
        font-size: 12px; white-space: pre-wrap;
        border-top: 1px solid var(--vscode-editorWidget-border);
        max-height: 120px; overflow-y: auto; flex-shrink: 0;
    }
    .error {
        color: var(--vscode-errorForeground);
        background: var(--vscode-inputValidation-errorBackground);
        padding: 6px 8px; border-left: 3px solid var(--vscode-inputValidation-errorBorder);
    }
    /* ── Tabulator VS Code theme overrides ────────── */
    .tabulator {
        background: var(--vscode-editor-background) !important;
        border: none !important;
        font-family: var(--vscode-font-family, 'Segoe UI', sans-serif) !important;
        font-size: 12px !important;
        color: var(--vscode-foreground) !important;
    }
    .tabulator .tabulator-header {
        background: var(--vscode-editorWidget-background) !important;
        border-bottom: 2px solid var(--vscode-editorWidget-border) !important;
        color: var(--vscode-foreground) !important;
    }
    .tabulator .tabulator-header .tabulator-col {
        background: var(--vscode-editorWidget-background) !important;
        border-right: 1px solid var(--vscode-editorWidget-border) !important;
    }
    .tabulator .tabulator-header .tabulator-col:hover {
        background: var(--vscode-list-hoverBackground) !important;
    }
    .tabulator .tabulator-header .tabulator-col .tabulator-col-content {
        padding: 4px 8px !important;
    }
    .tabulator .tabulator-header .tabulator-col .tabulator-header-filter input {
        background: var(--vscode-input-background) !important;
        color: var(--vscode-input-foreground) !important;
        border: 1px solid var(--vscode-input-border, transparent) !important;
        border-radius: 2px !important;
        padding: 1px 4px !important;
        font-size: 11px !important;
        outline: none !important;
    }
    .tabulator .tabulator-header .tabulator-col .tabulator-header-filter input:focus {
        border-color: var(--vscode-focusBorder) !important;
    }
    .tabulator .tabulator-header .tabulator-col .tabulator-header-filter input::placeholder {
        color: var(--vscode-input-placeholderForeground) !important;
    }
    .tabulator .tabulator-tableholder {
        background: var(--vscode-editor-background) !important;
    }
    .tabulator-row {
        border-bottom: 1px solid var(--vscode-editorWidget-border) !important;
        background: var(--vscode-editor-background) !important;
        color: var(--vscode-foreground) !important;
    }
    .tabulator-row:hover {
        background: var(--vscode-list-hoverBackground) !important;
    }
    .tabulator-row.tabulator-selected {
        background: var(--vscode-list-activeSelectionBackground) !important;
        color: var(--vscode-list-activeSelectionForeground) !important;
    }
    .tabulator-row .tabulator-cell {
        border-right: 1px solid var(--vscode-editorWidget-border) !important;
        padding: 2px 8px !important;
    }
    .tabulator-row .tabulator-cell.cell-selected {
        background: rgba(0, 120, 212, 0.15) !important;
    }
    .tabulator-row .tabulator-cell.cell-active {
        outline: 2px solid var(--vscode-focusBorder) !important;
        outline-offset: -2px;
    }
    .tabulator-row .tabulator-cell.null-val {
        color: var(--vscode-descriptionForeground) !important;
        font-style: italic;
    }
    .tabulator .tabulator-footer {
        background: var(--vscode-editorWidget-background) !important;
        border-top: 1px solid var(--vscode-editorWidget-border) !important;
        color: var(--vscode-descriptionForeground) !important;
    }
    /* checkbox styling */
    .tabulator-row .tabulator-cell input[type="checkbox"] {
        accent-color: var(--vscode-focusBorder);
        cursor: pointer;
    }
    /* ── Header menu (funnel) icon ───────────────── */
    .tabulator .tabulator-header .tabulator-col .tabulator-header-popup-button {
        color: var(--vscode-descriptionForeground) !important;
        opacity: 0.5;
        padding: 0 2px !important;
        font-size: 10px !important;
    }
    .tabulator .tabulator-header .tabulator-col .tabulator-header-popup-button:hover {
        opacity: 1;
    }
    .tabulator .tabulator-header .tabulator-col.has-filter .tabulator-header-popup-button {
        opacity: 1;
        color: var(--vscode-focusBorder) !important;
    }
    /* ── Header menu popup ───────────────────────── */
    .tabulator-popup {
        background: var(--vscode-menu-background, #252526) !important;
        border: 1px solid var(--vscode-menu-border, #454545) !important;
        border-radius: 4px !important;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4) !important;
        padding: 6px !important;
    }
    .tabulator-popup .filter-popup {
        display: flex; flex-direction: column; gap: 4px; min-width: 160px;
    }
    .tabulator-popup .filter-popup input {
        padding: 3px 6px; font-size: 11px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 2px; outline: none;
    }
    .tabulator-popup .filter-popup input:focus {
        border-color: var(--vscode-focusBorder);
    }
    .tabulator-popup .filter-popup input::placeholder {
        color: var(--vscode-input-placeholderForeground);
    }
    .tabulator-popup .filter-popup .filter-actions {
        display: flex; gap: 4px;
    }
    .tabulator-popup .filter-popup .filter-actions button {
        flex: 1; padding: 2px 6px; font-size: 10px; cursor: pointer;
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: none; border-radius: 2px;
    }
    .tabulator-popup .filter-popup .filter-actions button:hover {
        background: var(--vscode-button-secondaryHoverBackground);
    }
    .tabulator-popup .filter-popup .filter-actions button.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    .tabulator-popup .filter-popup .filter-actions button.primary:hover {
        background: var(--vscode-button-hoverBackground);
    }
</style>
</head>
<body>
    ${result.resultSets.length > 0 ? `
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
            <div class="tab" onclick="switchTab(-1)">Messages</div>
        </div>
    ` : ''}
    ${isStacked ? `
        <div class="stacked-wrapper">
            ${result.resultSets.map((rs, i) => `
                <div class="stacked-section">
                    <div class="stacked-header">Result ${i + 1} (${rs.rows.length} rows)</div>
                    <div id="grid-${i}" class="stacked-grid"></div>
                </div>
            `).join('')}
            ${messagesHtml ? `<div class="stacked-section"><div class="stacked-header">Messages</div>${messagesHtml}</div>` : ''}
        </div>
    ` : `
        ${result.resultSets.map((_, i) => `
            <div class="grid-wrapper" id="tab-${i}" style="${i > 0 ? 'display:none' : ''}">
                <div id="grid-${i}" class="grid-container"></div>
            </div>
        `).join('')}
        <div id="tab-messages" style="${result.resultSets.length > 0 ? 'display:none' : ''}">
            ${messagesHtml}
        </div>
    `}
    ${!isStacked && result.resultSets.length <= 1 ? messagesHtml : ''}
    <div class="status-bar">
        <span id="status-info">${this.buildInfoText(result)}</span>
    </div>
${uris ? `<script src="${uris.js}"></script>` : ''}
<script>
    const vscodeApi = acquireVsCodeApi();
    const resultSets = ${resultSetsJson};
    const tables = [];
    const isStacked = ${isStacked};
    const totalRows = ${result.resultSets.reduce((s, rs) => s + rs.rows.length, 0)};
    const elapsed = '${(result.elapsed / 1000).toFixed(2)}s';

    resultSets.forEach((rs, i) => {
        if (rs.columns.length === 0) return;
        const el = document.getElementById('grid-' + i);
        if (!el) return;

        ${isStacked ? `
        const rowH = 28, headerH = 56;
        el.style.height = Math.min(headerH + rs.rows.length * rowH, 400) + 'px';
        ` : ''}

        const columns = [
            { formatter: "rowSelection", titleFormatter: "rowSelection", headerSort: false, resizable: false, width: 30, hozAlign: "center" },
            ...rs.columns.map(col => ({
                title: col,
                field: col,
                sorter: "string",
                resizable: true,
                headerPopup: function(e, column) {
                    return buildFilterMenu(column);
                },
                headerPopupIcon: "<svg width='10' height='10' viewBox='0 0 24 24' fill='currentColor'><path d='M3 4h18l-7 8v5l-4 2v-7z'/></svg>",
                formatter: function(cell) {
                    const v = cell.getValue();
                    if (v === null || v === undefined) {
                        cell.getElement().classList.add('null-val');
                        return 'NULL';
                    }
                    return v;
                },
            })),
        ];

        const table = new Tabulator(el, {
            data: rs.rows,
            columns: columns,
            layout: "fitDataFill",
            height: isStacked ? undefined : "100%",
            selectable: true,
            selectableRangeMode: "click",
            clipboard: true,
            clipboardCopyRowRange: "selected",
            clipboardCopyConfig: { columnHeaders: true },
            headerSortTristate: true,
            movableColumns: false,
            resizableColumnFit: true,
            rowHeight: 25,
            headerHeight: 28,
            dataFiltered: function(filters, rows) {
                updateStatus(rows.length);
            },
        });

        tables.push(table);
    });

    // ── Column Filter Menu (funnel) ───────────────────
    const columnFilters = {};
    function buildFilterMenu(column) {
        const field = column.getField();
        const container = document.createElement('div');
        container.className = 'filter-popup';
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Filter ' + field + '...';
        input.value = columnFilters[field] || '';
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyBtn.click(); });
        const actions = document.createElement('div');
        actions.className = 'filter-actions';
        const applyBtn = document.createElement('button');
        applyBtn.className = 'primary';
        applyBtn.textContent = 'Apply';
        applyBtn.onclick = () => {
            const val = input.value.trim();
            const table = column.getTable();
            const colEl = column.getElement();
            if (val) {
                columnFilters[field] = val;
                table.addFilter(field, "like", val);
                colEl.classList.add('has-filter');
            } else {
                delete columnFilters[field];
                table.removeFilter(field, "like", columnFilters[field]);
                table.clearFilter();
                // re-apply remaining filters
                Object.entries(columnFilters).forEach(([f, v]) => table.addFilter(f, "like", v));
                colEl.classList.remove('has-filter');
            }
        };
        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear';
        clearBtn.onclick = () => {
            input.value = '';
            delete columnFilters[field];
            const table = column.getTable();
            table.removeFilter(field, "like");
            column.getElement().classList.remove('has-filter');
        };
        actions.appendChild(applyBtn);
        actions.appendChild(clearBtn);
        container.appendChild(input);
        container.appendChild(actions);
        setTimeout(() => input.focus(), 50);
        return container;
    }

    // ── Quick Filter ────────────────────────────────
    function onQuickFilter(value) {
        tables.forEach(table => {
            if (!value) {
                table.clearFilter();
                return;
            }
            const rs = resultSets[tables.indexOf(table)];
            if (!rs) return;
            const filters = rs.columns.map(col => ({
                field: col,
                type: "like",
                value: value,
            }));
            table.setFilter([filters]);
        });
    }

    // ── Column Chooser ──────────────────────────────
    let chooserEl = null;
    function toggleColumnChooser(event) {
        if (chooserEl) { chooserEl.remove(); chooserEl = null; return; }
        const table = tables[Math.max(0, currentTab || 0)];
        if (!table) return;
        const cols = table.getColumns().filter(c => c.getField());
        chooserEl = document.createElement('div');
        chooserEl.className = 'col-chooser';
        cols.forEach(col => {
            const lbl = document.createElement('label');
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = col.isVisible();
            cb.onchange = () => col.isVisible() ? col.hide() : col.show();
            lbl.appendChild(cb);
            lbl.appendChild(document.createTextNode(col.getDefinition().title || col.getField()));
            chooserEl.appendChild(lbl);
        });
        const actions = document.createElement('div');
        actions.className = 'col-chooser-actions';
        const showAll = document.createElement('button');
        showAll.textContent = 'Show All';
        showAll.onclick = () => { cols.forEach(c => c.show()); chooserEl.querySelectorAll('input').forEach(cb => cb.checked = true); };
        const hideAll = document.createElement('button');
        hideAll.textContent = 'Hide All';
        hideAll.onclick = () => { cols.forEach(c => c.hide()); chooserEl.querySelectorAll('input').forEach(cb => cb.checked = false); };
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
        if (chooserEl && !chooserEl.contains(e.target) && !e.target.closest('.toolbar button')) {
            chooserEl.remove(); chooserEl = null;
        }
    });

    // ── Cell Selection (Click, Ctrl+Click, Shift+Click range) ──
    let selectedCells = new Set();
    let activeCell = null;
    let lastClickedCell = null;
    document.addEventListener('click', (e) => {
        const cell = e.target.closest('.tabulator-cell');
        if (!cell || cell.closest('.tabulator-header')) return;
        if (cell.querySelector('input[type="checkbox"]')) return;

        if (e.ctrlKey) {
            if (selectedCells.has(cell)) {
                selectedCells.delete(cell); cell.classList.remove('cell-selected');
            } else {
                selectedCells.add(cell); cell.classList.add('cell-selected');
            }
        } else if (e.shiftKey && lastClickedCell) {
            // Range select between lastClickedCell and current
            const allCells = Array.from(document.querySelectorAll('.tabulator-row .tabulator-cell:not(:first-child)'));
            const lastIdx = allCells.indexOf(lastClickedCell);
            const currIdx = allCells.indexOf(cell);
            if (lastIdx >= 0 && currIdx >= 0) {
                const [start, end] = lastIdx < currIdx ? [lastIdx, currIdx] : [currIdx, lastIdx];
                selectedCells.forEach(c => c.classList.remove('cell-selected', 'cell-active'));
                selectedCells.clear();
                for (let j = start; j <= end; j++) {
                    selectedCells.add(allCells[j]);
                    allCells[j].classList.add('cell-selected');
                }
            }
        } else {
            selectedCells.forEach(c => c.classList.remove('cell-selected', 'cell-active'));
            selectedCells.clear();
            selectedCells.add(cell); cell.classList.add('cell-selected');
        }
        if (activeCell) activeCell.classList.remove('cell-active');
        activeCell = cell; cell.classList.add('cell-active');
        lastClickedCell = cell;
    });

    // ── CSV Export ───────────────────────────────────
    function exportCsv() {
        const table = tables[Math.max(0, currentTab || 0)];
        if (table) table.download("csv", "query_results.csv");
    }

    // ── Status Bar ──────────────────────────────────
    function updateStatus(filteredCount) {
        const el = document.getElementById('status-info');
        if (!el) return;
        if (filteredCount < totalRows) {
            el.textContent = filteredCount + ' of ' + totalRows + ' rows | ' + elapsed;
        } else {
            el.textContent = totalRows + ' rows | ' + elapsed;
        }
    }

    // ── Tab Switching ───────────────────────────────
    ${!isStacked ? `
    let currentTab = 0;
    function switchTab(index) {
        document.querySelectorAll('.tab').forEach((t, i) => {
            t.classList.toggle('active', i === (index === -1 ? document.querySelectorAll('.tab').length - 1 : index));
        });
        resultSets.forEach((_, i) => {
            const el = document.getElementById('tab-' + i);
            if (el) el.style.display = i === index ? '' : 'none';
        });
        const msgEl = document.getElementById('tab-messages');
        if (msgEl) msgEl.style.display = index === -1 ? '' : 'none';
        currentTab = index;
        if (index >= 0 && tables[index]) {
            setTimeout(() => tables[index].redraw(true), 50);
        }
    }
    ` : ''}
</script>
</body>
</html>`;
    }

    private buildMessages(result: BatchResult): string {
        let html = '';
        if (result.error) {
            html += `<div class="error">${this.escapeHtml(result.error)}</div>`;
        }
        if (result.messages.length > 0) {
            html += `<div class="messages">${result.messages.map(m => this.escapeHtml(m)).join('\n')}</div>`;
        }
        if (!result.error && result.messages.length === 0 && result.resultSets.length === 0) {
            html += '<div class="messages">Command(s) completed successfully.</div>';
        }
        return html;
    }

    private buildInfoText(result: BatchResult): string {
        const parts: string[] = [];
        if (result.resultSets.length > 0) {
            const totalRows = result.resultSets.reduce((sum, rs) => sum + rs.rows.length, 0);
            parts.push(`${totalRows} rows`);
        }
        parts.push(`${(result.elapsed / 1000).toFixed(2)}s`);
        if (result.error) { parts.push('ERROR'); }
        return parts.join(' | ');
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    dispose(): void {
        // WebviewView is managed by VS Code
    }
}
