export type TokenType =
    | 'keyword' | 'function' | 'datatype' | 'identifier'
    | 'string' | 'comment' | 'number' | 'operator'
    | 'punctuation' | 'whitespace';

export interface Token {
    type: TokenType;
    value: string;
    offset: number;
}

const KEYWORDS = new Set([
    'SELECT', 'FROM', 'WHERE', 'JOIN', 'ON', 'AND', 'OR', 'NOT', 'IN', 'EXISTS',
    'BETWEEN', 'LIKE', 'IS', 'NULL', 'AS', 'BY', 'ORDER', 'GROUP', 'HAVING',
    'DISTINCT', 'TOP', 'INTO', 'VALUES', 'UNION', 'ALL', 'ANY', 'SOME',
    'CROSS', 'FULL', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'WITH', 'OVER', 'PARTITION',
    'INSERT', 'UPDATE', 'DELETE', 'SET', 'EXEC', 'EXECUTE',
    'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
    'DECLARE', 'BEGIN', 'END', 'IF', 'ELSE', 'WHILE', 'RETURN', 'BREAK', 'CONTINUE',
    'TRY', 'CATCH', 'THROW', 'RAISERROR',
    'CASE', 'WHEN', 'THEN',
    'GO', 'PRINT', 'USE',
    'TRANSACTION', 'COMMIT', 'ROLLBACK', 'SAVE',
    'PROCEDURE', 'PROC', 'FUNCTION', 'TABLE', 'VIEW', 'INDEX', 'TRIGGER',
    'DATABASE', 'SCHEMA',
    'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT', 'DEFAULT', 'CHECK', 'UNIQUE',
    'CLUSTERED', 'NONCLUSTERED', 'ASC', 'DESC',
    'OUTPUT', 'RETURNS', 'READONLY',
    'PIVOT', 'UNPIVOT', 'EXCEPT', 'INTERSECT',
    'MERGE', 'MATCHED', 'SOURCE', 'TARGET',
    'GRANT', 'REVOKE', 'DENY',
    'CURSOR', 'OPEN', 'CLOSE', 'FETCH', 'NEXT', 'DEALLOCATE',
    'NOLOCK', 'HOLDLOCK', 'UPDLOCK', 'ROWLOCK', 'TABLOCK',
    'READUNCOMMITTED', 'READCOMMITTED',
    'OPTION', 'RECOMPILE', 'MAXDOP',
    'EXISTS', 'APPLY', 'TABLESAMPLE', 'PERCENT',
    'WAITFOR', 'DELAY', 'GOTO', 'LABEL',
    'TRAN', 'WORK', 'DISTRIBUTED',
    'IDENTITY', 'ROWGUIDCOL', 'NOT', 'FOR', 'AFTER', 'INSTEAD', 'OF',
    'ENABLE', 'DISABLE', 'REBUILD', 'REORGANIZE',
    'ADD', 'COLUMN', 'MODIFY', 'TYPE',
    'AUTHORIZATION', 'ENCRYPTION', 'ANSI_NULLS', 'QUOTED_IDENTIFIER',
    'NOCOUNT', 'XACT_ABORT', 'ARITHABORT', 'CONCAT_NULL_YIELDS_NULL',
]);

