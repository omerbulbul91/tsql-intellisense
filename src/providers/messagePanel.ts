import * as vscode from 'vscode';
import { BatchResult, SqlMessage } from '../connection/connectionManager';

export interface QueryMeta {
    startTime: Date;
    startLine: number;
}

export class MessagePanel implements vscode.WebviewViewProvider {
    private webviewView: vscode.WebviewView | null = null;
    /** Per-document messages — keyed by document URI string */
    private documentMessages = new Map<string, { result: BatchResult; meta?: QueryMeta }>();
    private lastData: { result: BatchResult; meta?: QueryMeta } | null = null;

    constructor() {
        // Switch messages when active editor changes
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (!editor || !this.webviewView) { return; }
            const key = editor.document.uri.toString();
            const data = this.documentMessages.get(key);
            if (data) {
                this.webviewView.webview.html = this.buildHtml(data.result, data.meta);
            } else {
                this.webviewView.webview.html = this.buildEmptyHtml();
            }
        });
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.webviewView = webviewView;
        webviewView.webview.options = { enableScripts: false };

        if (this.lastData) {
            webviewView.webview.html = this.buildHtml(this.lastData.result, this.lastData.meta);
        } else {
            webviewView.webview.html = this.buildEmptyHtml();
        }
    }

    /** Show messages for a query result */
    showMessages(result: BatchResult, meta?: QueryMeta): void {
        this.lastData = { result, meta };

        const editor = vscode.window.activeTextEditor;
        if (editor) {
            this.documentMessages.set(editor.document.uri.toString(), { result, meta });
        }

        if (this.webviewView) {
            this.webviewView.webview.html = this.buildHtml(result, meta);
        }
    }

    private buildEmptyHtml(): string {
        return `<!DOCTYPE html>
<html><head><style>
    body {
        font-family: var(--vscode-editor-fontFamily, monospace);
        color: var(--vscode-descriptionForeground);
        display: flex; align-items: center; justify-content: center;
        height: 100vh; margin: 0; font-size: 12px;
    }
</style></head>
<body>Run a query (F5) to see messages here</body></html>`;
    }

    private buildHtml(result: BatchResult, meta?: QueryMeta): string {
        const lines: string[] = [];

        // Start time and line info (SSMS-style)
        if (meta) {
            const t = meta.startTime;
            const h = t.getHours() % 12 || 12;
            const mi = String(t.getMinutes()).padStart(2, '0');
            const s = String(t.getSeconds()).padStart(2, '0');
            const ampm = t.getHours() >= 12 ? 'PM' : 'AM';
            const timeStr = `${h}:${mi}:${s} ${ampm}`;
            lines.push(`${timeStr}         Started executing query at  Line ${meta.startLine}`);
        }

        // PRINT messages, info messages, and errors (SSMS-style)
        if (result.messages.length > 0) {
            for (const m of result.messages) {
                lines.push(this.formatMessage(m));
            }
            lines.push('');
        }

        // Rows affected
        if (result.rowsAffected > 0) {
            lines.push(`(${result.rowsAffected} rows affected)`);
            lines.push('');
        }

        // Command completed (no result sets, no error)
        if (!result.error && result.resultSets.length === 0 && result.rowsAffected === 0) {
            lines.push('Command(s) completed successfully.');
            lines.push('');
        }

        // Total execution time
        const elapsed = result.elapsed;
        const eh = String(Math.floor(elapsed / 3600000)).padStart(2, '0');
        const em = String(Math.floor((elapsed % 3600000) / 60000)).padStart(2, '0');
        const es = String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0');
        const ems = String(elapsed % 1000).padStart(3, '0');
        lines.push(`Total execution time: ${eh}:${em}:${es}.${ems}`);

        // Error messages are already included in messages array with SSMS-style formatting
        // Show a summary error bar only if there's an error
        let errorHtml = '';
        if (result.error) {
            const errMsgs = result.messages.filter(m => (m.severity ?? 0) >= 11);
            if (errMsgs.length > 0) {
                errorHtml = errMsgs.map(m => `<div class="error">${this.formatMessage(m)}</div>`).join('');
            } else {
                errorHtml = `<div class="error">${this.escapeHtml(result.error)}</div>`;
            }
        }

        return `<!DOCTYPE html>
<html><head><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: var(--vscode-editor-fontFamily, monospace);
        font-size: 12px;
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 6px 8px;
        white-space: pre-wrap;
    }
    .error {
        color: var(--vscode-errorForeground);
        background: var(--vscode-inputValidation-errorBackground);
        padding: 6px 8px;
        border-left: 3px solid var(--vscode-inputValidation-errorBorder);
        margin-bottom: 4px;
    }
</style></head>
<body>${errorHtml}${lines.join('\n')}</body></html>`;
    }

    /** Format SqlMessage in SSMS style: Msg N, Level N, State N, Line N */
    private formatMessage(m: SqlMessage): string {
        const severity = m.severity ?? 0;
        // Info messages (severity < 11, e.g. PRINT): show just the text
        if (severity < 11 && !m.number) {
            return this.escapeHtml(m.message);
        }
        // SSMS-style: Msg 208, Level 16, State 1, Procedure sp_name, Line 5
        const parts: string[] = [];
        parts.push(`Msg ${m.number ?? 0}`);
        parts.push(`Level ${severity}`);
        parts.push(`State ${m.state ?? 0}`);
        if (m.procName) {
            parts.push(`Procedure ${m.procName}`);
        }
        if (m.lineNumber != null) {
            parts.push(`Line ${m.lineNumber}`);
        }
        return `${this.escapeHtml(parts.join(', '))}\n${this.escapeHtml(m.message)}`;
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
