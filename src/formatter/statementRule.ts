import { Token } from './sqlTokenizer';
import { WhitespaceOptions, ControlFlowOptions, VariablesOptions } from './styleLoader';

// ─── Statement-starting keywords ───

const STATEMENT_STARTERS = new Set([
    'SET', 'IF', 'ELSE', 'WHILE', 'PRINT', 'EXEC', 'EXECUTE',
    'DECLARE', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE',
    'RETURN', 'THROW', 'RAISERROR', 'BEGIN', 'END',
    'GO', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
    'GRANT', 'DENY', 'REVOKE', 'USE', 'WAITFOR', 'WITH',
    'OPEN', 'CLOSE', 'FETCH', 'DEALLOCATE',
    'COMMIT', 'ROLLBACK', 'BREAK', 'CONTINUE', 'SAVE',
]);

// Keywords that continue a SELECT/DML clause chain (not new statements)
const SELECT_CONTINUATIONS = new Set([
    'FROM', 'WHERE', 'HAVING', 'ORDER', 'GROUP', 'ON', 'INTO',
]);

/**
 * Main entry point: apply statement formatting (separation + indentation + detail).
 * Receives Token[], returns formatted string.
 */
export function applyStatementFormatting(
    tokens: Token[],
    ws: WhitespaceOptions,
    cf: ControlFlowOptions,
    vars: VariablesOptions,
): string {
    // Phase 1: Statement separation — insert newlines between statements
    const separated = separateStatements(tokens, ws);
    // Phase 2: Block indentation — indent based on BEGIN/END depth
    const indented = applyBlockIndentation(separated, ws, cf);
    // Phase 3: Detail formatting — EXEC wrapping, DECLARE alignment, string concat
    const detailed = applyDetailFormatting(indented, ws, vars);
    return detailed;
}

// ─── Phase 1: Statement Separation ───

