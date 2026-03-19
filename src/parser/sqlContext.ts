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
    AFTER_TABLE_NAME = 'AFTER_TABLE_NAME',
    AFTER_ORDER_BY_COLUMN = 'AFTER_ORDER_BY_COLUMN',
    AFTER_ON = 'AFTER_ON',
    AFTER_GROUP_BY = 'AFTER_GROUP_BY',
    AFTER_ALTER_CREATE = 'AFTER_ALTER_CREATE',
    AFTER_ALTER_OBJECT = 'AFTER_ALTER_OBJECT',
}

export interface SqlContext {
    type: SqlContextType;
    /** For AFTER_ALIAS_DOT: the alias text before the dot */
    alias?: string;
    /** For AFTER_ALIAS_DOT: the resolved table name */
    tableName?: string;
    /** Partial text the user has typed (for filtering) */
    prefix?: string;
    /** For AFTER_ON: all alias mappings in the statement */
    aliases?: AliasMapping[];
    /** For AFTER_ON: the table that was just JOINed */
    joinedTable?: string;
    /** For AFTER_ON: alias of the joined table */
    joinedAlias?: string;
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
    // Find statement start: look backward for GO or semicolon
    let start = 0;
    const beforeCursor = fullText.substring(0, offset);

    const goMatches = [...beforeCursor.matchAll(/\bGO\b\s*$/gmi)];
    if (goMatches.length > 0) {
        const lastGo = goMatches[goMatches.length - 1];
        start = (lastGo.index || 0) + lastGo[0].length;
    }

    const lastSemicolon = beforeCursor.lastIndexOf(';');
    if (lastSemicolon > start) {
        start = lastSemicolon + 1;
    }

    // Find statement end: look forward for GO, semicolon, or end of text
    let end = fullText.length;
    const afterCursor = fullText.substring(offset);

    const nextSemicolon = afterCursor.indexOf(';');
    if (nextSemicolon >= 0) {
        end = offset + nextSemicolon;
    }

    const nextGo = afterCursor.match(/^\s*GO\b/mi);
    if (nextGo && nextGo.index !== undefined && (nextSemicolon < 0 || nextGo.index < nextSemicolon)) {
        end = offset + nextGo.index;
    }