const FUNCTIONS = new Set([
    'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'STRING_AGG', 'CHECKSUM_AGG', 'COUNT_BIG',
    'STDEV', 'STDEVP', 'VAR', 'VARP',
    'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'LAG', 'LEAD',
    'FIRST_VALUE', 'LAST_VALUE', 'PERCENT_RANK', 'CUME_DIST',
    'CAST', 'CONVERT', 'TRY_CAST', 'TRY_CONVERT', 'PARSE', 'TRY_PARSE',
    'LEN', 'DATALENGTH', 'SUBSTRING', 'CHARINDEX', 'PATINDEX',
    'REPLACE', 'STUFF', 'TRIM', 'LTRIM', 'RTRIM', 'UPPER', 'LOWER', 'REVERSE',
    'REPLICATE', 'SPACE', 'CONCAT', 'CONCAT_WS', 'STRING_SPLIT', 'QUOTENAME',
    'CHAR', 'ASCII', 'UNICODE', 'NCHAR', 'FORMAT',
    'GETDATE', 'GETUTCDATE', 'SYSDATETIME', 'SYSUTCDATETIME',
    'DATEADD', 'DATEDIFF', 'DATEDIFF_BIG', 'DATENAME', 'DATEPART',
    'YEAR', 'MONTH', 'DAY', 'EOMONTH', 'DATEFROMPARTS', 'DATETIME2FROMPARTS',
    'ISDATE', 'SWITCHOFFSET', 'TODATETIMEOFFSET',
    'ABS', 'CEILING', 'FLOOR', 'ROUND', 'POWER', 'SQRT', 'SIGN', 'LOG', 'LOG10', 'EXP',
    'RAND', 'PI', 'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'ATN2',
    'ISNULL', 'COALESCE', 'NULLIF', 'IIF', 'CHOOSE',
    'NEWID', 'NEWSEQUENTIALID', 'SCOPE_IDENTITY', 'IDENT_CURRENT',
    '@@IDENTITY', '@@ROWCOUNT', '@@ERROR', '@@TRANCOUNT',
    '@@FETCH_STATUS', '@@CURSOR_ROWS', '@@SPID', '@@SERVERNAME', '@@VERSION',
    'OBJECT_ID', 'OBJECT_NAME', 'OBJECT_DEFINITION', 'DB_ID', 'DB_NAME',
    'SCHEMA_ID', 'SCHEMA_NAME', 'TYPE_ID', 'TYPE_NAME',
    'COL_NAME', 'COL_LENGTH', 'COLUMNPROPERTY',
    'USER_NAME', 'SUSER_SNAME', 'SYSTEM_USER', 'SESSION_USER',
    'HOST_NAME', 'APP_NAME', 'ERROR_MESSAGE', 'ERROR_NUMBER', 'ERROR_SEVERITY',
    'ERROR_STATE', 'ERROR_LINE', 'ERROR_PROCEDURE',
    'JSON_VALUE', 'JSON_QUERY', 'JSON_MODIFY', 'ISJSON', 'OPENJSON',
    'NODES', 'VALUE', 'QUERY', 'EXIST',
]);

const AMBIGUOUS_FUNCTION_KEYWORDS = new Set([
    'LEFT', 'RIGHT',
]);

const DATATYPES = new Set([
    'INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'BIT',
    'DECIMAL', 'NUMERIC', 'FLOAT', 'REAL', 'MONEY', 'SMALLMONEY',
    'CHAR', 'VARCHAR', 'NCHAR', 'NVARCHAR', 'TEXT', 'NTEXT',
    'DATE', 'DATETIME', 'DATETIME2', 'SMALLDATETIME', 'TIME', 'DATETIMEOFFSET',
    'UNIQUEIDENTIFIER', 'XML', 'SQL_VARIANT',
    'BINARY', 'VARBINARY', 'IMAGE', 'TIMESTAMP', 'ROWVERSION',
    'GEOGRAPHY', 'GEOMETRY', 'HIERARCHYID',
    'SYSNAME',
]);

const AMBIGUOUS_KEYWORD_DATATYPES = new Set(['CURSOR', 'TABLE']);

