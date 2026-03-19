import { Token } from './sqlTokenizer';

export interface CaseOptions {
    placeExpressionOnNewLine: boolean;
    placeFirstWhenOnNewLine: 'never' | 'always' | 'ifLong';
    whenAlignment: 'toFirstItem' | 'toCase' | 'indented';
    placeThenOnNewLine: boolean;
    thenAlignment: 'indentedFromWhen' | 'toCase' | 'toFirstItem';
    placeElseOnNewLine: boolean;
    alignElseToWhen: boolean;
    collapseShortCaseExpressions: boolean;
    collapseCaseExpressionsShorterThan: number;
}

export const DEFAULT_CASE_OPTIONS: CaseOptions = {
    placeExpressionOnNewLine: false,
    placeFirstWhenOnNewLine: 'never',
    whenAlignment: 'toFirstItem',
    placeThenOnNewLine: false,
    thenAlignment: 'indentedFromWhen',
    placeElseOnNewLine: true,
    alignElseToWhen: true,
    collapseShortCaseExpressions: true,
    collapseCaseExpressionsShorterThan: 100,
};

/**
 * Format CASE expressions in a SQL string.
 * Processes the text output (after casing + layout), finds CASE blocks and reformats them.
 */
export function applyCaseFormatting(sql: string, options: CaseOptions, tokens: Token[]): string {
    // Find CASE..END blocks in the token stream and reformat
    const caseBlocks = findCaseBlocks(tokens);
    if (caseBlocks.length === 0) return sql;

    // Process from last to first to preserve offsets
    let result = sql;
    for (let i = caseBlocks.length - 1; i >= 0; i--) {
        const block = caseBlocks[i];
        const formatted = formatCaseBlock(block, options);
        // Find original text span in the result string
        const originalText = buildOriginalText(block.tokens);
        const idx = findBlockInString(result, block.tokens);
        if (idx >= 0) {
            result = result.substring(0, idx) + formatted + result.substring(idx + originalText.length);
        }
    }

    return result;
}

interface CaseBlock {
    tokens: Token[];
    caseIndex: number;      // index of CASE keyword in tokens
    whenIndices: number[];   // indices of WHEN keywords
    thenIndices: number[];   // indices of THEN keywords
    elseIndex: number;       // index of ELSE keyword (-1 if none)
    endIndex: number;        // index of END keyword
    depth: number;           // nesting depth (0 = outermost)
}

function findCaseBlocks(tokens: Token[]): CaseBlock[] {
    const blocks: CaseBlock[] = [];
    const stack: { startIdx: number; whenIndices: number[]; thenIndices: number[]; elseIndex: number }[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type !== 'keyword') continue;
        const upper = t.value.toUpperCase();

        if (upper === 'CASE') {
            stack.push({ startIdx: i, whenIndices: [], thenIndices: [], elseIndex: -1 });
        } else if (upper === 'WHEN' && stack.length > 0) {
            stack[stack.length - 1].whenIndices.push(i);
        } else if (upper === 'THEN' && stack.length > 0) {
            stack[stack.length - 1].thenIndices.push(i);
        } else if (upper === 'ELSE' && stack.length > 0) {
            stack[stack.length - 1].elseIndex = i;
        } else if (upper === 'END' && stack.length > 0) {
            const frame = stack.pop()!;
            blocks.push({
                tokens: tokens.slice(frame.startIdx, i + 1),
                caseIndex: frame.startIdx,
                whenIndices: frame.whenIndices,
                thenIndices: frame.thenIndices,
                elseIndex: frame.elseIndex,
                endIndex: i,
                depth: stack.length,
            });
        }
    }

    // Only format outermost CASE blocks (depth=0) to avoid double formatting
    return blocks.filter(b => b.depth === 0);
}

function formatCaseBlock(block: CaseBlock, options: CaseOptions): string {
    // Parse the CASE block into parts
    const parts = parseCaseParts(block);
    if (!parts) return buildOriginalText(block.tokens);

    const caseKeyword = block.tokens[0].value;
    const endKeyword = block.tokens[block.tokens.length - 1].value;

    // Collapse short CASE expressions to single line
    if (options.collapseShortCaseExpressions) {
        const inlineVersion = buildInlineCaseText(caseKeyword, endKeyword, parts);
        if (inlineVersion.length <= options.collapseCaseExpressionsShorterThan) {
            return inlineVersion;
        }
    }

    // Determine indentation
    const baseIndent = getLeadingWhitespace(block.tokens);

    let whenIndent: string;
    switch (options.whenAlignment) {
        case 'toCase':
            whenIndent = baseIndent;
            break;
        case 'indented':
            whenIndent = baseIndent + '    ';
            break;
        case 'toFirstItem':
        default:
            whenIndent = baseIndent + ' '.repeat(caseKeyword.length + 1);
            break;
    }

    const thenIndent = options.thenAlignment === 'indentedFromWhen'
        ? whenIndent + '    '
        : options.thenAlignment === 'toCase'
            ? baseIndent + '    '
            : whenIndent;

    const elseIndent = options.alignElseToWhen ? whenIndent : baseIndent + '    ';

    // Build formatted output
    let result = caseKeyword;

    // CASE expression (for CASE expr WHEN ...)
    if (parts.caseExpression) {
        if (options.placeExpressionOnNewLine) {
            result += '\n' + whenIndent + parts.caseExpression;
        } else {
            result += ' ' + parts.caseExpression;
        }
    }

    // WHEN clauses
    for (let i = 0; i < parts.whenClauses.length; i++) {
        const wc = parts.whenClauses[i];
        const whenKeyword = wc.whenKeyword;
        const thenKeyword = wc.thenKeyword;

        if (options.placeFirstWhenOnNewLine === 'never') {
            // All WHENs stay inline
            result += ' ' + whenKeyword + ' ' + wc.condition;
        } else if (options.placeFirstWhenOnNewLine === 'always') {
            // All WHENs on new line
            result += '\n' + whenIndent + whenKeyword + ' ' + wc.condition;
        } else {
            // 'ifLong' — first inline, rest on new line (simplified)
            if (i === 0) {
                result += ' ' + whenKeyword + ' ' + wc.condition;
            } else {
                result += '\n' + whenIndent + whenKeyword + ' ' + wc.condition;
            }
        }

        if (options.placeThenOnNewLine) {
            result += '\n' + thenIndent + thenKeyword + ' ' + wc.thenResult;
        } else {
            result += ' ' + thenKeyword + ' ' + wc.thenResult;
        }
    }

    // ELSE
    if (parts.elseClause) {
        if (options.placeElseOnNewLine) {
            result += '\n' + elseIndent + parts.elseClause.elseKeyword + ' ' + parts.elseClause.result;
        } else {
            result += ' ' + parts.elseClause.elseKeyword + ' ' + parts.elseClause.result;
        }
    }

    // END
    result += ' ' + endKeyword;

    return result;
}

