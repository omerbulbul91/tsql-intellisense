import { Token } from './sqlTokenizer';

export interface JoinOptions {
    placeOnNewLine: boolean;          // ON aynı satırda mı
    placeConditionOnNewLine: boolean; // ON condition yeni satırda mı
    conditionAlignment: 'toTable' | 'toInner' | 'indented'; // condition hizalama
}

export interface LayoutOptions {
    maxLineLength: number;
    placeCommasBeforeItems: boolean;
    alignItemsToTabStops: boolean;
    join?: JoinOptions;
}

const CLAUSE_KEYWORDS = new Set(['SELECT', 'FROM', 'WHERE', 'HAVING']);
const COMPOUND_FIRST = new Set(['ORDER', 'GROUP']);
const JOIN_KEYWORDS = new Set(['INNER', 'LEFT', 'RIGHT', 'CROSS', 'FULL']);

interface Clause {
    keyword: string;       // e.g. "Select", "Order By"
    keywordLength: number; // display length
    items: string[];       // comma-separated items (trimmed)
    prefix: string;        // e.g. "Distinct", "Top 100" for SELECT
    rawTokens: Token[];    // raw tokens for this clause's content
}

interface StatementParts {
    clauses: Clause[];
    prefix: string; // tokens before SELECT (e.g. CREATE OR ALTER VIEW ... AS)
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
            results.push(stmt.prefix + stmt.suffix);
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

            // FROM clause with JOINs — special handling
            if (clause.keyword.toUpperCase() === 'FROM' && options.join && hasJoinTokens(clause.rawTokens)) {
                formattedClauses.push(formatFromWithJoins(clause, kwPadded, paddingWidth, options));
                continue;
            }

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

