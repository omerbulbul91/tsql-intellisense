import { tokenize, Token } from './sqlTokenizer';
import { applyCasingInPlace } from './casingRule';
import { applyLayout } from './layoutRule';
import { applyCaseFormatting } from './caseRule';
import { applyStatementFormatting } from './statementRule';
import { StyleLoader } from './styleLoader';

export class SqlFormatter {
    constructor(private styleLoader: StyleLoader) {}

    format(sql: string): string {
        const tokens = tokenize(sql);
        applyCasingInPlace(tokens, this.styleLoader.getCasingOptions());
        // ALTER PROCEDURE/VIEW/FUNCTION/TRIGGER → CREATE OR ALTER
        SqlFormatter.applyCreateOrAlter(tokens);

        // Ensure spaces around = operator and after commas
        SqlFormatter.applySpacing(tokens);

        // Add dbo. prefix to EXEC/EXECUTE SP names
        if (this.styleLoader.getLayoutOptions().qualifyObjectNames) {
            SqlFormatter.qualifyExecCalls(tokens);
        }

        const isSP = SqlFormatter.isStoredProcedure(tokens);

        // Statement formatting (separation + indentation + detail)
        const statementResult = applyStatementFormatting(
            tokens,
            this.styleLoader.getWhitespaceOptions(),
            this.styleLoader.getControlFlowOptions(),
            this.styleLoader.getVariablesOptions(),
        );

        // Re-tokenize for layout (SELECT clause formatting)
        const layoutTokens = tokenize(statementResult);
        const layoutResult = applyLayout(layoutTokens, this.styleLoader.getLayoutOptions());
        // Re-tokenize for CASE formatting
        const casedTokens = tokenize(layoutResult);
        let result = applyCaseFormatting(layoutResult, this.styleLoader.getCaseOptions(), casedTokens);

        // Append Go at end of stored procedure if missing
        if (isSP) {
            const trimmed = result.trimEnd();
            const lastLine = trimmed.split('\n').pop()?.trim().toUpperCase() || '';
            if (lastLine !== 'GO') {
                result = trimmed + '\nGo\n';
            }
        }

        return result;
    }

    /**
     * Check if the token stream represents a stored procedure definition.
     */
    private static isStoredProcedure(tokens: Token[]): boolean {
        let count = 0;
        for (const t of tokens) {
            if (t.type === 'whitespace' || t.type === 'comment') continue;
            const upper = t.value.toUpperCase();
            if (count === 0 && !upper.includes('CREATE') && !upper.includes('ALTER')) return false;
            if (upper === 'PROC' || upper === 'PROCEDURE') return true;
            count++;
            if (count > 5) break;
        }
        return false;
    }

    /**
     * Ensure spaces around = operator and after commas (outside strings/comments).
     */
    private static applySpacing(tokens: Token[]): void {
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            // Space around = operator (skip compound: <=, >=, <>, !=, +=)
            if (t.type === 'operator' && t.value === '=') {
                // Check prev is not part of compound operator
                const prev = i > 0 ? tokens[i - 1] : null;
                if (prev && prev.type === 'operator') continue; // <=, >=, != etc.
                // Ensure space before =
                if (prev && prev.type !== 'whitespace') {
                    tokens.splice(i, 0, { type: 'whitespace', value: ' ', offset: -1 });
                    i++; // adjust for inserted token
                }
                // Ensure space after =
                const next = i + 1 < tokens.length ? tokens[i + 1] : null;
                if (next && next.type !== 'whitespace') {
                    tokens.splice(i + 1, 0, { type: 'whitespace', value: ' ', offset: -1 });
                }
            }
            // Space after comma (inside parentheses — function calls)
            if (t.type === 'punctuation' && t.value === ',') {
                const next = i + 1 < tokens.length ? tokens[i + 1] : null;
                if (next && next.type !== 'whitespace') {
                    tokens.splice(i + 1, 0, { type: 'whitespace', value: ' ', offset: -1 });
                }
            }
        }
    }

    /**
     * Add dbo. prefix to unqualified SP names in EXEC/EXECUTE calls.
     */
    private static qualifyExecCalls(tokens: Token[]): void {
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            if (t.type !== 'keyword') continue;
            const upper = t.value.toUpperCase();
            if (upper !== 'EXEC' && upper !== 'EXECUTE') continue;
            // Find next non-whitespace token (the SP name)
            let j = i + 1;
            while (j < tokens.length && tokens[j].type === 'whitespace') j++;
            if (j >= tokens.length) continue;
            const name = tokens[j];
            if (name.type !== 'identifier') continue;
            // Check if already qualified (next token is dot)
            if (name.value.includes('.')) continue;
            const afterName = j + 1 < tokens.length ? tokens[j + 1] : null;
            if (afterName && afterName.type === 'punctuation' && afterName.value === '.') continue;
            // Add dbo. prefix
            name.value = 'dbo.' + name.value;
        }
    }

    /**
     * Convert ALTER PROCEDURE/VIEW/FUNCTION/TRIGGER to CREATE OR ALTER.
     * Skips ALTER TABLE, ALTER INDEX, etc.
     */
    private static applyCreateOrAlter(tokens: Token[]): void {
        const createOrAlterTargets = new Set(['PROCEDURE', 'PROC', 'VIEW', 'FUNCTION', 'TRIGGER']);
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            if (t.type !== 'keyword' || t.value.toUpperCase() !== 'ALTER') continue;
            // Skip if already preceded by CREATE OR
            let p = i - 1;
            while (p >= 0 && tokens[p].type === 'whitespace') p--;
            if (p >= 0 && tokens[p].type === 'keyword' && tokens[p].value.toUpperCase() === 'OR') {
                let p2 = p - 1;
                while (p2 >= 0 && tokens[p2].type === 'whitespace') p2--;
                if (p2 >= 0 && tokens[p2].type === 'keyword' && tokens[p2].value.toUpperCase() === 'CREATE') continue;
            }
            // Find next non-whitespace token
            let j = i + 1;
            while (j < tokens.length && tokens[j].type === 'whitespace') j++;
            if (j >= tokens.length) continue;
            const next = tokens[j];
            if (next.type !== 'keyword' || !createOrAlterTargets.has(next.value.toUpperCase())) continue;
            // Replace ALTER with CREATE OR ALTER (preserve casing style)
            const isUpper = t.value === t.value.toUpperCase();
            const isCamel = t.value[0] === t.value[0].toUpperCase() && t.value.slice(1) !== t.value.slice(1).toUpperCase();
            if (isUpper) {
                t.value = 'CREATE OR ALTER';
            } else if (isCamel) {
                t.value = 'Create Or Alter';
            } else {
                t.value = 'create or alter';
            }
        }
    }
}
