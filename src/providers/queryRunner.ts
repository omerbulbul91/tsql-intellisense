import * as vscode from 'vscode';
import { ConnectionManager, BatchResult, QueryResult } from '../connection/connectionManager';

export class QueryRunner implements vscode.WebviewViewProvider {
    private webviewView: vscode.WebviewView | null = null;
    private lastResult: BatchResult | null = null;

    constructor(private connectionManager: ConnectionManager) {}

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

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor');
            return;
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

        // Show progress
        const result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Executing query...',
                cancellable: false,
            },
            () => this.connectionManager.executeBatch(sql)
        );

        this.lastResult = result;
        this.showResults(result);
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
        const resultTabs = result.resultSets.map((rs, i) => this.buildResultSetTab(rs, i));
        const messagesHtml = this.buildMessages(result);
        const activeTab = result.resultSets.length > 0 ? 0 : -1;

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
        font-size: var(--vscode-font-size, 13px);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
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
        max-height: calc(100vh - 80px);
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
    td.null-val { color: var(--vscode-descriptionForeground); font-style: italic; }
    .messages {
        padding: 6px 8px;
        font-family: var(--vscode-editor-fontFamily, monospace);
        font-size: 12px;
        white-space: pre-wrap;
        border-top: 1px solid var(--vscode-editorWidget-border);
        max-height: 120px;
        overflow-y: auto;
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
</script>
</body>
</html>`;
    }

    private buildResultSetTab(rs: QueryResult, index: number): string {
        if (rs.columns.length === 0) { return '<div class="messages">No columns returned</div>'; }

        const headerCells = rs.columns
            .map((col, i) => `<th onclick="sortTable(${index}, ${i})">${this.escapeHtml(col)} <span class="sort-arrow">⇅</span></th>`)
            .join('');

        const bodyRows = rs.rows.map(row => {
            const cells = rs.columns.map(col => {
                const val = row[col];
                if (val === null || val === undefined) {
                    return '<td class="null-val">NULL</td>';
                }
                return `<td>${this.escapeHtml(String(val))}</td>`;
            }).join('');
            return `<tr>${cells}</tr>`;
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

    dispose(): void {
        // WebviewView is managed by VS Code
    }
}
