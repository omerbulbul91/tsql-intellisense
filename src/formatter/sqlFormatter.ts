import { tokenize } from './sqlTokenizer';
import { applyCasingInPlace } from './casingRule';
import { applyLayout } from './layoutRule';
import { applyCaseFormatting } from './caseRule';
import { StyleLoader } from './styleLoader';

export class SqlFormatter {
    constructor(private styleLoader: StyleLoader) {}

    format(sql: string): string {
        const tokens = tokenize(sql);
        applyCasingInPlace(tokens, this.styleLoader.getCasingOptions());
        const layoutResult = applyLayout(tokens, this.styleLoader.getLayoutOptions());
        // Re-tokenize for CASE formatting (layout changes whitespace)
        const casedTokens = tokenize(layoutResult);
        return applyCaseFormatting(layoutResult, this.styleLoader.getCaseOptions(), casedTokens);
    }
}
