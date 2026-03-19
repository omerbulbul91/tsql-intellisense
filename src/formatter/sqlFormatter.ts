import { tokenize } from './sqlTokenizer';
import { applyCasingInPlace } from './casingRule';
import { applyLayout } from './layoutRule';
import { StyleLoader } from './styleLoader';

export class SqlFormatter {
    constructor(private styleLoader: StyleLoader) {}

    format(sql: string): string {
        const tokens = tokenize(sql);
        applyCasingInPlace(tokens, this.styleLoader.getCasingOptions());
        return applyLayout(tokens, this.styleLoader.getLayoutOptions());
    }
}
