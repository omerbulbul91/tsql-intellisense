import { Token } from './sqlTokenizer';

export interface LayoutOptions {
    maxLineLength: number;
    placeCommasBeforeItems: boolean;
    alignItemsToTabStops: boolean;
}

const CLAUSE_KEYWORDS = new Set(['SELECT', 'FROM', 'WHERE', 'HAVING']);
const COMPOUND_FIRST = new Set(['ORDER', 'GROUP']);

interface Clause {
    keyword: string;       // e.g. "Select", "Order By"
    keywordLength: number; // display length
    items: string[];       // comma-separated items (trimmed)
    prefix: string;        // e.g. "Distinct", "Top 100" for SELECT
}

interface StatementParts {
    clauses: Clause[];
    suffix: string; // trailing ;, comments, etc.
}

/**
 * Apply layout formatting to token stream.
 * If alignItemsToTabStops is false, tokens are simply joined.
 */
export function applyLayout(tokens: Token[], options: LayoutOptions): string {
    const statements = splitStatements(tokens);
    const results: string[] = [];

    for (const stmt of statements) {
        if (stmt.clauses.length === 0) {
            // No SELECT clauses found — return tokens as-is
            results.push(stmt.suffix);
            continue;
        }

        // Find max keyword length for dynamic padding
        const maxKwLen = Math.max(...stmt.clauses.map(c => c.keywordLength));
        const paddingWidth = options.alignItemsToTabStops ? maxKwLen + 2 : 0;

        const formattedClauses: string[] = [];

        for (const clause of stmt.clauses) {
            const kwPadded = options.alignItemsToTabStops
                ? clause.keyword + ' '.repeat(paddingWidth - clause.keywordLength)
                : clause.keyword + ' ';
            const prefix = clause.prefix ? clause.prefix + ' ' : '';

            if (clause.items.length === 0) {
                formattedClauses.push(kwPadded + prefix);
                continue;
            }

            const lines: string[] = [];
            let currentLine = kwPadded + prefix + clause.items[0];

            for (let i = 1; i < clause.items.length; i++) {
                const item = clause.items[i];
                const separator = ', ';
                const testLine = currentLine + separator + item;

                if (options.maxLineLength > 0 && testLine.length > options.maxLineLength) {
                    // Wrap to new line
                    lines.push(currentLine);
                    if (options.placeCommasBeforeItems) {
                        currentLine = ' '.repeat(paddingWidth - 2) + ', ' + item;
                    } else {
                        // Add trailing comma to previous line
                        lines[lines.length - 1] += ',';
                        currentLine = ' '.repeat(paddingWidth) + item;
                    }
                } else {
                    currentLine = testLine;
                }
            }
            lines.push(currentLine);
            formattedClauses.push(lines.join('\n'));
        }

        let result = formattedClauses.join('\n');
        if (stmt.suffix) {
            result += stmt.suffix;
            // Add newline after statement separator if next statement follows
            if (stmt.suffix === ';') result += '\n';
        }
        results.push(result);
    }

    return results.join('');
}

/**
 * Split token stream into statement parts (clauses + suffix).
 * Handles batches separated by ; and GO.
 */
function splitStatements(tokens: Token[]): StatementParts[] {
    const statements: StatementParts[] = [];
    let currentClauses: Clause[] = [];
    let currentClause: { keyword: string; keywordLength: number; tokens: Token[]; prefix: string } | null = null;
    let depth = 0;
    let i = 0;
    let suffixTokens: Token[] = [];
    let hasSelectClause = false;

    function flushClause() {
        if (currentClause) {
            const items = extractItems(currentClause.tokens);
            currentClauses.push({
                keyword: currentClause.keyword,
                keywordLength: currentClause.keywordLength,
                items,
                prefix: currentClause.prefix,
            });
            currentClause = null;
        }
    }

    function flushStatement(suffix: string) {
        flushClause();
        if (hasSelectClause) {
            statements.push({ clauses: currentClauses, suffix });
        } else {
            // Not a SELECT statement — return as-is
            const raw = currentClauses.length > 0 || suffixTokens.length > 0
                ? rebuildRaw(currentClauses, suffixTokens) + suffix
                : suffix;
            statements.push({ clauses: [], suffix: raw });
        }
        currentClauses = [];
        suffixTokens = [];
        hasSelectClause = false;
    }

    while (i < tokens.length) {
        const t = tokens[i];

        // Track parenthesis depth
        if (t.type === 'punctuation' && t.value === '(') { depth++; i++; if (currentClause) currentClause.tokens.push(t); else suffixTokens.push(t); continue; }
        if (t.type === 'punctuation' && t.value === ')') { depth = Math.max(0, depth - 1); i++; if (currentClause) currentClause.tokens.push(t); else suffixTokens.push(t); continue; }

        // Statement separator
        if (depth === 0 && t.type === 'punctuation' && t.value === ';') {
            flushStatement(';');
            i++;
            continue;
        }
        if (depth === 0 && t.type === 'keyword' && t.value.toUpperCase() === 'GO') {
            flushStatement('');
            // GO itself becomes a separate "statement"
            statements.push({ clauses: [], suffix: t.value });
            i++;
            // Skip whitespace after GO
            while (i < tokens.length && tokens[i].type === 'whitespace') {
                statements[statements.length - 1].suffix += tokens[i].value;
                i++;
            }
            continue;
        }

        // Clause keyword detection (depth=0 only)
        if (depth === 0 && t.type === 'keyword') {
            const upper = t.value.toUpperCase();

            // Compound: ORDER BY, GROUP BY
            if (COMPOUND_FIRST.has(upper)) {
                const byIdx = findNextNonTrivial(tokens, i + 1);
                if (byIdx !== -1 && tokens[byIdx].type === 'keyword' && tokens[byIdx].value.toUpperCase() === 'BY') {
                    flushClause();
                    const kw = t.value + ' ' + tokens[byIdx].value;
                    currentClause = { keyword: kw, keywordLength: kw.length, tokens: [], prefix: '' };
                    i = byIdx + 1;
                    continue;
                }
            }

            if (CLAUSE_KEYWORDS.has(upper)) {
                flushClause();
                if (upper === 'SELECT') hasSelectClause = true;

                currentClause = { keyword: t.value, keywordLength: t.value.length, tokens: [], prefix: '' };
                i++;

                // Handle SELECT DISTINCT / SELECT TOP N
                if (upper === 'SELECT') {
                    i = parseSelectPrefix(tokens, i, currentClause);
                }
                continue;
            }
        }

        // Regular token — add to current clause or suffix
        if (currentClause) {
            currentClause.tokens.push(t);
        } else {
            suffixTokens.push(t);
        }
        i++;
    }

    // Flush remaining
    flushStatement('');

    return statements;
}

