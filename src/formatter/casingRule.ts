import { Token } from './sqlTokenizer';

export type CasingMode = 'uppercase' | 'lowercase' | 'upperCamelCase' | 'leaveAsIs';

export interface CasingOptions {
    reservedKeywords: CasingMode;
    builtInFunctions: CasingMode;
    builtInDataTypes: CasingMode;
}

// Known compound words → UpperCamelCase form (no underscore boundary)
const UPPER_CAMEL_OVERRIDES: Record<string, string> = {
    // Keywords
    'NOCOUNT': 'NoCount', 'NOLOCK': 'NoLock',
    'HOLDLOCK': 'HoldLock', 'UPDLOCK': 'UpdLock', 'ROWLOCK': 'RowLock', 'TABLOCK': 'TabLock',
    'READUNCOMMITTED': 'ReadUncommitted', 'READCOMMITTED': 'ReadCommitted',
    'ARITHABORT': 'ArithAbort', 'ROWGUIDCOL': 'RowGuidCol',
    // Datatypes
    'NVARCHAR': 'NVarchar', 'NCHAR': 'NChar', 'NTEXT': 'NText',
    'BIGINT': 'BigInt', 'SMALLINT': 'SmallInt', 'TINYINT': 'TinyInt',
    'DATETIME': 'DateTime', 'DATETIME2': 'DateTime2',
    'SMALLDATETIME': 'SmallDateTime', 'DATETIMEOFFSET': 'DateTimeOffset',
    'UNIQUEIDENTIFIER': 'UniqueIdentifier', 'VARBINARY': 'VarBinary',
    'ROWVERSION': 'RowVersion', 'SMALLMONEY': 'SmallMoney',
};

function toUpperCamelCase(value: string): string {
    const upper = value.toUpperCase();
    if (UPPER_CAMEL_OVERRIDES[upper]) return UPPER_CAMEL_OVERRIDES[upper];
    // Handle underscore-separated words: XACT_ABORT → Xact_Abort
    if (value.includes('_')) {
        return value.split('_').map(part =>
            part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
        ).join('_');
    }
    return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function applyMode(value: string, mode: CasingMode): string {
    switch (mode) {
        case 'uppercase': return value.toUpperCase();
        case 'lowercase': return value.toLowerCase();
        case 'upperCamelCase': return toUpperCamelCase(value);
        case 'leaveAsIs': return value;
    }
}

export function applyCasing(tokens: Token[], options: CasingOptions): string {
    return tokens.map(token => {
        switch (token.type) {
            case 'keyword':
                return applyMode(token.value, options.reservedKeywords);
            case 'function':
                return applyMode(token.value, options.builtInFunctions);
            case 'datatype':
                return applyMode(token.value, options.builtInDataTypes);
            default:
                return token.value;
        }
    }).join('');
}

export function applyCasingInPlace(tokens: Token[], options: CasingOptions): void {
    for (const token of tokens) {
        switch (token.type) {
            case 'keyword':
                token.value = applyMode(token.value, options.reservedKeywords);
                break;
            case 'function':
                token.value = applyMode(token.value, options.builtInFunctions);
                break;
            case 'datatype':
                token.value = applyMode(token.value, options.builtInDataTypes);
                break;
        }
    }
}
