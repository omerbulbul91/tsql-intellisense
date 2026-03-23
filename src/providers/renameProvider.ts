import * as vscode from 'vscode';
import { getCurrentStatement, extractAliases } from '../parser/sqlContext';

export class TsqlRenameProvider implements vscode.RenameProvider {

    provideRenameEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        newName: string,
        _token: vscode.CancellationToken
    ): vscode.WorkspaceEdit | undefined {
        const result = this.getRenameTarget(document, position);
        if (!result) { return undefined; }

        const { name: oldName, kind } = result;
        const fullText = document.getText();
        const edit = new vscode.WorkspaceEdit();

        if (kind === 'parameter') {
            // Parameters: rename across the entire document
            // Ensure newName starts with @
            const newParam = newName.startsWith('@') ? newName : '@' + newName;
            const regex = new RegExp(`${this.escapeRegex(oldName)}\\b`, 'gi');
            let match;
            while ((match = regex.exec(fullText)) !== null) {
                const startPos = document.positionAt(match.index);
                const endPos = document.positionAt(match.index + oldName.length);
                edit.replace(document.uri, new vscode.Range(startPos, endPos), newParam);
            }
        } else {
            // Aliases: rename within current statement
            const offset = document.offsetAt(position);
            const statement = getCurrentStatement(fullText, offset);
            const statementStart = fullText.indexOf(statement);

            // Find table name positions in FROM/JOIN clauses to exclude from rename
            const tableNamePositions = new Set<number>();
            const fromJoinRegex = /(?:FROM|(?:INNER|LEFT|RIGHT|CROSS|FULL)\s+(?:OUTER\s+)?JOIN|JOIN)\s+(?:dbo\.)?(\[?\w+\]?)\s+/gi;
            let fjMatch;
            while ((fjMatch = fromJoinRegex.exec(statement)) !== null) {
                const tableNameInMatch = fjMatch[1];
                const tableNameStart = fjMatch.index + fjMatch[0].indexOf(tableNameInMatch);
                tableNamePositions.add(tableNameStart);
            }

            const regex = new RegExp(`\\b${this.escapeRegex(oldName)}\\b`, 'gi');
            let match;
            while ((match = regex.exec(statement)) !== null) {
                // Skip table name positions (only rename alias, not the table itself)
                if (tableNamePositions.has(match.index)) {
                    continue;
                }
                const absOffset = statementStart + match.index;
                const startPos = document.positionAt(absOffset);
                const endPos = document.positionAt(absOffset + oldName.length);
                edit.replace(document.uri, new vscode.Range(startPos, endPos), newName);
            }
        }

        return edit;
    }

    prepareRename(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): { range: vscode.Range; placeholder: string } {
        const result = this.getRenameTarget(document, position);
        if (!result) {
            throw new Error('Rename only works on table aliases and parameters');
        }

        return {
            range: result.range,
            placeholder: result.name,
        };
    }

    /** Check if cursor is on a known alias or parameter */
    private getRenameTarget(document: vscode.TextDocument, position: vscode.Position): { name: string; range: vscode.Range; kind: 'alias' | 'parameter' } | undefined {
        // Check for parameter (@word) first
        const paramRange = document.getWordRangeAtPosition(position, /@\w+/);
        if (paramRange) {
            const param = document.getText(paramRange);
            return { name: param, range: paramRange, kind: 'parameter' };
        }

        // Use VS Code's built-in word detection for aliases
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
            return { name: match.alias, range: wordRange, kind: 'alias' };
        }

        return undefined;
    }

    private escapeRegex(s: string): string {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}