function separateStatements(tokens: Token[], ws: WhitespaceOptions): string {
    const parts: string[] = [];
    let depth = 0; // parenthesis depth
    let inSelectChain = false;
    let inUpdateChain = false;
    let seenNewlineSinceLastToken = false; // track whether there was a newline before current token

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];

        // Track parenthesis depth
        if (t.type === 'punctuation' && t.value === '(') depth++;
        if (t.type === 'punctuation' && t.value === ')') depth = Math.max(0, depth - 1);

        // Semicolon: push it and break chains (next keyword will get newline via STATEMENT_STARTERS)
        if (depth === 0 && t.type === 'punctuation' && t.value === ';') {
            parts.push(t.value);
            inSelectChain = false;
            inUpdateChain = false;
            seenNewlineSinceLastToken = false;
            continue;
        }

        // Track newlines in whitespace (before processing keywords)
        if (t.type === 'whitespace') {
            if (t.value.includes('\n')) {
                seenNewlineSinceLastToken = true;
                parts.push('\n');
            } else {
                // Collapse multiple spaces to single space
                parts.push(' ');
            }
            continue;
        }

        // Only detect boundaries at depth 0, outside strings/comments
        if (depth === 0 && t.type === 'keyword') {
            const upper = t.value.toUpperCase();

            // Track SELECT chain context
            if (upper === 'SELECT' || upper === 'INSERT' || upper === 'DELETE') {
                inSelectChain = true;
                inUpdateChain = false;
            }
            if (upper === 'UPDATE') {
                inUpdateChain = true;
                inSelectChain = false;
            }

            // Check if this is a continuation of SELECT/DML chain
            if (inSelectChain && SELECT_CONTINUATIONS.has(upper)) {
                parts.push(t.value);
                seenNewlineSinceLastToken = false;
                continue;
            }

            // UPDATE ... SET is continuation
            if (upper === 'SET' && inUpdateChain) {
                parts.push(t.value);
                seenNewlineSinceLastToken = false;
                continue;
            }

            // Compound: BEGIN TRY, BEGIN CATCH, END TRY, END CATCH
            if ((upper === 'BEGIN' || upper === 'END')) {
                let j = i + 1;
                while (j < tokens.length && tokens[j].type === 'whitespace') j++;
                if (j < tokens.length && tokens[j].type === 'keyword') {
                    const nextUpper = tokens[j].value.toUpperCase();
                    if (nextUpper === 'TRY' || nextUpper === 'CATCH') {
                        inSelectChain = false;
                        inUpdateChain = false;
                        if (parts.length > 0 && !endsWithNewline(parts)) {
                            parts.push('\n');
                        }
                        // Push BEGIN/END + whitespace + TRY/CATCH as one unit
                        parts.push(t.value);
                        for (let k = i + 1; k <= j; k++) {
                            parts.push(tokens[k].value);
                        }
                        i = j;
                        seenNewlineSinceLastToken = false;
                        continue;
                    }
                }
            }

            // BEGIN on same line as IF/WHILE/ELSE → keep together (don't separate)
            if (upper === 'BEGIN' && !seenNewlineSinceLastToken) {
                // Whitespace before BEGIN was already pushed — just push BEGIN
                parts.push(t.value);
                seenNewlineSinceLastToken = false;
                continue;
            }

            // GO — batch separator
            if (upper === 'GO') {
                inSelectChain = false;
                inUpdateChain = false;
                if (parts.length > 0 && !endsWithNewline(parts)) {
                    parts.push('\n');
                }
                parts.push(t.value);
                const emptyLines = '\n'.repeat(ws.emptyLinesAfterBatchSeparator + 1);
                parts.push(emptyLines);
                while (i + 1 < tokens.length && tokens[i + 1].type === 'whitespace') i++;
                seenNewlineSinceLastToken = false;
                continue;
            }

            // ALTER inside CREATE OR ALTER → not a separate statement
            if (upper === 'ALTER') {
                let pi = i - 1;
                while (pi >= 0 && tokens[pi].type === 'whitespace') pi--;
                if (pi >= 0 && tokens[pi].type === 'keyword' && tokens[pi].value.toUpperCase() === 'OR') {
                    let pi2 = pi - 1;
                    while (pi2 >= 0 && tokens[pi2].type === 'whitespace') pi2--;
                    if (pi2 >= 0 && tokens[pi2].type === 'keyword' && tokens[pi2].value.toUpperCase() === 'CREATE') {
                        parts.push(t.value);
                        seenNewlineSinceLastToken = false;
                        continue;
                    }
                }
            }

            // Statement starter detected
            if (STATEMENT_STARTERS.has(upper)) {
                // These break the SELECT/DML chain
                if (!SELECT_CONTINUATIONS.has(upper) && upper !== 'SET') {
                    if (upper !== 'SELECT' && upper !== 'INSERT' && upper !== 'DELETE' && upper !== 'UPDATE') {
                        inSelectChain = false;
                        inUpdateChain = false;
                    }
                }

                // Insert newline before this statement if not at start
                if (parts.length > 0 && !endsWithNewline(parts)) {
                    parts.push('\n');
                }
                // Skip leading whitespace (will be replaced by newline)
                if (i > 0 && parts.length > 0) {
                    // Remove trailing whitespace from last part
                    while (parts.length > 0 && parts[parts.length - 1].match(/^[ \t]+$/)) {
                        parts.pop();
                    }
                }
            }
        }

        parts.push(t.value);
        // Comments with newlines should signal newline presence for BEGIN detection
        if (t.type === 'comment' && t.value.includes('\n')) {
            seenNewlineSinceLastToken = true;
        } else {
            seenNewlineSinceLastToken = false;
        }
    }

    return parts.join('');
}

function endsWithNewline(parts: string[]): boolean {
    for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p.trim() === '') {
            if (p.includes('\n')) return true;
            continue;
        }
        return p.endsWith('\n');
    }
    return true; // empty = start of file
}

// ─── Phase 2: Block Indentation ───

// Statement-starting keywords used for empty line insertion between statements
const SAME_DEPTH_STARTERS = new Set([
    'SET', 'IF', 'WHILE', 'PRINT', 'EXEC', 'EXECUTE',
    'DECLARE', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE',
    'RETURN', 'THROW', 'RAISERROR',
    'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
    'GRANT', 'DENY', 'REVOKE', 'USE', 'WAITFOR',
    'OPEN', 'CLOSE', 'FETCH', 'DEALLOCATE',
    'COMMIT', 'ROLLBACK', 'BREAK', 'CONTINUE', 'SAVE',
]);

