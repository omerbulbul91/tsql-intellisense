/**
 * Regex-based SQL context detection.
 * Determines what kind of completions to offer based on cursor position.
 */

export enum SqlContextType {
    NONE = 'NONE',
    AFTER_FROM_JOIN = 'AFTER_FROM_JOIN',
    AFTER_EXEC = 'AFTER_EXEC',
    AFTER_ALIAS_DOT = 'AFTER_ALIAS_DOT',
    AFTER_ALTER_PROC = 'AFTER_ALTER_PROC',
    AFTER_SELECT = 'AFTER_SELECT',
}

export interface SqlContext {
    type: SqlContextType;
    /** For AFTER_ALIAS_DOT: the alias text before the dot */
    alias?: string;
    /** For AFTER_ALIAS_DOT: the resolved table name */
    tableName?: string;
    /** Partial text the user has typed (for filtering) */
    prefix?: string;
}

export interface AliasMapping {
    alias: string;
    tableName: string;
}

/**
 * Extract the current SQL statement around the cursor position.
 * Statements are delimited by GO, semicolons, or document boundaries.
 */
export function getCurrentStatement(fullText: string, offset: number): string {
    // Find statement start: look backward for GO or start of text
    let start = 0;
    const beforeCursor = fullText.substring(0, offset);

    // Find last GO (on its own line) or semicolon before cursor
    const goMatches = [...beforeCursor.matchAll(/\bGO\b\s*$/gmi)];
    if (goMatches.length > 0) {
        const lastGo = goMatches[goMatches.length - 1];
        start = (lastGo.index || 0) + lastGo[0].length;
    }

    // Also check for semicolons (take whichever is closer to cursor)
    const lastSemicolon = beforeCursor.lastIndexOf(';');
    if (lastSemicolon > start) {
        start = lastSemicolon + 1;
    }

    return fullText.substring(start, offset);
}

/**
 * Extract alias → table mappings from a SQL statement.
 * Handles: FROM TableName alias, FROM dbo.TableName alias, FROM [TableName] AS alias
 * Also handles JOIN variants.
 */
export function extractAliases(statementText: string): AliasMapping[] {
    const aliases: AliasMapping[] = [];
    // Match FROM/JOIN tableName [AS] alias patterns
    // Supports: dbo. prefix, [bracket] notation, AS keyword
    const regex = /(?:FROM|(?:INNER|LEFT|RIGHT|CROSS|FULL)\s+(?:OUTER\s+)?JOIN|JOIN)\s+(?:dbo\.)?(\[?\w+\]?)\s+(?:AS\s+)?(?!ON\b|WHERE\b|INNER\b|LEFT\b|RIGHT\b|CROSS\b|FULL\b|JOIN\b|SET\b|ORDER\b|GROUP\b|HAVING\b|UNION\b|EXCEPT\b|INTERSECT\b)(\w+)/gi;

    let match;
    while ((match = regex.exec(statementText)) !== null) {
        let tableName = match[1];
        const alias = match[2];

        // Remove brackets if present
        tableName = tableName.replace(/[\[\]]/g, '');

        // Skip if alias looks like a keyword
        if (/^(ON|WHERE|SET|ORDER|GROUP|HAVING|INNER|LEFT|RIGHT|CROSS|FULL|JOIN|AS|WITH|INTO|VALUES|SELECT|FROM)$/i.test(alias)) {
            continue;
        }

        aliases.push({ alias, tableName });
    }

    return aliases;
}

/**
 * Detect the SQL context at the cursor position.
 */
export function detectContext(textBeforeCursor: string, fullStatementText: string): SqlContext {
    // Get the text on the current line up to cursor
    const lines = textBeforeCursor.split('\n');
    const currentLine = lines[lines.length - 1];

    // 1. Check for alias.prefix pattern (highest priority — triggered by '.')
    const aliasDotMatch = currentLine.match(/(\w+)\.(\w*)$/);
    if (aliasDotMatch) {
        const possibleAlias = aliasDotMatch[1];
        const prefix = aliasDotMatch[2];

        // Check if this is a known alias in the current statement
        const aliases = extractAliases(fullStatementText);
        const mapping = aliases.find(a => a.alias.toLowerCase() === possibleAlias.toLowerCase());

        if (mapping) {
            return {
                type: SqlContextType.AFTER_ALIAS_DOT,
                alias: mapping.alias,
                tableName: mapping.tableName,
                prefix,
            };
        }

        // Could be dbo.TableName — treat as FROM context
        if (possibleAlias.toLowerCase() === 'dbo') {
            return {
                type: SqlContextType.AFTER_FROM_JOIN,
                prefix,
            };
        }

        return { type: SqlContextType.NONE };
    }

    // 2. Check for ALTER PROC/PROCEDURE
    const alterProcMatch = textBeforeCursor.match(/ALTER\s+PROC(?:EDURE)?\s+(?:dbo\.)?(\w*)$/i);
    if (alterProcMatch) {
        return {
            type: SqlContextType.AFTER_ALTER_PROC,
            prefix: alterProcMatch[1],
        };
    }

    // 3. Check for EXEC/EXECUTE
    const execMatch = textBeforeCursor.match(/EXEC(?:UTE)?\s+(?:dbo\.)?(\w*)$/i);
    if (execMatch) {
        return {
            type: SqlContextType.AFTER_EXEC,
            prefix: execMatch[1],
        };
    }

    // 4. Check for FROM / JOIN
    const fromJoinMatch = textBeforeCursor.match(
        /(?:FROM|(?:INNER|LEFT|RIGHT|CROSS|FULL)\s+(?:OUTER\s+)?JOIN|JOIN)\s+(?:dbo\.)?(\w*)$/i
    );
    if (fromJoinMatch) {
        return {
            type: SqlContextType.AFTER_FROM_JOIN,
            prefix: fromJoinMatch[1],
        };
    }

    // 5. Check for INSERT INTO
    const insertMatch = textBeforeCursor.match(/INSERT\s+(?:INTO\s+)?(?:dbo\.)?(\w*)$/i);
    if (insertMatch) {
        return {
            type: SqlContextType.AFTER_FROM_JOIN,
            prefix: insertMatch[1],
        };
    }

    // 6. Check for UPDATE
    const updateMatch = textBeforeCursor.match(/UPDATE\s+(?:dbo\.)?(\w*)$/i);
    if (updateMatch) {
        return {
            type: SqlContextType.AFTER_FROM_JOIN,
            prefix: updateMatch[1],
        };
    }

    // 7. Check for DELETE FROM
    const deleteMatch = textBeforeCursor.match(/DELETE\s+(?:FROM\s+)?(?:dbo\.)?(\w*)$/i);
    if (deleteMatch) {
        return {
            type: SqlContextType.AFTER_FROM_JOIN,
            prefix: deleteMatch[1],
        };
    }

    return { type: SqlContextType.NONE };
}
