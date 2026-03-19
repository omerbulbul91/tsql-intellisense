import { Token } from './sqlTokenizer';

export type CasingMode = 'uppercase' | 'lowercase' | 'upperCamelCase' | 'leaveAsIs';

export interface CasingOptions {
    reservedKeywords: CasingMode;
    builtInFunctions: CasingMode;
    builtInDataTypes: CasingMode;
}

function applyMode(value: string, mode: CasingMode): string {
    switch (mode) {
        case 'uppercase': return value.toUpperCase();
        case 'lowercase': return value.toLowerCase();
        case 'upperCamelCase': return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
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
