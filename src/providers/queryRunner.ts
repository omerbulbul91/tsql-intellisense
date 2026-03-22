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

    constructor(private connectionManager: ConnectionManager) {
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

        webviewView.webview.options = {
            enableScripts: true,
        };

        // Handle messages from webview (export)
        webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg.type === 'exportCsv') {
                this.exportCsv(msg.data);
            } else if (msg.type === 'exportJson') {
                this.exportJson(msg.data);
            } else if (msg.type === 'openInExcel') {
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

    private buildHtml(result: BatchResult): string {
        const config = vscode.workspace.getConfiguration('tsql-intellisense');
        const displayMode = config.get<string>('resultDisplayMode', 'tabs');
        const resultTabs = result.resultSets.map((rs, i) => this.buildResultSetTab(rs, i));
        const messagesHtml = this.buildMessages(result);
        const activeTab = result.resultSets.length > 0 ? 0 : -1;

        if (displayMode === 'stacked' && result.resultSets.length > 1) {
            return this.buildStackedHtml(result, resultTabs, messagesHtml);
        }

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
    .toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 8px;
        background: var(--vscode-editorWidget-background);
        border-bottom: 1px solid var(--vscode-editorWidget-border);
    }
    .toolbar .info {
        flex: 1;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
    }
    .toolbar button {
        padding: 2px 8px;
        font-size: 11px;
        cursor: pointer;
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: none;
        border-radius: 2px;
    }
    .toolbar button:hover {
        background: var(--vscode-button-secondaryHoverBackground);
    }
    .tabs {
        display: flex;
        background: var(--vscode-editorWidget-background);
        border-bottom: 1px solid var(--vscode-editorWidget-border);
    }
    .tab {
        padding: 4px 12px;
        font-size: 11px;
        cursor: pointer;
        border-bottom: 2px solid transparent;
        color: var(--vscode-descriptionForeground);
    }
    .tab.active {
        color: var(--vscode-foreground);
        border-bottom-color: var(--vscode-focusBorder);
    }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .table-container {
        overflow: auto;
        flex: 1;
    }
    table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
    }
    th {
        position: sticky;
        top: 0;
        background: var(--vscode-editorWidget-background);
        padding: 4px 8px;
        text-align: left;
        border-bottom: 2px solid var(--vscode-editorWidget-border);
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
    }
    th:hover { background: var(--vscode-list-hoverBackground); }
    th .sort-arrow { margin-left: 4px; opacity: 0.5; font-size: 10px; }
    td {
        padding: 2px 8px;
        border-bottom: 1px solid var(--vscode-editorWidget-border);
        white-space: nowrap;
        max-width: 400px;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    tr:hover td { background: var(--vscode-list-hoverBackground); }
    tr.selected td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    td.selected-cell { background: rgba(0, 120, 212, 0.15); }
    td.active-cell { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
    td.null-val { color: var(--vscode-descriptionForeground); font-style: italic; }
    th.row-check, td.row-check {
        width: 28px;
        min-width: 28px;
        max-width: 28px;
        text-align: center;
        padding: 2px 4px;
        cursor: pointer;
        user-select: none;
    }
    th.row-check { font-size: 10px; }
    td.row-check input[type="checkbox"] {
        cursor: pointer;
        margin: 0;
        accent-color: var(--vscode-focusBorder);
    }
    .messages {
        padding: 6px 8px;
        font-family: var(--vscode-editor-fontFamily, monospace);
        font-size: 12px;
        white-space: pre-wrap;
        border-top: 1px solid var(--vscode-editorWidget-border);
        max-height: 120px;
        overflow-y: auto;
    }
    .context-menu {
        position: fixed;
        background: var(--vscode-menu-background, #252526);
        border: 1px solid var(--vscode-menu-border, #454545);
        border-radius: 4px;
        padding: 4px 0;
        min-width: 180px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
        z-index: 1000;
        font-size: 12px;
    }
    .context-menu-item {
        padding: 4px 24px;
        cursor: pointer;
        display: flex;
        justify-content: space-between;
        color: var(--vscode-menu-foreground, #ccc);
    }
    .context-menu-item:hover {
        background: var(--vscode-menu-selectionBackground, #094771);
        color: var(--vscode-menu-selectionForeground, #fff);
    }
    .context-menu-item .shortcut {
        margin-left: 24px;
        opacity: 0.7;
        font-size: 11px;
    }
    .context-menu-separator {
        height: 1px;
        background: var(--vscode-menu-separatorBackground, #454545);
        margin: 4px 0;
    }
    .error {
        color: var(--vscode-errorForeground);
        background: var(--vscode-inputValidation-errorBackground);
        padding: 6px 8px;
        border-left: 3px solid var(--vscode-inputValidation-errorBorder);
    }
</style>
</head>
<body>
    <div class="toolbar">
        <span class="info">${this.buildInfoText(result)}</span>
        ${result.resultSets.length > 0 ? `
            <button onclick="exportCsv()">CSV</button>
            <button onclick="exportJson()">JSON</button>
        ` : ''}
    </div>
    ${result.resultSets.length > 1 ? `
        <div class="tabs">
            ${result.resultSets.map((_, i) => `
                <div class="tab ${i === 0 ? 'active' : ''}" onclick="switchTab(${i})">
                    Result ${i + 1}
                </div>
            `).join('')}
            <div class="tab" onclick="switchTab(-1)">Messages</div>
        </div>
    ` : ''}
    ${resultTabs.map((html, i) => `
        <div class="tab-content ${i === activeTab ? 'active' : ''}" data-tab="${i}">
            ${html}
        </div>
    `).join('')}
    <div class="tab-content ${activeTab === -1 ? 'active' : ''}" data-tab="-1">
        ${messagesHtml}
    </div>
<script>
    const vscode = acquireVsCodeApi();
    let currentTab = ${activeTab};
    const resultSets = ${JSON.stringify(result.resultSets.map(rs => ({ columns: rs.columns, rows: rs.rows })))};

    function switchTab(index) {
        document.querySelectorAll('.tab').forEach((t, i) => {
            t.classList.toggle('active', i === (index === -1 ? document.querySelectorAll('.tab').length - 1 : index));
        });
        document.querySelectorAll('.tab-content').forEach(tc => {
            tc.classList.toggle('active', tc.dataset.tab == index);
        });
        currentTab = index;
    }

    function sortTable(tabIndex, colIndex) {
        const container = document.querySelector('[data-tab="' + tabIndex + '"] table tbody');
        if (!container) return;
        const rows = Array.from(container.rows);
        const isAsc = container.dataset.sortCol == colIndex && container.dataset.sortDir === 'asc';
        rows.sort((a, b) => {
            const aVal = a.cells[colIndex].textContent || '';
            const bVal = b.cells[colIndex].textContent || '';
            const aNum = Number(aVal), bNum = Number(bVal);
            if (!isNaN(aNum) && !isNaN(bNum)) return isAsc ? bNum - aNum : aNum - bNum;
            return isAsc ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
        });
        rows.forEach(r => container.appendChild(r));
        container.dataset.sortCol = colIndex;
        container.dataset.sortDir = isAsc ? 'desc' : 'asc';
    }

    function exportCsv() {
        const rs = resultSets[Math.max(0, currentTab)];
        if (!rs) return;
        const lines = [rs.columns.join(',')];
        rs.rows.forEach(row => {
            lines.push(rs.columns.map(c => {
                const val = row[c];
                if (val === null || val === undefined) return '';
                const str = String(val);
                return str.includes(',') || str.includes('"') ? '"' + str.replace(/"/g, '""') + '"' : str;
            }).join(','));
        });
        vscode.postMessage({ type: 'exportCsv', data: lines.join('\\n') });
    }

    function exportJson() {
        const rs = resultSets[Math.max(0, currentTab)];
        if (!rs) return;
        vscode.postMessage({ type: 'exportJson', data: JSON.stringify(rs.rows, null, 2) });
    }

    // ── Cell Selection ─────────────────────────────────────────
    let selectedCells = new Set();
    let activeCell = null;
    let lastClickedCell = null;

    // ── Row Selection (via checkbox column) ─────────────────
    let selectedRows = new Set();
    let lastCheckedRow = null;

    document.addEventListener('click', (e) => {
        // Ignore clicks on checkboxes (handled by toggleRowCheck)
        if (e.target.closest('.row-check')) { return; }

        const cell = e.target.closest('td');
        const row = e.target.closest('tbody tr');
        if (!cell || !row) {
            selectedCells.clear();
            activeCell = null;
            refreshSelection();
            return;
        }

        // Cell selection
        if (e.ctrlKey) {
            if (selectedCells.has(cell)) { selectedCells.delete(cell); } else { selectedCells.add(cell); }
        } else if (e.shiftKey && lastClickedCell) {
            // Range select cells between lastClickedCell and current
            const allCells = Array.from(document.querySelectorAll('[data-tab="' + Math.max(0, currentTab) + '"] tbody td:not(.row-check)'));
            const lastIdx = allCells.indexOf(lastClickedCell);
            const currIdx = allCells.indexOf(cell);
            if (lastIdx >= 0 && currIdx >= 0) {
                const [start, end] = lastIdx < currIdx ? [lastIdx, currIdx] : [currIdx, lastIdx];
                for (let i = start; i <= end; i++) { selectedCells.add(allCells[i]); }
            }
        } else {
            selectedCells.clear();
            selectedCells.add(cell);
        }
        activeCell = cell;
        lastClickedCell = cell;
        refreshSelection();
    });

    function toggleRowCheck(checkbox, event) {
        const row = checkbox.closest('tr');
        if (!row) return;

        if (event.shiftKey && lastCheckedRow) {
            const allRows = Array.from(row.parentElement.rows);
            const lastIdx = allRows.indexOf(lastCheckedRow);
            const currIdx = allRows.indexOf(row);
            const [start, end] = lastIdx < currIdx ? [lastIdx, currIdx] : [currIdx, lastIdx];
            const checked = checkbox.checked;
            for (let i = start; i <= end; i++) {
                const cb = allRows[i].querySelector('.row-check input');
                if (cb) { cb.checked = checked; }
                if (checked) { selectedRows.add(allRows[i]); } else { selectedRows.delete(allRows[i]); }
            }
        } else {
            if (checkbox.checked) { selectedRows.add(row); } else { selectedRows.delete(row); }
        }
        lastCheckedRow = row;
        refreshSelection();
    }

    function toggleAllRows(tabIndex, checked) {
        const tbody = document.querySelector('[data-tab="' + tabIndex + '"] tbody');
        if (!tbody) return;
        selectedRows.clear();
        Array.from(tbody.rows).forEach(r => {
            const cb = r.querySelector('.row-check input');
            if (cb) { cb.checked = checked; }
            if (checked) { selectedRows.add(r); }
        });
        refreshSelection();
    }

    function refreshSelection() {
        document.querySelectorAll('tbody tr').forEach(r => r.classList.toggle('selected', selectedRows.has(r)));
        document.querySelectorAll('td.selected-cell').forEach(c => c.classList.remove('selected-cell'));
        document.querySelectorAll('td.active-cell').forEach(c => c.classList.remove('active-cell'));
        selectedCells.forEach(c => c.classList.add('selected-cell'));
        if (activeCell) { activeCell.classList.add('active-cell'); }
    }

    function getSelectedData(withHeaders) {
        const rs = resultSets[Math.max(0, currentTab)];
        if (!rs) return '';

        // If cells are selected, copy only those cells
        if (selectedCells.size > 0 && selectedRows.size === 0) {
            const vals = Array.from(selectedCells).map(c => c.textContent || '');
            return vals.join('\\t');
        }

        // Otherwise use row selection (checkbox) or all rows
        const rows = selectedRows.size > 0 ? Array.from(selectedRows) : Array.from(document.querySelectorAll('[data-tab="' + Math.max(0, currentTab) + '"] tbody tr'));
        const lines = [];
        if (withHeaders) { lines.push(rs.columns.join('\\t')); }
        rows.forEach(row => {
            // Skip first cell (checkbox column)
            const dataCells = Array.from(row.cells).slice(1);
            lines.push(dataCells.map(c => c.textContent || '').join('\\t'));
        });
        return lines.join('\\n');
    }

    // ── Context Menu ───────────────────────────────────────────
    let contextMenu = null;

    document.addEventListener('contextmenu', (e) => {
        const row = e.target.closest('tbody tr');
        if (!row) return;
        e.preventDefault();
        if (!selectedRows.has(row) && !e.ctrlKey) {
            selectedRows.clear();
            selectedRows.add(row);
            refreshSelection();
        }
        showContextMenu(e.clientX, e.clientY);
    });

    document.addEventListener('click', (e) => {
        if (contextMenu && !contextMenu.contains(e.target)) { hideContextMenu(); }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { hideContextMenu(); }
        if ((e.ctrlKey || e.metaKey) && e.key === 'c') { e.preventDefault(); doCopy(false); }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'C') { e.preventDefault(); doCopy(true); }
        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
            e.preventDefault();
            toggleAllRows(Math.max(0, currentTab), true);
        }
    });

    function showContextMenu(x, y) {
        hideContextMenu();
        contextMenu = document.createElement('div');
        contextMenu.className = 'context-menu';
        const items = [
            { label: 'Copy', shortcut: 'Ctrl+C', action: () => doCopy(false) },
            { label: 'Copy with Headers', shortcut: 'Ctrl+Shift+C', action: () => doCopy(true) },
            { separator: true },
            { label: 'Select All', shortcut: 'Ctrl+A', action: () => toggleAllRows(Math.max(0, currentTab), true) },
            { separator: true },
            { label: 'Script as INSERT', action: () => scriptAsInsert() },
            { label: 'Open in Excel', action: () => openInExcel() },
        ];
        items.forEach(item => {
            if (item.separator) {
                const sep = document.createElement('div');
                sep.className = 'context-menu-separator';
                contextMenu.appendChild(sep);
                return;
            }
            const div = document.createElement('div');
            div.className = 'context-menu-item';
            div.innerHTML = '<span>' + item.label + '</span>' + (item.shortcut ? '<span class="shortcut">' + item.shortcut + '</span>' : '');
            div.addEventListener('click', () => { hideContextMenu(); item.action(); });
            contextMenu.appendChild(div);
        });
        // Position
        contextMenu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
        contextMenu.style.top = Math.min(y, window.innerHeight - 200) + 'px';
        document.body.appendChild(contextMenu);
    }

    function hideContextMenu() {
        if (contextMenu) { contextMenu.remove(); contextMenu = null; }
    }

    function doCopy(withHeaders) {
        const text = getSelectedData(withHeaders);
        navigator.clipboard.writeText(text);
    }

    function scriptAsInsert() {
        const rs = resultSets[Math.max(0, currentTab)];
        if (!rs) return;
        const rows = selectedRows.size > 0 ? Array.from(selectedRows) : Array.from(document.querySelectorAll('[data-tab="' + Math.max(0, currentTab) + '"] tbody tr'));
        const cols = rs.columns;
        const lines = rows.map(row => {
            const dataCells = Array.from(row.cells).slice(1); // skip checkbox column
            const vals = dataCells.map((c, i) => {
                const v = c.textContent;
                if (v === 'NULL') return 'NULL';
                const num = Number(v);
                if (!isNaN(num) && v.trim() !== '') return v;
                return "N'" + v.replace(/'/g, "''") + "'";
            });
            return 'INSERT INTO [TableName] (' + cols.map(c => '[' + c + ']').join(', ') + ') VALUES (' + vals.join(', ') + ');';
        });
        navigator.clipboard.writeText(lines.join('\\n'));
    }

    function openInExcel() {
        const data = getSelectedData(true);
        vscode.postMessage({ type: 'openInExcel', data: data });
    }
</script>
</body>
</html>`;
    }

    /** Build stacked layout — all result sets shown vertically */
    private buildStackedHtml(result: BatchResult, resultTabs: string[], messagesHtml: string): string {
        const stackedContent = resultTabs.map((html, i) => `
            <div class="stacked-section">
                <div class="stacked-header">Result ${i + 1} (${result.resultSets[i].rows.length} rows)</div>
                ${html}
            </div>
        `).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
    .toolbar {
        display: flex; align-items: center; gap: 8px; padding: 4px 8px;
        background: var(--vscode-editorWidget-background);
        border-bottom: 1px solid var(--vscode-editorWidget-border);
    }
    .toolbar .info { flex: 1; font-size: 12px; color: var(--vscode-descriptionForeground); }
    .toolbar button {
        padding: 2px 8px; font-size: 11px; cursor: pointer;
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: none; border-radius: 2px;
    }
    .toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .stacked-section { margin-bottom: 12px; }
    .stacked-header {
        padding: 4px 8px; font-size: 11px; font-weight: bold;
        background: var(--vscode-editorWidget-background);
        border-bottom: 2px solid var(--vscode-focusBorder);
        color: var(--vscode-foreground);
    }
    .table-container { overflow: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th {
        position: sticky; top: 0;
        background: var(--vscode-editorWidget-background);
        padding: 4px 8px; text-align: left;
        border-bottom: 2px solid var(--vscode-editorWidget-border);
        cursor: pointer; user-select: none; white-space: nowrap;
    }
    th:hover { background: var(--vscode-list-hoverBackground); }
    th .sort-arrow { margin-left: 4px; opacity: 0.5; font-size: 10px; }
    td {
        padding: 2px 8px;
        border-bottom: 1px solid var(--vscode-editorWidget-border);
        white-space: nowrap; max-width: 400px; overflow: hidden; text-overflow: ellipsis;
    }
    tr:hover td { background: var(--vscode-list-hoverBackground); }
    td.null-val { color: var(--vscode-descriptionForeground); font-style: italic; }
    .messages {
        padding: 6px 8px; font-family: var(--vscode-editor-fontFamily, monospace);
        font-size: 12px; white-space: pre-wrap;
        border-top: 1px solid var(--vscode-editorWidget-border);
    }
    .error {
        color: var(--vscode-errorForeground);
        background: var(--vscode-inputValidation-errorBackground);
        padding: 6px 8px; border-left: 3px solid var(--vscode-inputValidation-errorBorder);
    }
</style>
</head>
<body>
    <div class="toolbar">
        <span class="info">${this.buildInfoText(result)}</span>
    </div>
    <div style="overflow: auto; height: calc(100vh - 40px);">
        ${stackedContent}
        ${messagesHtml ? `<div class="stacked-section"><div class="stacked-header">Messages</div>${messagesHtml}</div>` : ''}
    </div>
<script>
    function sortTable(tabIndex, colIndex) {
        const tables = document.querySelectorAll('.stacked-section table tbody');
        const container = tables[tabIndex];
        if (!container) return;
        const rows = Array.from(container.rows);
        const isAsc = container.dataset.sortCol == colIndex && container.dataset.sortDir === 'asc';
        rows.sort((a, b) => {
            const aVal = a.cells[colIndex].textContent || '';
            const bVal = b.cells[colIndex].textContent || '';
            const aNum = Number(aVal), bNum = Number(bVal);
            if (!isNaN(aNum) && !isNaN(bNum)) return isAsc ? bNum - aNum : aNum - bNum;
            return isAsc ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
        });
        rows.forEach(r => container.appendChild(r));
        container.dataset.sortCol = colIndex;
        container.dataset.sortDir = isAsc ? 'desc' : 'asc';
    }
</script>
</body>
</html>`;
    }

    private buildResultSetTab(rs: QueryResult, index: number): string {
        if (rs.columns.length === 0) { return '<div class="messages">No columns returned</div>'; }

        const checkHeader = `<th class="row-check"><input type="checkbox" onclick="toggleAllRows(${index}, this.checked)" title="Select All"></th>`;
        const headerCells = checkHeader + rs.columns
            .map((col, i) => `<th onclick="sortTable(${index}, ${i + 1})">${this.escapeHtml(col)} <span class="sort-arrow">⇅</span></th>`)
            .join('');

        const bodyRows = rs.rows.map((row, rowIdx) => {
            const checkCell = `<td class="row-check"><input type="checkbox" data-row-idx="${rowIdx}" onclick="toggleRowCheck(this, event)"></td>`;
            const cells = rs.columns.map(col => {
                const val = row[col];
                if (val === null || val === undefined) {
                    return '<td class="null-val">NULL</td>';
                }
                return `<td>${this.escapeHtml(String(val))}</td>`;
            }).join('');
            return `<tr>${checkCell}${cells}</tr>`;
        }).join('');

        return `<div class="table-container">
            <table>
                <thead><tr>${headerCells}</tr></thead>
                <tbody>${bodyRows}</tbody>
            </table>
        </div>`;
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

        if (result.error) {
            parts.push('ERROR');
        }

        return parts.join(' | ');
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    private async exportCsv(data: string): Promise<void> {
        const uri = await vscode.window.showSaveDialog({
            filters: { 'CSV': ['csv'] },
            defaultUri: vscode.Uri.file('query_results.csv'),
        });
        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(data, 'utf-8'));
            vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
        }
    }

    private async exportJson(data: string): Promise<void> {
        const uri = await vscode.window.showSaveDialog({
            filters: { 'JSON': ['json'] },
            defaultUri: vscode.Uri.file('query_results.json'),
        });
        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(data, 'utf-8'));
            vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
        }
    }

    private async openInExcel(data: string): Promise<void> {
        const os = require('os');
        const path = require('path');
        const fs = require('fs');
        const tmpFile = path.join(os.tmpdir(), `tsql_result_${Date.now()}.csv`);
        // Convert tab-separated to CSV
        const csvData = data.split('\n').map(line =>
            line.split('\t').map(cell => {
                if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
                    return '"' + cell.replace(/"/g, '""') + '"';
                }
                return cell;
            }).join(',')
        ).join('\n');
        fs.writeFileSync(tmpFile, '\uFEFF' + csvData, 'utf-8'); // BOM for Excel UTF-8
        const uri = vscode.Uri.file(tmpFile);
        await vscode.env.openExternal(uri);
    }

    dispose(): void {
        // WebviewView is managed by VS Code
    }
}
