import * as vscode from 'vscode';
import { getCurrentStatement, extractAliases } from '../parser/sqlContext';

export class TsqlRenameProvider implements vscode.RenameProvider {

    provideRenameEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        newName: string,
        _token: vscode.CancellationToken
    ): vscode.WorkspaceEdit | undefined {
        const result = this.getAliasAtPosition(document, position);
        if (!result) { return undefined; }

        const { alias: oldName } = result;
        const fullText = document.getText();
        const offset = document.offsetAt(position);
        const statement = getCurrentStatement(fullText, offset);
        const statementStart = fullText.indexOf(statement);

        const edit = new vscode.WorkspaceEdit();

        // Find all occurrences of the alias in the statement
        // Match as standalone word (word boundary) — handles both "k" alone and "k.Column"
        const regex = new RegExp(`\\b${this.escapeRegex(oldName)}\\b`, 'gi');
        let match;
        while ((match = regex.exec(statement)) !== null) {
            const absOffset = statementStart + match.index;
            const startPos = document.positionAt(absOffset);
            const endPos = document.positionAt(absOffset + oldName.length);
            edit.replace(document.uri, new vscode.Range(startPos, endPos), newName);
        }

        return edit;
    }

    prepareRename(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): { range: vscode.Range; placeholder: string } {
        const result = this.getAliasAtPosition(document, position);
        if (!result) {
            throw new Error('Rename only works on table aliases');
        }

        return {
            range: result.range,
            placeholder: result.alias,
        };
    }

    /** Check if cursor is on a known alias — works on definition site AND usage sites (alias.Column) */
    private getAliasAtPosition(document: vscode.TextDocument, position: vscode.Position): { alias: string; range: vscode.Range } | undefined {
        // Use VS Code's built-in word detection
        const wordRange = document.getWordRangeAtPosition(position, /\w+/);
        if (!wordRange) { return undefined; }

        const word = document.getText(wordRange);

        // Get current statement and extract all aliases
        const fullText = document.getText();
        const offset = document.offsetAt(position);
        const statement = getCurrentStatement(fullText, offset);
        const aliases = extractAliases(statement);

        // Check if the word under cursor is a known alias
        const match = aliases.find(a => a.alias.toLowerCase() === word.toLowerCase());
        if (match) {
            return { alias: match.alias, range: wordRange };
        }

        return undefined;
    }

    private escapeRegex(s: string): string {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}
