import { tokenize } from './sqlTokenizer';
import { applyCasing } from './casingRule';
import { StyleLoader } from './styleLoader';

export class SqlFormatter {
    constructor(private styleLoader: StyleLoader) {}

    format(sql: string): string {
        const tokens = tokenize(sql);
        const options = this.styleLoader.getCasingOptions();
        return applyCasing(tokens, options);
    }
}