/**
 * Parse SELECT prefix tokens: DISTINCT, TOP N
 */
function parseSelectPrefix(tokens: Token[], i: number, clause: { tokens: Token[]; prefix: string }): number {
    // Skip whitespace
    while (i < tokens.length && tokens[i].type === 'whitespace') i++;

    if (i >= tokens.length) return i;

    const upper = tokens[i].value.toUpperCase();

    // DISTINCT
    if (tokens[i].type === 'keyword' && upper === 'DISTINCT') {
        clause.prefix = tokens[i].value;
        i++;
        while (i < tokens.length && tokens[i].type === 'whitespace') i++;

        // DISTINCT TOP N
        if (i < tokens.length && tokens[i].type === 'keyword' && tokens[i].value.toUpperCase() === 'TOP') {
            return parseTopN(tokens, i, clause, clause.prefix + ' ');
        }
        return i;
    }

    // TOP N
    if (tokens[i].type === 'keyword' && upper === 'TOP') {
        return parseTopN(tokens, i, clause, '');
    }

    return i;
}

function parseTopN(tokens: Token[], i: number, clause: { tokens: Token[]; prefix: string }, prefixSoFar: string): number {
    let topStr = tokens[i].value;
    i++;
    while (i < tokens.length && tokens[i].type === 'whitespace') i++;
    // Number or parenthesized expression
    if (i < tokens.length && tokens[i].type === 'number') {
        topStr += ' ' + tokens[i].value;
        i++;
    } else if (i < tokens.length && tokens[i].type === 'punctuation' && tokens[i].value === '(') {
        // TOP (expr)
        topStr += ' (';
        i++;
        let d = 1;
        while (i < tokens.length && d > 0) {
            if (tokens[i].value === '(') d++;
            if (tokens[i].value === ')') d--;
            if (d > 0) topStr += tokens[i].value;
            i++;
        }
        topStr += ')';
    }
    while (i < tokens.length && tokens[i].type === 'whitespace') i++;
    // PERCENT
    if (i < tokens.length && tokens[i].type === 'keyword' && tokens[i].value.toUpperCase() === 'PERCENT') {
        topStr += ' ' + tokens[i].value;
        i++;
        while (i < tokens.length && tokens[i].type === 'whitespace') i++;
    }
    clause.prefix = prefixSoFar + topStr;
    return i;
}

/**
 * Find next non-whitespace, non-comment token index.
 */
function findNextNonTrivial(tokens: Token[], from: number): number {
    for (let j = from; j < tokens.length; j++) {
        if (tokens[j].type !== 'whitespace' && tokens[j].type !== 'comment') {
            return j;
        }
    }
    return -1;
}

/**
 * Extract comma-separated items from clause tokens.
 * Only splits on depth=0 commas.
 */
function extractItems(tokens: Token[]): string[] {
    const items: string[] = [];
    let current: Token[] = [];
    let depth = 0;

    for (const t of tokens) {
        if (t.type === 'punctuation' && t.value === '(') depth++;
        if (t.type === 'punctuation' && t.value === ')') depth = Math.max(0, depth - 1);

        if (depth === 0 && t.type === 'punctuation' && t.value === ',') {
            items.push(trimTokens(current));
            current = [];
        } else {
            current.push(t);
        }
    }

    if (current.length > 0) {
        const trimmed = trimTokens(current);
        if (trimmed) items.push(trimmed);
    }

    return items;
}

/**
 * Trim and normalize whitespace in token group → single string.
 */
function trimTokens(tokens: Token[]): string {
    // Remove leading/trailing whitespace tokens
    let start = 0;
    while (start < tokens.length && tokens[start].type === 'whitespace') start++;
    let end = tokens.length - 1;
    while (end >= start && tokens[end].type === 'whitespace') end--;

    if (start > end) return '';

    const parts: string[] = [];
    for (let i = start; i <= end; i++) {
        if (tokens[i].type === 'whitespace') {
            parts.push(' '); // normalize to single space
        } else {
            parts.push(tokens[i].value);
        }
    }
    return parts.join('');
}

/**
 * Rebuild raw text from clauses that were not SELECT statements.
 */
function rebuildRaw(clauses: Clause[], suffixTokens: Token[]): string {
    let result = '';
    for (const c of clauses) {
        result += c.keyword;
        if (c.prefix) result += ' ' + c.prefix;
        if (c.items.length > 0) result += ' ' + c.items.join(', ');
    }
    for (const t of suffixTokens) {
        result += t.value;
    }
    return result;
}
