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
        if (!text.trim()) { return []; }

        const docDb = this.queryRunner.getDocumentDatabase(document.uri);
        const serverLabel = docDb
            ? `$(server) ${docDb.profileName}  $(database) ${docDb.dbName}`
            : '$(database) No DB associated';

        const lenses: vscode.CodeLens[] = [];
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

            // Server / DB info (clickable to change DB for this file)
            lenses.push(new vscode.CodeLens(range, {
                title: serverLabel,
                command: 'tsql-intellisense.changeDocDatabase',
                arguments: [document.uri],
                tooltip: 'Click to change the database for this file',
            }));

            // $(sync) Refresh cache for this file's DB
            lenses.push(new vscode.CodeLens(range, {
                title: '$(sync)',
                command: 'tsql-intellisense.refreshDocumentCache',
                arguments: [document.uri],
                tooltip: 'Refresh schema cache for this file\'s database (Ctrl+Shift+D)',
            }));
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
