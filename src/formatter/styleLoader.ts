import * as fs from 'fs';
import { CasingOptions, CasingMode } from './casingRule';
import { LayoutOptions, JoinOptions } from './layoutRule';
import { CaseOptions, DEFAULT_CASE_OPTIONS } from './caseRule';

// ─── New config interfaces ───

export interface WhitespaceOptions {
    spacesOrTabs: 'spaces' | 'tabs';
    numberOfSpacesInTabs: number;
    wrapLinesLongerThan: number;
    emptyLinesBetweenStatements: number;
    emptyLinesAfterBatchSeparator: number;
    preserveExistingEmptyLinesBetweenStatements: boolean;
    preserveExistingEmptyLinesWithinStatements: boolean;
    alignGroupsOfSingleLineComments: boolean;
    alignMultilineCommentsMatchingCommonPatterns: boolean;
}

export interface ControlFlowOptions {
    placeBeginOnNewLine: boolean;
    indentBeginEndKeywords: boolean;
    indentContentsOfStatements: boolean;
    collapseShortStatements: boolean;
    collapseShortStatementsShorterThan: number;
}

export interface VariablesOptions {
    declareAlignDataTypesAndValues: boolean;
    declareAddSpaceBetweenTypeAndPrecision: boolean;
    setPlaceAssignedValueOnNewLine: boolean;
    setPlaceEqualsSignOnNewLine: boolean;
}

export interface DataDmlOptions {
    clauseAlignment: 'toStatement' | 'toKeyword';
    clauseIndentation: number;
    placeFromTableOnNewLine: 'never' | 'always' | 'ifLong';
    placeWhereConditionOnNewLine: 'never' | 'always' | 'ifLong';
    placeGroupByOrderByExpressionOnNewLine: 'never' | 'always' | 'ifLong';
    placeInsertTableOnNewLine: boolean;
    placeDistinctTopOnNewLine: boolean;
    addNewLineAfterDistinctTop: boolean;
    collapseShortDmlStatements: boolean;
    collapseShortDmlShorterThan: number;
    collapseSubqueriesShorterThan: number;
}

export interface SchemaDdlOptions {
    parenthesesStyle: 'openAtEnd' | 'openOnNewLine' | 'openInline';
    indentParenthesesContents: boolean;
    alignDataTypesAndConstraints: boolean;
    placeConstraintsOnNewLines: boolean;
    placeConstraintColumnsOnNewLines: 'never' | 'always' | 'ifLongerOrMultiple';
    indentClauses: boolean;
    placeFirstProcedureParameterOnNewLine: 'never' | 'always' | 'ifMultiple';
    collapseShortDdlStatements: boolean;
    collapseShortDdlShorterThan: number;
}

// ─── Existing interfaces ───

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
    joinStatements?: {
        on?: {
            placeOnNewLine?: boolean;
            placeConditionOnNewLine?: boolean;
            conditionAlignment?: string;
        };
    };
    whitespace?: Partial<WhitespaceOptions>;
    controlFlow?: Partial<ControlFlowOptions>;
    variables?: Partial<VariablesOptions>;
    dataDml?: Partial<DataDmlOptions>;
    schemaDdl?: Partial<SchemaDdlOptions>;
}

// ─── Defaults ───

const DEFAULT_CASING: CasingOptions = {
    reservedKeywords: 'upperCamelCase',
    builtInFunctions: 'uppercase',
    builtInDataTypes: 'upperCamelCase',
};

const DEFAULT_JOIN: JoinOptions = {
    placeOnNewLine: false,
    placeConditionOnNewLine: true,
    conditionAlignment: 'toTable',
};

const DEFAULT_LAYOUT: LayoutOptions = {
    maxLineLength: 120,
    placeCommasBeforeItems: true,
    alignItemsToTabStops: true,
    qualifyObjectNames: true,
    join: { ...DEFAULT_JOIN },
};

const DEFAULT_WHITESPACE: WhitespaceOptions = {
    spacesOrTabs: 'spaces',
    numberOfSpacesInTabs: 4,
    wrapLinesLongerThan: 120,
    emptyLinesBetweenStatements: 1,
    emptyLinesAfterBatchSeparator: 1,
    preserveExistingEmptyLinesBetweenStatements: false,
    preserveExistingEmptyLinesWithinStatements: false,
    alignGroupsOfSingleLineComments: true,
    alignMultilineCommentsMatchingCommonPatterns: true,
};

const DEFAULT_CONTROL_FLOW: ControlFlowOptions = {
    placeBeginOnNewLine: false,
    indentBeginEndKeywords: false,
    indentContentsOfStatements: true,
    collapseShortStatements: false,
    collapseShortStatementsShorterThan: 78,
};