interface CaseParts {
    caseExpression: string | null;  // for "CASE expr WHEN..."
    whenClauses: { whenKeyword: string; condition: string; thenKeyword: string; thenResult: string }[];
    elseClause: { elseKeyword: string; result: string } | null;
}

function parseCaseParts(block: CaseBlock): CaseParts | null {
    const tokens = block.tokens;
    if (tokens.length < 3) return null;

    // Collect token values between key positions
    const globalStart = block.caseIndex;

    // Check for CASE expression (tokens between CASE and first WHEN)
    let caseExpression: string | null = null;
    const firstWhenGlobal = block.whenIndices[0];
    if (firstWhenGlobal !== undefined) {
        const betweenTokens = collectBetween(tokens, 1, firstWhenGlobal - globalStart);
        if (betweenTokens.trim()) {
            caseExpression = betweenTokens.trim();
        }
    }

    // Parse WHEN...THEN pairs
    const whenClauses: CaseParts['whenClauses'] = [];
    for (let i = 0; i < block.whenIndices.length; i++) {
        const whenGlobal = block.whenIndices[i];
        const thenGlobal = block.thenIndices[i];
        if (thenGlobal === undefined) continue;

        const whenLocal = whenGlobal - globalStart;
        const thenLocal = thenGlobal - globalStart;
        const whenKeyword = tokens[whenLocal].value;
        const thenKeyword = tokens[thenLocal].value;
        const condition = collectBetween(tokens, whenLocal + 1, thenLocal).trim();

        // THEN result: from THEN+1 to next WHEN or ELSE or END
        let resultEnd: number;
        if (i + 1 < block.whenIndices.length) {
            resultEnd = block.whenIndices[i + 1] - globalStart;
        } else if (block.elseIndex >= 0) {
            resultEnd = block.elseIndex - globalStart;
        } else {
            resultEnd = block.endIndex - globalStart;
        }
        const thenResult = collectBetween(tokens, thenLocal + 1, resultEnd).trim();

        whenClauses.push({ whenKeyword, condition, thenKeyword, thenResult });
    }

    // ELSE clause
    let elseClause: CaseParts['elseClause'] = null;
    if (block.elseIndex >= 0) {
        const elseLocal = block.elseIndex - globalStart;
        const endLocal = block.endIndex - globalStart;
        const elseKeyword = tokens[elseLocal].value;
        const elseResult = collectBetween(tokens, elseLocal + 1, endLocal).trim();
        elseClause = { elseKeyword, result: elseResult };
    }

    return { caseExpression, whenClauses, elseClause };
}

function collectBetween(tokens: Token[], startLocal: number, endLocal: number): string {
    let result = '';
    for (let i = startLocal; i < endLocal && i < tokens.length; i++) {
        result += tokens[i].value;
    }
    return result;
}

function buildOriginalText(tokens: Token[]): string {
    return tokens.map(t => t.value).join('');
}

function getLeadingWhitespace(tokens: Token[]): string {
    // Look at the first token's offset to determine column position
    // For simplicity, return empty string (CASE appears inline)
    return '';
}

function findBlockInString(sql: string, tokens: Token[]): number {
    const original = buildOriginalText(tokens);
    return sql.indexOf(original);
}

/**
 * Build a single-line inline version of a CASE expression.
 */
function buildInlineCaseText(caseKeyword: string, endKeyword: string, parts: CaseParts): string {
    let result = caseKeyword;
    if (parts.caseExpression) {
        result += ' ' + parts.caseExpression;
    }
    for (const wc of parts.whenClauses) {
        result += ' ' + wc.whenKeyword + ' ' + wc.condition + ' ' + wc.thenKeyword + ' ' + wc.thenResult;
    }
    if (parts.elseClause) {
        result += ' ' + parts.elseClause.elseKeyword + ' ' + parts.elseClause.result;
    }
    result += ' ' + endKeyword;
    return result;
}