function applyBlockIndentation(text: string, ws: WhitespaceOptions, cf: ControlFlowOptions): string {
    const indentSize = ws.numberOfSpacesInTabs;
    const lines = text.split('\n');
    const result: string[] = [];
    const lineDepths: number[] = [];
    let depth = 0;
    let pendingSingleIndent = false;

    let inBlockComment = false;
    let inProcParams = false; // between PROC name and AS

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) { result.push(''); lineDepths.push(-1); continue; }

        // Track block comments (/* ... */)
        if (trimmed.startsWith('/*')) inBlockComment = true;
        const isComment = inBlockComment || trimmed.startsWith('--');
        if (trimmed.endsWith('*/')) inBlockComment = false;

        // Comment lines: apply current depth but don't affect depth tracking
        if (isComment) {
            let lineDepth = depth;
            if (pendingSingleIndent) lineDepth = depth + 1;
            // Inside block comment: indent content lines relative to /* delimiter
            if (inBlockComment && !trimmed.startsWith('/*') && !trimmed.startsWith('*/')) {
                lineDepth = depth + 1;
            }
            const indent = ' '.repeat(lineDepth * indentSize);
            result.push(indent + trimmed);
            lineDepths.push(lineDepth);
            continue; // skip BEGIN/END/IF checks
        }

        const upperTrimmed = trimmed.toUpperCase();
        const firstWord = upperTrimmed.split(/\s/)[0];

        // SP parameter lines: indent between PROC/PROCEDURE and AS
        if (inProcParams) {
            if (firstWord === 'AS') {
                inProcParams = false;
            } else {
                const indent = ' '.repeat((depth + 1) * indentSize);
                result.push(indent + trimmed);
                lineDepths.push(depth + 1);
                continue;
            }
        }
        if (/\b(PROC|PROCEDURE)\b/i.test(upperTrimmed)) {
            inProcParams = true;
        }

        // ── Block closers: reduce depth BEFORE applying to this line ──
        if (firstWord === 'END') {
            pendingSingleIndent = false;
            depth = Math.max(0, depth - 1);
        }

        // ── Calculate this line's depth ──
        let lineDepth = depth;
        if (pendingSingleIndent) {
            lineDepth = depth + 1;
            pendingSingleIndent = false; // consumed by this line
        }

        // Apply indent
        const indent = ' '.repeat(lineDepth * indentSize);
        result.push(indent + trimmed);
        lineDepths.push(lineDepth);

        // ── Block openers: increase depth AFTER applying to this line ──
        // "Begin" standalone or at end of IF/WHILE/ELSE line
        const endsWithBegin = upperTrimmed.endsWith(' BEGIN') || upperTrimmed === 'BEGIN';
        const isBeginTryCatch = upperTrimmed === 'BEGIN TRY' || upperTrimmed === 'BEGIN CATCH';

        if (isBeginTryCatch || endsWithBegin) {
            depth++;
        }

        // ── IF/ELSE/WHILE without BEGIN → next statement gets +1 indent ──
        if ((firstWord === 'IF' || firstWord === 'ELSE' || firstWord === 'WHILE')
            && !upperTrimmed.endsWith(' BEGIN')
            && !upperTrimmed.endsWith(' BEGIN;')) {
            pendingSingleIndent = true;
        }
    }

    // ── Post-process: insert empty lines between statements at same depth ──
    if (ws.emptyLinesBetweenStatements > 0) {
        const finalResult: string[] = [];
        let prevNonEmptyDepth = -1;
        let prevNonEmptyIsOpener = true; // treat start of file as opener

        for (let i = 0; i < result.length; i++) {
            const trimmed = result[i].trim();
            if (!trimmed) { finalResult.push(result[i]); continue; }

            const lineIndent = result[i].length - result[i].trimStart().length;
            const ld = Math.floor(lineIndent / indentSize);
            const upperTrimmed = trimmed.toUpperCase();
            const firstWord = upperTrimmed.split(/\s/)[0];

            // Skip comment lines for blank line logic
            if (trimmed.startsWith('--') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
                finalResult.push(result[i]);
                continue;
            }

            const isOpener = upperTrimmed.endsWith(' BEGIN') || upperTrimmed === 'BEGIN'
                || upperTrimmed === 'BEGIN TRY' || upperTrimmed === 'BEGIN CATCH';

            let shouldAddBlankLine = false;

            if (ld > 0) {
                // Inside a block: blank line between same-depth statement starters
                if (SAME_DEPTH_STARTERS.has(firstWord)
                    && ld === prevNonEmptyDepth
                    && !prevNonEmptyIsOpener
                    && firstWord !== 'ELSE'
                    && upperTrimmed !== 'BEGIN CATCH') {
                    shouldAddBlankLine = true;
                }
            } else {
                // Top-level: blank line before standalone BEGIN (SP body start)
                if ((upperTrimmed === 'BEGIN' || isOpener)
                    && prevNonEmptyDepth === 0
                    && !prevNonEmptyIsOpener) {
                    shouldAddBlankLine = true;
                }
            }

            if (shouldAddBlankLine) {
                for (let j = 0; j < ws.emptyLinesBetweenStatements; j++) {
                    finalResult.push('');
                }
            }

            finalResult.push(result[i]);
            prevNonEmptyDepth = ld;
            prevNonEmptyIsOpener = isOpener;
        }

        return finalResult.join('\n');
    }

    return result.join('\n');
}