const DEFAULT_VARIABLES: VariablesOptions = {
    declareAlignDataTypesAndValues: false,
    declareAddSpaceBetweenTypeAndPrecision: false,
    setPlaceAssignedValueOnNewLine: false,
    setPlaceEqualsSignOnNewLine: true,
};

const DEFAULT_DATA_DML: DataDmlOptions = {
    clauseAlignment: 'toStatement',
    clauseIndentation: 0,
    placeFromTableOnNewLine: 'never',
    placeWhereConditionOnNewLine: 'never',
    placeGroupByOrderByExpressionOnNewLine: 'never',
    placeInsertTableOnNewLine: false,
    placeDistinctTopOnNewLine: false,
    addNewLineAfterDistinctTop: true,
    collapseShortDmlStatements: true,
    collapseShortDmlShorterThan: 120,
    collapseSubqueriesShorterThan: 120,
};

const DEFAULT_SCHEMA_DDL: SchemaDdlOptions = {
    parenthesesStyle: 'openAtEnd',
    indentParenthesesContents: true,
    alignDataTypesAndConstraints: true,
    placeConstraintsOnNewLines: true,
    placeConstraintColumnsOnNewLines: 'ifLongerOrMultiple',
    indentClauses: false,
    placeFirstProcedureParameterOnNewLine: 'always',
    collapseShortDdlStatements: true,
    collapseShortDdlShorterThan: 120,
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
    private whitespaceOptions: WhitespaceOptions = { ...DEFAULT_WHITESPACE };
    private controlFlowOptions: ControlFlowOptions = { ...DEFAULT_CONTROL_FLOW };
    private variablesOptions: VariablesOptions = { ...DEFAULT_VARIABLES };
    private dataDmlOptions: DataDmlOptions = { ...DEFAULT_DATA_DML };
    private schemaDdlOptions: SchemaDdlOptions = { ...DEFAULT_SCHEMA_DDL };
    private styleName: string = 'RENIUMSTYLE (default)';

    constructor(private outputChannel?: { appendLine(msg: string): void }) {}

    async loadFromFile(filePath: string): Promise<void> {
        if (!filePath) {
            this.resetToDefaults();
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
                    maxLineLength: this.layoutOptions.maxLineLength,
                    placeCommasBeforeItems: style.lists.placeCommasBeforeItems ?? DEFAULT_LAYOUT.placeCommasBeforeItems,
                    alignItemsToTabStops: style.lists.alignItemsToTabStops ?? DEFAULT_LAYOUT.alignItemsToTabStops,
                    qualifyObjectNames: this.layoutOptions.qualifyObjectNames,
                };
            } else {
                this.layoutOptions = { ...DEFAULT_LAYOUT, maxLineLength: this.layoutOptions.maxLineLength };
            }

            // Join options from style file
            if (style.joinStatements?.on) {
                const on = style.joinStatements.on;
                this.layoutOptions.join = {
                    placeOnNewLine: on.placeOnNewLine ?? DEFAULT_JOIN.placeOnNewLine,
                    placeConditionOnNewLine: on.placeConditionOnNewLine ?? DEFAULT_JOIN.placeConditionOnNewLine,
                    conditionAlignment: (on.conditionAlignment as any) ?? DEFAULT_JOIN.conditionAlignment,
                };
            }

            // New config sections
            if (style.whitespace) {
                this.whitespaceOptions = { ...DEFAULT_WHITESPACE, ...style.whitespace };
                // Sync maxLineLength from whitespace
                this.layoutOptions.maxLineLength = this.whitespaceOptions.wrapLinesLongerThan;
            }
            if (style.controlFlow) {
                this.controlFlowOptions = { ...DEFAULT_CONTROL_FLOW, ...style.controlFlow };
            }
            if (style.variables) {
                this.variablesOptions = { ...DEFAULT_VARIABLES, ...style.variables };
            }
            if (style.dataDml) {
                this.dataDmlOptions = { ...DEFAULT_DATA_DML, ...style.dataDml };
            }
            if (style.schemaDdl) {
                this.schemaDdlOptions = { ...DEFAULT_SCHEMA_DDL, ...style.schemaDdl };
            }

            this.log(`Loaded style "${this.styleName}" from ${filePath}`);
            this.log(`  casing: kw=${this.casingOptions.reservedKeywords}, fn=${this.casingOptions.builtInFunctions}, dt=${this.casingOptions.builtInDataTypes}`);
            this.log(`  layout: commasBefore=${this.layoutOptions.placeCommasBeforeItems}, tabStops=${this.layoutOptions.alignItemsToTabStops}, maxLine=${this.layoutOptions.maxLineLength}`);
        } catch (err: any) {
            this.log(`Error loading style from ${filePath}: ${err.message} — using default`);
            this.resetToDefaults();
        }
    }

    private resetToDefaults(): void {
        this.casingOptions = { ...DEFAULT_CASING };
        this.layoutOptions = { ...DEFAULT_LAYOUT };
        this.caseOptions = { ...DEFAULT_CASE_OPTIONS };
        this.whitespaceOptions = { ...DEFAULT_WHITESPACE };
        this.controlFlowOptions = { ...DEFAULT_CONTROL_FLOW };
        this.variablesOptions = { ...DEFAULT_VARIABLES };
        this.dataDmlOptions = { ...DEFAULT_DATA_DML };
        this.schemaDdlOptions = { ...DEFAULT_SCHEMA_DDL };
        this.styleName = 'RENIUMSTYLE (default)';
    }

    setMaxLineLength(value: number): void {
        this.layoutOptions.maxLineLength = value > 0 ? value : 0;
        this.whitespaceOptions.wrapLinesLongerThan = this.layoutOptions.maxLineLength;
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
        whitespace?: Partial<WhitespaceOptions>;
        controlFlow?: Partial<ControlFlowOptions>;
        variables?: Partial<VariablesOptions>;
        dataDml?: Partial<DataDmlOptions>;
        schemaDdl?: Partial<SchemaDdlOptions>;
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
        if (overrides.whitespace) {
            this.whitespaceOptions = { ...this.whitespaceOptions, ...overrides.whitespace };
        }
        if (overrides.controlFlow) {
            this.controlFlowOptions = { ...this.controlFlowOptions, ...overrides.controlFlow };
        }
        if (overrides.variables) {
            this.variablesOptions = { ...this.variablesOptions, ...overrides.variables };
        }
        if (overrides.dataDml) {
            this.dataDmlOptions = { ...this.dataDmlOptions, ...overrides.dataDml };
        }
        if (overrides.schemaDdl) {
            this.schemaDdlOptions = { ...this.schemaDdlOptions, ...overrides.schemaDdl };
        }
        this.styleName = 'Custom (manual)';
        this.log(`Applied overrides: kw=${this.casingOptions.reservedKeywords}, fn=${this.casingOptions.builtInFunctions}, dt=${this.casingOptions.builtInDataTypes}`);
    }

    /**
     * Create a shallow clone with overrides applied — used for live preview without saving.
     */
    cloneWithOverrides(overrides: {
        reservedKeywords?: string;
        builtInFunctions?: string;
        builtInDataTypes?: string;
        lists?: { placeCommasBeforeItems?: boolean; alignItemsToTabStops?: boolean };
        caseExpressions?: Partial<CaseOptions>;
        whitespace?: Partial<WhitespaceOptions>;
        controlFlow?: Partial<ControlFlowOptions>;
        variables?: Partial<VariablesOptions>;
        dataDml?: Partial<DataDmlOptions>;
        schemaDdl?: Partial<SchemaDdlOptions>;
    }): StyleLoader {
        const clone = new StyleLoader();
        clone.casingOptions = { ...this.casingOptions };
        clone.layoutOptions = { ...this.layoutOptions };
        clone.caseOptions = { ...this.caseOptions };
        clone.whitespaceOptions = { ...this.whitespaceOptions };
        clone.controlFlowOptions = { ...this.controlFlowOptions };
        clone.variablesOptions = { ...this.variablesOptions };
        clone.dataDmlOptions = { ...this.dataDmlOptions };
        clone.schemaDdlOptions = { ...this.schemaDdlOptions };
        clone.styleName = this.styleName;
        clone.applyOverrides(overrides);
        return clone;
    }

    getCasingOptions(): CasingOptions { return this.casingOptions; }
    getLayoutOptions(): LayoutOptions { return this.layoutOptions; }
    getCaseOptions(): CaseOptions { return this.caseOptions; }
    getWhitespaceOptions(): WhitespaceOptions { return this.whitespaceOptions; }
    getControlFlowOptions(): ControlFlowOptions { return this.controlFlowOptions; }
    getVariablesOptions(): VariablesOptions { return this.variablesOptions; }
    getDataDmlOptions(): DataDmlOptions { return this.dataDmlOptions; }
    getSchemaDdlOptions(): SchemaDdlOptions { return this.schemaDdlOptions; }
    getStyleName(): string { return this.styleName; }

    private log(msg: string) {
        this.outputChannel?.appendLine(msg);
    }
}
