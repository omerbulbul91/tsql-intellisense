import * as fs from 'fs';
import { CasingOptions, CasingMode } from './casingRule';

export interface SqlStyle {
    metadata?: { id?: string; name?: string };
    casing?: {
        reservedKeywords?: string;
        builtInFunctions?: string;
        builtInDataTypes?: string;
        useObjectDefinitionCase?: boolean;
    };
}

const DEFAULT_STYLE: CasingOptions = {
    reservedKeywords: 'upperCamelCase',
    builtInFunctions: 'uppercase',
    builtInDataTypes: 'upperCamelCase',
};

const VALID_MODES: Set<string> = new Set(['uppercase', 'lowercase', 'upperCamelCase', 'leaveAsIs']);

function validateMode(value: string | undefined, fallback: CasingMode): CasingMode {
    if (value && VALID_MODES.has(value)) return value as CasingMode;
    return fallback;
}

export class StyleLoader {
    private options: CasingOptions = { ...DEFAULT_STYLE };
    private styleName: string = 'RENIUMSTYLE (default)';

    constructor(private outputChannel?: { appendLine(msg: string): void }) {}

    async loadFromFile(filePath: string): Promise<void> {
        if (!filePath) {
            this.options = { ...DEFAULT_STYLE };
            this.styleName = 'RENIUMSTYLE (default)';
            this.log(`No style file configured — using default RENIUMSTYLE`);
            return;
        }

        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const style: SqlStyle = JSON.parse(content);

            this.styleName = style.metadata?.name || filePath.split(/[/\\]/).pop() || 'Unknown';
            if (style.casing) {
                this.options = {
                    reservedKeywords: validateMode(style.casing.reservedKeywords, DEFAULT_STYLE.reservedKeywords),
                    builtInFunctions: validateMode(style.casing.builtInFunctions, DEFAULT_STYLE.builtInFunctions),
                    builtInDataTypes: validateMode(style.casing.builtInDataTypes, DEFAULT_STYLE.builtInDataTypes),
                };
            } else {
                this.log(`Style "${this.styleName}" has no casing section — using default`);
                this.options = { ...DEFAULT_STYLE };
            }

            this.log(`Loaded style "${this.styleName}" from ${filePath}`);
            this.log(`  keywords: ${this.options.reservedKeywords}, functions: ${this.options.builtInFunctions}, datatypes: ${this.options.builtInDataTypes}`);
        } catch (err: any) {
            this.log(`Error loading style from ${filePath}: ${err.message} — using default`);
            this.options = { ...DEFAULT_STYLE };
            this.styleName = 'RENIUMSTYLE (default)';
        }
    }

    applyOverrides(casing: { reservedKeywords?: string; builtInFunctions?: string; builtInDataTypes?: string }): void {
        this.options = {
            reservedKeywords: validateMode(casing.reservedKeywords, this.options.reservedKeywords),
            builtInFunctions: validateMode(casing.builtInFunctions, this.options.builtInFunctions),
            builtInDataTypes: validateMode(casing.builtInDataTypes, this.options.builtInDataTypes),
        };
        this.styleName = 'Custom (manual)';
        this.log(`Applied manual overrides: keywords=${this.options.reservedKeywords}, functions=${this.options.builtInFunctions}, datatypes=${this.options.builtInDataTypes}`);
    }

    getCasingOptions(): CasingOptions { return this.options; }
    getStyleName(): string { return this.styleName; }

    private log(msg: string) {
        this.outputChannel?.appendLine(msg);
    }
}