// ─── Phase 3: Detail Formatting ───

function applyDetailFormatting(text: string, ws: WhitespaceOptions, vars: VariablesOptions): string {
    const lines = text.split('\n');
    const result: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimEnd();
        const indent = lines[i].match(/^(\s*)/)?.[1] || '';
        const content = trimmed.trim();
        const upper = content.toUpperCase();

        // DECLARE formatting — merge continuation lines and comma-split
        if (upper.startsWith('DECLARE ')) {
            let fullContent = content;
            // Merge continuation lines (ending with comma + next starts with @)
            while (fullContent.endsWith(',') && i + 1 < lines.length) {
                const nextContent = lines[i + 1].trim();
                if (nextContent.startsWith('@')) {
                    fullContent += ' ' + nextContent;
                    i++;
                } else {
                    break;
                }
            }
            if (fullContent.includes(',')) {
                result.push(...formatDeclare(fullContent, indent, ws.wrapLinesLongerThan));
                continue;
            }
        }

        // EXEC parameter wrapping
        if ((upper.startsWith('EXEC ') || upper.startsWith('EXECUTE ')) && content.includes('@')) {
            result.push(...formatExec(content, indent, ws));
            continue;
        }

        // String concatenation wrapping
        if (content.includes(' + ') && trimmed.length > ws.wrapLinesLongerThan && ws.wrapLinesLongerThan > 0) {
            const concatResult = formatStringConcat(content, indent, ws);
            if (concatResult) {
                result.push(...concatResult);
                continue;
            }
        }

        result.push(lines[i]);
    }

    return result.join('\n');
}

/**
 * Format merged DECLARE: wrap at maxLen, align commas to Declare width (8 chars).
 */
function formatDeclare(content: string, indent: string, maxLen: number = 0): string[] {
    // Split on commas at depth 0
    const vars: string[] = [];
    let current = '';
    let depth = 0;
    // Remove "Declare " prefix
    const declareMatch = content.match(/^(Declare\s+)/i);
    if (!declareMatch) return [indent + content];
    const prefix = declareMatch[1];
    const rest = content.substring(prefix.length);

    for (let i = 0; i < rest.length; i++) {
        const ch = rest[i];
        if (ch === '(') depth++;
        if (ch === ')') depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) {
            vars.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) vars.push(current.trim());

    if (vars.length <= 1) return [indent + content];

    // Build lines with wrapping at maxLen
    const commaIndent = indent + ' '.repeat(prefix.trimEnd().length + 1);
    const commaPrefix = commaIndent.substring(0, commaIndent.length - 2) + ', ';

    const lines: string[] = [];
    let currentLine = indent + prefix + vars[0];

    for (let i = 1; i < vars.length; i++) {
        const testLine = currentLine + ', ' + vars[i];
        if (maxLen > 0 && testLine.length > maxLen) {
            // Wrap to new line
            lines.push(currentLine);
            currentLine = commaPrefix + vars[i];
        } else {
            currentLine = testLine;
        }
    }
    lines.push(currentLine);
    return lines;
}