        let result = stmt.prefix + formattedClauses.join('\n');
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
                rawTokens: [...currentClause.tokens],
            });
            currentClause = null;
        }
    }

    function flushStatement(suffix: string) {
        flushClause();
        // Build prefix from tokens before the first clause (e.g. CREATE OR ALTER VIEW ... AS)
        let prefixStr = suffixTokens.map(t => t.value).join('');
        // If prefix ends with whitespace, replace with newline (SELECT starts on new line)
        if (prefixStr && hasSelectClause) {
            prefixStr = prefixStr.replace(/\s+$/, '\n');
        }
        if (hasSelectClause) {
            statements.push({ clauses: currentClauses, prefix: prefixStr, suffix });
        } else {
            // Not a SELECT statement — return as-is
            const raw = currentClauses.length > 0
                ? prefixStr + rebuildRaw(currentClauses, []) + suffix
                : prefixStr + suffix;
            statements.push({ clauses: [], prefix: '', suffix: raw });
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
            // Skip whitespace after ; (will be replaced by \n in output)
            while (i < tokens.length && tokens[i].type === 'whitespace') i++;
            continue;
        }
        if (depth === 0 && t.type === 'keyword' && t.value.toUpperCase() === 'GO') {
            flushStatement('');
            // GO itself becomes a separate "statement" with newline prefix
            statements.push({ clauses: [], prefix: '\n', suffix: t.value });
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

// ─── JOIN formatting helpers ───

function hasJoinTokens(tokens: Token[]): boolean {
    return tokens.some(t => t.type === 'keyword' && (JOIN_KEYWORDS.has(t.value.toUpperCase()) || t.value.toUpperCase() === 'JOIN'));
}

interface JoinPart {
    joinKeyword: string;  // "Inner Join", "Left Join", "Left Outer Join", etc.
    table: string;        // table name + alias
    onKeyword: string;    // "On"
    condition: string;    // join condition
}

/**
 * Format FROM clause with JOINs.
 * Splits: FROM table alias \n JOIN table alias ON \n condition
 */
function formatFromWithJoins(clause: Clause, kwPadded: string, paddingWidth: number, options: LayoutOptions): string {
    const joinOpts = options.join!;
    const parts = parseJoinParts(clause.rawTokens);

    if (parts.length === 0) {
        // No joins found, fall back to simple format
        return kwPadded + clause.items.join(', ');
    }

    const joinIndent = ' '.repeat(paddingWidth);
    const lines: string[] = [];

    // First part: FROM table
    lines.push(kwPadded + parts[0].table);

    // Each JOIN
    for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        const joinLine = joinIndent + p.joinKeyword + ' ' + p.table;

        if (p.onKeyword && p.condition) {
            if (joinOpts.placeConditionOnNewLine) {
                // ON on same line, condition on next line
                lines.push(joinLine + ' ' + p.onKeyword);
                // Condition aligned to table start
                const condIndent = joinIndent + ' '.repeat(p.joinKeyword.length + 1);
                lines.push(condIndent + p.condition);
            } else {
                // Everything on one line
                lines.push(joinLine + ' ' + p.onKeyword + ' ' + p.condition);
            }
        } else {
            // CROSS JOIN (no ON)
            lines.push(joinLine);
        }
    }

    return lines.join('\n');
}

function parseJoinParts(tokens: Token[]): JoinPart[] {
    const parts: JoinPart[] = [];
    let i = 0;
    const len = tokens.length;

    // Skip leading whitespace
    while (i < len && tokens[i].type === 'whitespace') i++;

    // First part: the FROM table (everything before first JOIN keyword)
    let tableTokens: Token[] = [];
    while (i < len) {
        const upper = tokens[i].type === 'keyword' ? tokens[i].value.toUpperCase() : '';
        if (JOIN_KEYWORDS.has(upper) || upper === 'JOIN') break;
        tableTokens.push(tokens[i]);
        i++;
    }
    parts.push({
        joinKeyword: '',
        table: trimTokens(tableTokens),
        onKeyword: '',
        condition: '',
    });

    // Parse each JOIN
    while (i < len) {
        const upper = tokens[i].type === 'keyword' ? tokens[i].value.toUpperCase() : '';
        if (!JOIN_KEYWORDS.has(upper) && upper !== 'JOIN') { i++; continue; }

        // Collect JOIN keyword parts: INNER JOIN, LEFT OUTER JOIN, etc.
        let joinKw = tokens[i].value;
        i++;
        while (i < len && tokens[i].type === 'whitespace') i++;

        // Check for OUTER or JOIN
        if (i < len && tokens[i].type === 'keyword') {
            const next = tokens[i].value.toUpperCase();
            if (next === 'OUTER') {
                joinKw += ' ' + tokens[i].value;
                i++;
                while (i < len && tokens[i].type === 'whitespace') i++;
            }
            if (i < len && tokens[i].type === 'keyword' && tokens[i].value.toUpperCase() === 'JOIN') {
                joinKw += ' ' + tokens[i].value;
                i++;
            }
        }

        while (i < len && tokens[i].type === 'whitespace') i++;

        // Collect table + alias (until ON or next JOIN)
        tableTokens = [];
        let onKeyword = '';
        let condition = '';
        let depth = 0;

        while (i < len) {
            if (tokens[i].type === 'punctuation' && tokens[i].value === '(') depth++;
            if (tokens[i].type === 'punctuation' && tokens[i].value === ')') depth = Math.max(0, depth - 1);

            if (depth === 0 && tokens[i].type === 'keyword') {
                const kw = tokens[i].value.toUpperCase();
                if (kw === 'ON') {
                    onKeyword = tokens[i].value;
                    i++;
                    // Collect condition (until next JOIN or end)
                    const condTokens: Token[] = [];
                    while (i < len) {
                        if (tokens[i].type === 'punctuation' && tokens[i].value === '(') depth++;
                        if (tokens[i].type === 'punctuation' && tokens[i].value === ')') depth = Math.max(0, depth - 1);
                        if (depth === 0 && tokens[i].type === 'keyword') {
                            const ck = tokens[i].value.toUpperCase();
                            if (JOIN_KEYWORDS.has(ck) || ck === 'JOIN') break;
                        }
                        condTokens.push(tokens[i]);
                        i++;
                    }
                    condition = trimTokens(condTokens);
                    break;
                }
                if (JOIN_KEYWORDS.has(kw) || kw === 'JOIN') break;
            }
            tableTokens.push(tokens[i]);
            i++;
        }

        parts.push({
            joinKeyword: joinKw,
            table: trimTokens(tableTokens),
            onKeyword,
            condition,
        });
    }

    return parts;
}
