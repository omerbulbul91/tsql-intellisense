import * as fs from 'fs';
import { CasingOptions, CasingMode } from './casingRule';
import { LayoutOptions } from './layoutRule';
import { CaseOptions, DEFAULT_CASE_OPTIONS } from './caseRule';

export interface SqlStyle {
    metadata?: { id?: string; name?: string };
    casing?: {
        reservedKeywords?: string;
        builtInFunctions?: string;
        builtInDataTypes?: string;
        useObjectDefinitionCase?: boolean;
    };
    lists?: {
        placeCommasBeforeItems?: boolean;
        alignItemsToTabStops?: boolean;
    };
}

const DEFAULT_CASING: CasingOptions = {
    reservedKeywords: 'upperCamelCase',
    builtInFunctions: 'uppercase',
    builtInDataTypes: 'upperCamelCase',
};

const DEFAULT_LAYOUT: LayoutOptions = {
    maxLineLength: 120,
    placeCommasBeforeItems: true,
    alignItemsToTabStops: true,
};

const VALID_MODES: Set<string> = new Set(['uppercase', 'lowercase', 'upperCamelCase', 'leaveAsIs']);

function validateMode(value: string | undefined, fallback: CasingMode): CasingMode {
    if (value && VALID_MODES.has(value)) return value as CasingMode;
    return fallback;
}

export class StyleLoader {
    private casingOptions: CasingOptions = { ...DEFAULT_CASING };
    private layoutOptions: LayoutOptions = { ...DEFAULT_LAYOUT };
    private caseOptions: CaseOptions = { ...DEFAULT_CASE_OPTIONS };
    private styleName: string = 'RENIUMSTYLE (default)';

    constructor(private outputChannel?: { appendLine(msg: string): void }) {}

    async loadFromFile(filePath: string): Promise<void> {
        if (!filePath) {
            this.casingOptions = { ...DEFAULT_CASING };
            this.layoutOptions = { ...DEFAULT_LAYOUT };
            this.caseOptions = { ...DEFAULT_CASE_OPTIONS };
            this.styleName = 'RENIUMSTYLE (default)';
            this.log(`No style file configured — using default RENIUMSTYLE`);
            return;
        }

        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const style: SqlStyle = JSON.parse(content);

            this.styleName = style.metadata?.name || filePath.split(/[/\\]/).pop() || 'Unknown';

            // Casing
            if (style.casing) {
                this.casingOptions = {
                    reservedKeywords: validateMode(style.casing.reservedKeywords, DEFAULT_CASING.reservedKeywords),
                    builtInFunctions: validateMode(style.casing.builtInFunctions, DEFAULT_CASING.builtInFunctions),
                    builtInDataTypes: validateMode(style.casing.builtInDataTypes, DEFAULT_CASING.builtInDataTypes),
                };
            } else {
                this.casingOptions = { ...DEFAULT_CASING };
            }

            // Layout
            if (style.lists) {
                this.layoutOptions = {
                    maxLineLength: this.layoutOptions.maxLineLength, // preserved from settings
                    placeCommasBeforeItems: style.lists.placeCommasBeforeItems ?? DEFAULT_LAYOUT.placeCommasBeforeItems,
                    alignItemsToTabStops: style.lists.alignItemsToTabStops ?? DEFAULT_LAYOUT.alignItemsToTabStops,
                };
            } else {
                this.layoutOptions = { ...DEFAULT_LAYOUT, maxLineLength: this.layoutOptions.maxLineLength };
            }

            this.log(`Loaded style "${this.styleName}" from ${filePath}`);
            this.log(`  casing: kw=${this.casingOptions.reservedKeywords}, fn=${this.casingOptions.builtInFunctions}, dt=${this.casingOptions.builtInDataTypes}`);
            this.log(`  layout: commasBefore=${this.layoutOptions.placeCommasBeforeItems}, tabStops=${this.layoutOptions.alignItemsToTabStops}, maxLine=${this.layoutOptions.maxLineLength}`);
        } catch (err: any) {
            this.log(`Error loading style from ${filePath}: ${err.message} — using default`);
            this.casingOptions = { ...DEFAULT_CASING };
            this.layoutOptions = { ...DEFAULT_LAYOUT };
            this.caseOptions = { ...DEFAULT_CASE_OPTIONS };
            this.styleName = 'RENIUMSTYLE (default)';
        }
    }

    setMaxLineLength(value: number): void {
        this.layoutOptions.maxLineLength = value > 0 ? value : 0;
    }

    applyOverrides(overrides: {
        reservedKeywords?: string;
        builtInFunctions?: string;
        builtInDataTypes?: string;
        lists?: {
            placeCommasBeforeItems?: boolean;
            alignItemsToTabStops?: boolean;
        };
        caseExpressions?: Partial<CaseOptions>;
    }): void {
        this.casingOptions = {
            reservedKeywords: validateMode(overrides.reservedKeywords, this.casingOptions.reservedKeywords),
            builtInFunctions: validateMode(overrides.builtInFunctions, this.casingOptions.builtInFunctions),
            builtInDataTypes: validateMode(overrides.builtInDataTypes, this.casingOptions.builtInDataTypes),
        };
        if (overrides.lists) {
            this.layoutOptions = {
                ...this.layoutOptions,
                placeCommasBeforeItems: overrides.lists.placeCommasBeforeItems ?? this.layoutOptions.placeCommasBeforeItems,
                alignItemsToTabStops: overrides.lists.alignItemsToTabStops ?? this.layoutOptions.alignItemsToTabStops,
            };
        }
        if (overrides.caseExpressions) {
            this.caseOptions = { ...this.caseOptions, ...overrides.caseExpressions };
        }
        this.styleName = 'Custom (manual)';
        this.log(`Applied overrides: kw=${this.casingOptions.reservedKeywords}, fn=${this.casingOptions.builtInFunctions}, dt=${this.casingOptions.builtInDataTypes}`);
    }

    getCasingOptions(): CasingOptions { return this.casingOptions; }
    getLayoutOptions(): LayoutOptions { return this.layoutOptions; }
    getCaseOptions(): CaseOptions { return this.caseOptions; }
    getStyleName(): string { return this.styleName; }

    private log(msg: string) {
        this.outputChannel?.appendLine(msg);
    }
}