/**
 * Format EXEC with parameter wrapping.
 * < 3 params and fits: single line.
 * Otherwise: wrap with comma-before, aligned to SP name width.
 */
function formatExec(content: string, indent: string, ws: WhitespaceOptions): string[] {
    // Find SP name and params
    const execMatch = content.match(/^(Exec(?:ute)?\s+(?:dbo\.)?[\w]+)\s*(.*)/i);
    if (!execMatch) return [indent + content];

    const execPrefix = execMatch[1]; // "Exec dbo.SpName"
    const paramStr = execMatch[2];
    if (!paramStr || !paramStr.includes('@')) return [indent + content];

    // Split params on commas at depth 0
    const params: string[] = [];
    let current = '';
    let depth = 0;
    for (let i = 0; i < paramStr.length; i++) {
        const ch = paramStr[i];
        if (ch === '(') depth++;
        if (ch === ')') depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) {
            params.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) params.push(current.trim());

    // < 3 params and fits in one line → single line
    const singleLine = indent + execPrefix + ' ' + params.join(', ');
    if (params.length < 3 && (ws.wrapLinesLongerThan <= 0 || singleLine.length <= ws.wrapLinesLongerThan)) {
        return [singleLine];
    }

    // Wrap: first params on exec line up to maxLineLength, rest with comma-before
    const prefixLen = indent.length + execPrefix.length + 1; // +1 for space
    const wrapIndent = ' '.repeat(prefixLen - 2) + ', ';
    const lines: string[] = [];
    let currentLine = indent + execPrefix + ' ' + params[0];

    for (let i = 1; i < params.length; i++) {
        const test = currentLine + ', ' + params[i];
        if (ws.wrapLinesLongerThan > 0 && test.length > ws.wrapLinesLongerThan) {
            lines.push(currentLine);
            currentLine = wrapIndent + params[i];
        } else {
            currentLine += ', ' + params[i];
        }
    }
    lines.push(currentLine);
    return lines;
}

/**
 * Format string concatenation: break at + operators when line exceeds maxLineLength.
 * Align + to the right-hand-side start column after =.
 */
function formatStringConcat(content: string, indent: string, ws: WhitespaceOptions): string[] | null {
    // Find = position for alignment
    const eqIdx = content.indexOf('=');
    if (eqIdx === -1) return null;

    // Find RHS start (after = and space)
    let rhsStart = eqIdx + 1;
    while (rhsStart < content.length && content[rhsStart] === ' ') rhsStart++;

    // Split at + operators (not inside strings or parens)
    const parts: string[] = [];
    let current = '';
    let depth = 0;
    let inStr = false;

    for (let i = 0; i < content.length; i++) {
        const ch = content[i];

        if (ch === "'" && !inStr) { inStr = true; current += ch; continue; }
        if (ch === "'" && inStr) {
            if (i + 1 < content.length && content[i + 1] === "'") {
                current += "''"; i++; continue; // escaped quote
            }
            inStr = false; current += ch; continue;
        }
        if (inStr) { current += ch; continue; }

        if (ch === '(') depth++;
        if (ch === ')') depth = Math.max(0, depth - 1);

        if (ch === '+' && depth === 0 && i > eqIdx) {
            parts.push(current.trimEnd());
            current = '';
            // Skip space after +
            if (i + 1 < content.length && content[i + 1] === ' ') i++;
            continue;
        }

        current += ch;
    }
    if (current.trim()) parts.push(current.trimEnd());

    if (parts.length <= 1) return null;

    // Build result with alignment
    const alignCol = indent.length + rhsStart;
    const alignIndent = ' '.repeat(alignCol);
    const lines: string[] = [indent + parts[0].trim()];
    for (let i = 1; i < parts.length; i++) {
        lines.push(alignIndent + '+ ' + parts[i].trim());
    }
    return lines;
}