export function tokenize(sql: string): Token[] {
    const tokens: Token[] = [];
    let pos = 0;
    const len = sql.length;

    while (pos < len) {
        const ch = sql[pos];

        // 1. String: '...' or N'...'
        if (ch === "'" || (ch.toUpperCase() === 'N' && pos + 1 < len && sql[pos + 1] === "'")) {
            const start = pos;
            if (ch.toUpperCase() === 'N') pos++;
            pos++;
            while (pos < len) {
                if (sql[pos] === "'" && pos + 1 < len && sql[pos + 1] === "'") {
                    pos += 2;
                } else if (sql[pos] === "'") {
                    pos++;
                    break;
                } else {
                    pos++;
                }
            }
            tokens.push({ type: 'string', value: sql.slice(start, pos), offset: start });
            continue;
        }

        // 2. Line comment: --
        if (ch === '-' && pos + 1 < len && sql[pos + 1] === '-') {
            const start = pos;
            pos += 2;
            while (pos < len && sql[pos] !== '\n') pos++;
            if (pos < len) pos++;
            tokens.push({ type: 'comment', value: sql.slice(start, pos), offset: start });
            continue;
        }

        // 2b. Block comment: /* ... */
        if (ch === '/' && pos + 1 < len && sql[pos + 1] === '*') {
            const start = pos;
            pos += 2;
            while (pos < len) {
                if (sql[pos] === '*' && pos + 1 < len && sql[pos + 1] === '/') {
                    pos += 2;
                    break;
                }
                pos++;
            }
            tokens.push({ type: 'comment', value: sql.slice(start, pos), offset: start });
            continue;
        }

        // 3. Bracketed identifier: [...]
        if (ch === '[') {
            const start = pos;
            pos++;
            while (pos < len && sql[pos] !== ']') pos++;
            if (pos < len) pos++;
            tokens.push({ type: 'identifier', value: sql.slice(start, pos), offset: start });
            continue;
        }

        // 4. Number: digits, hex
        if (/[0-9]/.test(ch) || (ch === '0' && pos + 1 < len && sql[pos + 1].toLowerCase() === 'x')) {
            const start = pos;
            if (ch === '0' && pos + 1 < len && sql[pos + 1].toLowerCase() === 'x') {
                pos += 2;
                while (pos < len && /[0-9a-fA-F]/.test(sql[pos])) pos++;
            } else {
                while (pos < len && /[0-9]/.test(sql[pos])) pos++;
                if (pos < len && sql[pos] === '.' && pos + 1 < len && /[0-9]/.test(sql[pos + 1])) {
                    pos++;
                    while (pos < len && /[0-9]/.test(sql[pos])) pos++;
                }
            }
            tokens.push({ type: 'number', value: sql.slice(start, pos), offset: start });
            continue;
        }

        // 5. Multi-char operators
        if (pos + 1 < len) {
            const two = sql.slice(pos, pos + 2);
            if (two === '<>' || two === '>=' || two === '<=' || two === '!=' || two === '+=') {
                tokens.push({ type: 'operator', value: two, offset: pos });
                pos += 2;
                continue;
            }
        }

        // 5b. Single-char operators
        if ('=<>+-*/%'.includes(ch)) {
            tokens.push({ type: 'operator', value: ch, offset: pos });
            pos++;
            continue;
        }

        // 6. Punctuation
        if ('(),;.'.includes(ch)) {
            tokens.push({ type: 'punctuation', value: ch, offset: pos });
            pos++;
            continue;
        }

        // 7. Whitespace
        if (/\s/.test(ch)) {
            const start = pos;
            while (pos < len && /\s/.test(sql[pos])) pos++;
            tokens.push({ type: 'whitespace', value: sql.slice(start, pos), offset: start });
            continue;
        }

        // 8. Word: identifier/keyword/function/datatype
        if (/[a-zA-Z_@#]/.test(ch)) {
            const start = pos;
            while (pos < len && /[a-zA-Z0-9_@#]/.test(sql[pos])) pos++;
            const word = sql.slice(start, pos);
            const upper = word.toUpperCase();

            let type: TokenType;
            if (FUNCTIONS.has(upper) && !AMBIGUOUS_FUNCTION_KEYWORDS.has(upper)) {
                type = 'function';
            } else if (AMBIGUOUS_FUNCTION_KEYWORDS.has(upper)) {
                type = 'keyword';
            } else if (DATATYPES.has(upper) && !AMBIGUOUS_KEYWORD_DATATYPES.has(upper)) {
                type = 'datatype';
            } else if (AMBIGUOUS_KEYWORD_DATATYPES.has(upper)) {
                type = 'datatype';
            } else if (KEYWORDS.has(upper)) {
                type = 'keyword';
            } else {
                type = 'identifier';
            }

            tokens.push({ type, value: word, offset: start });
            continue;
        }

        // Unknown character
        tokens.push({ type: 'punctuation', value: ch, offset: pos });
        pos++;
    }

    // Post-processing: disambiguate LEFT/RIGHT
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type !== 'keyword') continue;
        const upper = t.value.toUpperCase();
        if (!AMBIGUOUS_FUNCTION_KEYWORDS.has(upper)) continue;

        let next: Token | undefined;
        for (let j = i + 1; j < tokens.length; j++) {
            if (tokens[j].type !== 'whitespace') { next = tokens[j]; break; }
        }
        if (next && next.type === 'punctuation' && next.value === '(') {
            t.type = 'function';
        }
    }

    return tokens;
}

export { KEYWORDS, FUNCTIONS, DATATYPES };
