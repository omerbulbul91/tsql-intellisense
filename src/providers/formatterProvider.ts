import * as vscode from 'vscode';
import { SqlFormatter } from '../formatter/sqlFormatter';
import { StyleLoader } from '../formatter/styleLoader';

export class FormatterProvider implements vscode.DocumentFormattingEditProvider, vscode.DocumentRangeFormattingEditProvider {
    private formatter: SqlFormatter;

    constructor(private styleLoader: StyleLoader) {
        this.formatter = new SqlFormatter(styleLoader);
    }

    provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
        );
        const formatted = this.formatter.format(document.getText());
        return [vscode.TextEdit.replace(fullRange, formatted)];
    }

    provideDocumentRangeFormattingEdits(document: vscode.TextDocument, range: vscode.Range): vscode.TextEdit[] {
        const text = document.getText(range);
        const formatted = this.formatter.format(text);
        return [vscode.TextEdit.replace(range, formatted)];
    }

    formatActiveEditor(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const document = editor.document;
        const selection = editor.selection;

        editor.edit(editBuilder => {
            if (selection.isEmpty) {
                const fullRange = new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(document.getText().length)
                );
                const formatted = this.formatter.format(document.getText());
                editBuilder.replace(fullRange, formatted);
            } else {
                const text = document.getText(selection);
                const formatted = this.formatter.format(text);
                editBuilder.replace(selection, formatted);
            }
        });
    }
}
