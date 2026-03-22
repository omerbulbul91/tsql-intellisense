import * as vscode from 'vscode';
import { QueryRunner } from './queryRunner';

export class TsqlCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    constructor(private readonly queryRunner: QueryRunner) {}

    refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (document.languageId !== 'sql') { return []; }

        const text = document.getText();
        const docDb = this.queryRunner.getDocumentDatabase(document.uri);

        const connLabel = docDb ? docDb.profileName : 'Not connected';
        const dbLabel = docDb ? docDb.dbName : 'No database';

        const lenses: vscode.CodeLens[] = [];

        // Always show connection + db on line 0 (even for empty files)
        const topRange = new vscode.Range(0, 0, 0, 0);

        // Connection button — click to switch connection + database (2-step picker)
        lenses.push(new vscode.CodeLens(topRange, {
            title: `$(plug) ${connLabel}`,
            command: 'tsql-intellisense.changeDocDatabase',
            arguments: [document.uri],
            tooltip: 'Click to switch connection and database',
        }));

        // Database button — click to switch database only (same connection)
        lenses.push(new vscode.CodeLens(topRange, {
            title: `$(database) ${dbLabel}`,
            command: 'tsql-intellisense.switchDocDatabase',
            arguments: [document.uri],
            tooltip: 'Click to switch database',
        }));

        // Only add Run + Refresh if there's content
        if (text.trim()) {
            const batchStarts = this.getBatchStartLines(text);

            for (const startLine of batchStarts) {
                const range = new vscode.Range(startLine, 0, startLine, 0);

                // ▷ Run this batch
                lenses.push(new vscode.CodeLens(range, {
                    title: '▷ Run',
                    command: 'tsql-intellisense.runBatchAtLine',
                    arguments: [document.uri, startLine],
                    tooltip: 'Run this batch (up to the next GO)',
                }));

                // $(sync) Refresh cache — only on first batch
                if (startLine === batchStarts[0]) {
                    lenses.push(new vscode.CodeLens(range, {
                        title: '$(sync)',
                        command: 'tsql-intellisense.refreshDocumentCache',
                        arguments: [document.uri],
                        tooltip: 'Refresh schema cache (Ctrl+Shift+D)',
                    }));
                }
            }
        }

        return lenses;
    }

    /** Returns the start line index for each batch (split by GO) */
    private getBatchStartLines(text: string): number[] {
        const lines = text.split('\n');
        const starts: number[] = [0];

        for (let i = 0; i < lines.length; i++) {
            if (/^\s*GO\s*$/i.test(lines[i])) {
                // Next batch starts after this GO line (skip blank lines)
                let next = i + 1;
                while (next < lines.length && !lines[next].trim()) { next++; }
                if (next < lines.length) {
                    starts.push(next);
                }
            }
        }

        return starts;
    }
}