    return fullText.substring(start, end);
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
 * Extract non-aggregated columns from the SELECT clause.
 * Returns column expressions that are NOT wrapped in aggregate functions.
 * e.g. "SELECT k.Name, k.RolID, SUM(k.Amount)" → ["k.Name", "k.RolID"]
 */
export function extractNonAggColumns(statementText: string): string[] {
    // Extract SELECT clause (between SELECT and FROM)
    const selectMatch = statementText.match(/SELECT\s+(?:TOP\s+\d+\s+)?(?:DISTINCT\s+)?([\s\S]*?)\bFROM\b/i);
    if (!selectMatch) { return []; }

    const selectClause = selectMatch[1];
    if (selectClause.trim() === '*') { return []; }

    // Split by comma (respecting parentheses depth)
    const columns: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of selectClause) {
        if (ch === '(') { depth++; }
        else if (ch === ')') { depth--; }
        else if (ch === ',' && depth === 0) {
            columns.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) { columns.push(current.trim()); }

    // Filter out aggregate columns
    const aggPattern = /^(?:SUM|COUNT|AVG|MIN|MAX|STDEV|STDEVP|VAR|VARP|STRING_AGG|CHECKSUM_AGG|COUNT_BIG)\s*\(/i;
    const nonAgg: string[] = [];
    for (const col of columns) {
        if (aggPattern.test(col)) { continue; }
        // Remove trailing alias (AS alias or just alias after space)
        // e.g. "k.Name AS KullaniciAdi" → "k.Name"
        const cleaned = col.replace(/\s+AS\s+\w+$/i, '').replace(/\s+\w+$/, '').trim();
        if (cleaned && cleaned !== '*') {
            nonAgg.push(cleaned);
        }
    }

    return nonAgg;
}

/**
 * Extract table names from FROM/JOIN clauses (without alias).
 * Returns all table names referenced in the statement.
 */
export function extractTables(statementText: string): string[] {
    const tables: string[] = [];
    const regex = /(?:FROM|(?:INNER|LEFT|RIGHT|CROSS|FULL)\s+(?:OUTER\s+)?JOIN|JOIN)\s+(?:dbo\.)?(\[?\w+\]?)/gi;
    let match;
    while ((match = regex.exec(statementText)) !== null) {
        let tableName = match[1].replace(/[\[\]]/g, '');
        if (!tables.includes(tableName)) {
            tables.push(tableName);
        }
    }
    return tables;
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

    // 2a. Check for ALTER/CREATE without object type yet → suggest object types
    const alterCreateMatch = textBeforeCursor.match(/(?:ALTER|CREATE)\s+(\w*)$/i);
    if (alterCreateMatch && !/^(PROC|PROCEDURE|TABLE|VIEW|FUNCTION|INDEX|TRIGGER|DATABASE|SCHEMA|LOGIN|USER|ROLE)$/i.test(alterCreateMatch[1])) {
        return {
            type: SqlContextType.AFTER_ALTER_CREATE,
            prefix: alterCreateMatch[1],
        };
    }

    // 2b. Check for ALTER/CREATE + object type + name prefix
    const alterObjMatch = textBeforeCursor.match(/(?:ALTER|CREATE)\s+(PROC(?:EDURE)?|TABLE|VIEW|FUNCTION|TRIGGER)\s+(?:dbo\.)?(\w*)$/i);
    if (alterObjMatch) {
        const objType = alterObjMatch[1].toUpperCase();
        const prefix = alterObjMatch[2];
        if (objType === 'PROC' || objType === 'PROCEDURE') {
            return { type: SqlContextType.AFTER_ALTER_PROC, prefix };
        }
        return { type: SqlContextType.AFTER_ALTER_OBJECT, prefix, alias: objType };
    }

    // 3. Check for EXEC/EXECUTE
    const execMatch = textBeforeCursor.match(/EXEC(?:UTE)?\s+(?:dbo\.)?(\w*)$/i);
    if (execMatch) {
        return {
            type: SqlContextType.AFTER_EXEC,
            prefix: execMatch[1],
        };
    }

    // 4. Check for FROM / JOIN — typing table name
    const fromJoinMatch = textBeforeCursor.match(
        /(?:FROM|(?:INNER|LEFT|RIGHT|CROSS|FULL)\s+(?:OUTER\s+)?JOIN|JOIN)\s+(?:dbo\.)?(\w*)$/i
    );
    if (fromJoinMatch) {
        return {
            type: SqlContextType.AFTER_FROM_JOIN,
            prefix: fromJoinMatch[1],
        };
    }

    // 4a. Check for ON after JOIN table alias — suggest join conditions
    // e.g. "LEFT JOIN RN100_Roller r ON " → suggest r.RolID = k.RolID
    const joinOnMatch = textBeforeCursor.match(
        /JOIN\s+(?:dbo\.)?(\w+)\s+(\w+)\s+ON\s+(\w*)$/i
    ) || textBeforeCursor.match(
        /(?:INNER|LEFT|RIGHT|CROSS|FULL)\s+(?:OUTER\s+)?JOIN\s+(?:dbo\.)?(\w+)\s+(\w+)\s+ON\s+(\w*)$/i
    );
    if (joinOnMatch) {
        const joinedTable = joinOnMatch[1];
        const joinedAlias = joinOnMatch[2];
        const prefix = joinOnMatch[3];
        const aliases = extractAliases(fullStatementText);
        return {
            type: SqlContextType.AFTER_ON,
            prefix,
            joinedTable,
            joinedAlias,
            aliases,
        };
    }

    // 4b. Check if cursor is AFTER a table name (for alias/keyword suggestions)
    // e.g. "FROM RN100_Kullanicilar w" → suggest WHERE, or alias
    const afterTableMatch = textBeforeCursor.match(
        /(?:FROM|(?:INNER|LEFT|RIGHT|CROSS|FULL)\s+(?:OUTER\s+)?JOIN|JOIN)\s+(?:dbo\.)?\w+\s+(\w*)$/i
    );
    if (afterTableMatch) {
        const prefix = afterTableMatch[1];
        // Don't trigger if it already looks like a known keyword followed by something
        if (!/^(ON|WHERE|SET|ORDER|GROUP|HAVING|INNER|LEFT|RIGHT|CROSS|FULL|JOIN|AS|INTO|VALUES|SELECT|FROM)$/i.test(prefix)) {
            const tables = extractTables(fullStatementText);
            return {
                type: SqlContextType.AFTER_TABLE_NAME,
                prefix,
                tableName: tables.length > 0 ? tables[tables.length - 1] : undefined,
            };
        }
    }

    // 4c. Check if cursor is after FROM table alias + typing a keyword
    // e.g. "FROM RN100_Kullanicilar k or" → suggest ORDER BY, etc.
    const afterAliasKeywordMatch = textBeforeCursor.match(
        /(?:FROM|(?:INNER|LEFT|RIGHT|CROSS|FULL)\s+(?:OUTER\s+)?JOIN|JOIN)\s+(?:dbo\.)?\w+\s+\w+\s+(\w*)$/i
    );
    if (afterAliasKeywordMatch) {
        return {
            type: SqlContextType.AFTER_TABLE_NAME,
            prefix: afterAliasKeywordMatch[1],
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

    // 8. Check for SELECT / WHERE / ORDER BY / GROUP BY / HAVING / SET — suggest columns
    // Only if the statement has a FROM clause with a table
    const tables = extractTables(fullStatementText);
    if (tables.length > 0) {
        const aliases = extractAliases(fullStatementText);
        // Find alias for the primary table
        const primaryAlias = aliases.length > 0 ? aliases[0].alias : undefined;

        // Check if cursor is in a column context (after SELECT, WHERE, ORDER BY, etc.)
        // Include * as valid prefix for "expand all columns"
        // 8a. After = sign → suggest aliases (user picks alias, then types . for columns)
        const afterEqualsMatch = currentLine.match(/=\s*(\w*)$/);
        if (afterEqualsMatch) {
            return {
                type: SqlContextType.AFTER_ON,
                prefix: afterEqualsMatch[1],
                aliases,
            };
        }

        // 8b. GROUP BY → separate context (no * expand, has "all non-agg columns")
        const groupByMatch = currentLine.match(/GROUP\s+BY\s+([\w]*)$/i);
        if (groupByMatch) {
            return {
                type: SqlContextType.AFTER_GROUP_BY,
                prefix: groupByMatch[1],
                tableName: tables[0],
                alias: primaryAlias,
                aliases,
            };
        }

        const columnContextMatch = currentLine.match(/(?:SELECT(?:\s+(?:DISTINCT|ALL|TOP\s+\d+))?|WHERE|AND|OR|ON|SET|ORDER\s+BY|HAVING|WHEN|THEN|ELSE|CASE|,|\()\s*([\w*]*)$/i);
        if (columnContextMatch) {
            return {
                type: SqlContextType.AFTER_SELECT,
                prefix: columnContextMatch[1],
                tableName: tables[0],
                alias: primaryAlias,
            };
        }

        // 8b. Check for ORDER BY column + typing ASC/DESC
        // e.g. "ORDER BY k.KullaniciAdi de" → suggest DESC, ASC
        const orderByColMatch = currentLine.match(/ORDER\s+BY\b.*\S+\s+(\w*)$/i);
        if (orderByColMatch) {
            return {
                type: SqlContextType.AFTER_ORDER_BY_COLUMN,
                prefix: orderByColMatch[1],
            };
        }

        // Also match PARTITION BY, OVER(ORDER BY etc.
        const windowMatch = currentLine.match(/(?:PARTITION\s+BY|OVER\s*\(\s*(?:ORDER\s+BY)?)\s+(\w*)$/i);
        if (windowMatch) {
            return {
                type: SqlContextType.AFTER_SELECT,
                prefix: windowMatch[1],
                tableName: tables[0],
                alias: primaryAlias,
            };
        }
    }

    // 9. Fallback: suggest SQL keywords when typing a word in a query that has tables
    // e.g. "WHERE k.KullaniciID = 1 or" → suggest ORDER BY
    if (tables.length > 0) {
        const keywordFallbackMatch = textBeforeCursor.match(/\b(\w+)$/i);
        if (keywordFallbackMatch) {
            return {
                type: SqlContextType.AFTER_TABLE_NAME,
                prefix: keywordFallbackMatch[1],
            };
        }
    }

    // Capture prefix for statement-start keyword suggestions
    const nonePrefix = textBeforeCursor.match(/\b(\w+)$/i);
    return { type: SqlContextType.NONE, prefix: nonePrefix ? nonePrefix[1] : undefined };
}
