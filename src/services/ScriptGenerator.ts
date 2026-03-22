import { TreeQueryService, escapeSql } from './TreeQueryService';
import { DatabaseTreeItem, NodeType } from '../Models/DatabaseNode';

export type ScriptAction = 'Create' | 'Alter' | 'CreateOrAlter' | 'Drop' | 'DropAndCreate' | 'Select' | 'Insert' | 'Update' | 'Delete' | 'Execute';

export class ScriptGenerator {
    constructor(private treeQueryService: TreeQueryService) {}

    async generate(node: DatabaseTreeItem, action: ScriptAction): Promise<string> {
        const schema = node.schemaName || 'dbo';
        const objectName = node.objectName || node.label;
        const qualifiedName = `[${schema}].[${objectName}]`;

        switch (action) {
            case 'Drop': {
                const typeKeyword = this.getObjectTypeKeyword(node.nodeType);
                return `DROP ${typeKeyword} ${qualifiedName};`;
            }
            case 'DropAndCreate': {
                const typeKeyword = this.getObjectTypeKeyword(node.nodeType);
                const dropPart = `DROP ${typeKeyword} IF EXISTS ${qualifiedName};\nGO\n\n`;
                const createPart = await this.generateCreateScript(node, schema, objectName);
                return dropPart + createPart;
            }
            case 'Create':
                return this.generateCreateScript(node, schema, objectName);
            case 'Alter':
                return this.generateAlterScript(node, schema, objectName);
            case 'CreateOrAlter':
                return this.generateCreateOrAlterScript(node, schema, objectName);
            case 'Select':
                return this.generateSelectScript(node, schema, objectName);
            case 'Insert':
                return this.generateInsertScript(node, schema, objectName);
            case 'Update':
                return this.generateUpdateScript(node, schema, objectName);
            case 'Delete':
                return `DELETE FROM ${qualifiedName}\nWHERE /* condition */;`;
            case 'Execute':
                return this.generateExecuteScript(node, schema, objectName);
            default:
                throw new Error(`Unsupported script action: ${action}`);
        }
    }

    private getObjectTypeKeyword(nodeType: NodeType): string {
        switch (nodeType) {
            case NodeType.Table: return 'TABLE';
            case NodeType.View: return 'VIEW';
            case NodeType.Procedure: return 'PROCEDURE';
            case NodeType.Function: return 'FUNCTION';
            case NodeType.Trigger: return 'TRIGGER';
            default: return 'OBJECT';
        }
    }

    private async getColumns(databaseName: string, schemaName: string, objectName: string): Promise<any[]> {
        const safeSchema = escapeSql(schemaName);
        const safeObject = escapeSql(objectName);
        const sql = `
            SELECT c.[COLUMN_NAME], c.[DATA_TYPE], c.[CHARACTER_MAXIMUM_LENGTH],
                   c.[NUMERIC_PRECISION], c.[NUMERIC_SCALE], c.[IS_NULLABLE],
                   c.[COLUMN_DEFAULT],
                   COLUMNPROPERTY(OBJECT_ID('[${safeSchema}].[${safeObject}]'), c.[COLUMN_NAME], 'IsIdentity') AS IsIdentity
            FROM [INFORMATION_SCHEMA].[COLUMNS] c
            WHERE c.[TABLE_SCHEMA] = '${safeSchema}' AND c.[TABLE_NAME] = '${safeObject}'
            ORDER BY c.[ORDINAL_POSITION]
        `;
        const result = await this.treeQueryService.execute(sql, databaseName);
        return result.rows;
    }

    private formatColumnType(col: any): string {
        if (col.CHARACTER_MAXIMUM_LENGTH) {
            const len = col.CHARACTER_MAXIMUM_LENGTH === -1 ? 'MAX' : col.CHARACTER_MAXIMUM_LENGTH;
            return `${col.DATA_TYPE.toUpperCase()}(${len})`;
        }
        if (col.NUMERIC_PRECISION && ['decimal', 'numeric'].includes(col.DATA_TYPE)) {
            return `${col.DATA_TYPE.toUpperCase()}(${col.NUMERIC_PRECISION}, ${col.NUMERIC_SCALE})`;
        }
        return col.DATA_TYPE.toUpperCase();
    }

    private async generateCreateScript(node: DatabaseTreeItem, schema: string, objectName: string): Promise<string> {
        const qName = `[${schema}].[${objectName}]`;

        if (node.nodeType === NodeType.Table) {
            const cols = await this.getColumns(node.databaseName!, schema, objectName);
            const colDefs = cols.map((col) => {
                const type = this.formatColumnType(col);
                const nullable = col.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL';
                const identity = col.IsIdentity ? ' IDENTITY(1,1)' : '';
                const defaultVal = col.COLUMN_DEFAULT ? ` DEFAULT ${col.COLUMN_DEFAULT}` : '';
                return `    [${col.COLUMN_NAME}] ${type}${identity} ${nullable}${defaultVal}`;
            });

            // Get PK
            const safeSchema = escapeSql(schema);
            const safeObject = escapeSql(objectName);
            const pkSql = `
                SELECT kc.[name] AS ConstraintName, STRING_AGG(c.[name], ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS Columns
                FROM sys.key_constraints kc
                INNER JOIN sys.index_columns ic ON kc.parent_object_id = ic.object_id AND kc.unique_index_id = ic.index_id
                INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
                WHERE kc.parent_object_id = OBJECT_ID('${safeSchema}.${safeObject}') AND kc.[type] = 'PK'
                GROUP BY kc.[name]
            `;
            try {
                const pkResult = await this.treeQueryService.execute(pkSql, node.databaseName!);
                if (pkResult.rows.length > 0) {
                    const pk = pkResult.rows[0];
                    const pkCols = pk.Columns.split(', ').map((c: string) => `[${c}]`).join(', ');
                    colDefs.push(`    CONSTRAINT [${pk.ConstraintName}] PRIMARY KEY (${pkCols})`);
                }
            } catch { /* ignore */ }

            return `CREATE TABLE ${qName}\n(\n${colDefs.join(',\n')}\n);`;
        }

        // View, SP, Function, Trigger - get definition from server
        const safeSchema = escapeSql(schema);
        const safeObject = escapeSql(objectName);
        const defSql = `SELECT OBJECT_DEFINITION(OBJECT_ID('${safeSchema}.${safeObject}')) AS [Definition]`;
        try {
            const result = await this.treeQueryService.execute(defSql, node.databaseName!);
            const def = result.rows[0]?.Definition;
            if (def) { return def; }
        } catch { /* ignore */ }

        // Fallback template
        const typeKw = this.getObjectTypeKeyword(node.nodeType);
        return `CREATE ${typeKw} ${qName}\nAS\nBEGIN\n    \nEND;`;
    }

    private async generateAlterScript(node: DatabaseTreeItem, schema: string, objectName: string): Promise<string> {
        if (node.nodeType === NodeType.Table) {
            return `ALTER TABLE [${schema}].[${objectName}]\n    ADD [ColumnName] NVARCHAR(100) NULL;`;
        }

        const def = await this.generateCreateScript(node, schema, objectName);
        return def.replace(/^\s*CREATE\s+/i, 'ALTER ');
    }

    private async generateCreateOrAlterScript(node: DatabaseTreeItem, schema: string, objectName: string): Promise<string> {
        const def = await this.generateCreateScript(node, schema, objectName);
        return def.replace(/^\s*CREATE\s+/i, 'CREATE OR ALTER ');
    }

    private async generateSelectScript(node: DatabaseTreeItem, schema: string, objectName: string): Promise<string> {
        const cols = await this.getColumns(node.databaseName!, schema, objectName);
        const colList = cols.map((c) => `[${c.COLUMN_NAME}]`).join(',\n       ');
        return `SELECT ${colList}\nFROM [${schema}].[${objectName}];`;
    }

    private async generateInsertScript(node: DatabaseTreeItem, schema: string, objectName: string): Promise<string> {
        const cols = await this.getColumns(node.databaseName!, schema, objectName);
        const nonIdentityCols = cols.filter((c) => !c.IsIdentity);
        const colList = nonIdentityCols.map((c) => `[${c.COLUMN_NAME}]`).join(', ');
        const valList = nonIdentityCols.map((c) => `/* ${c.COLUMN_NAME} */`).join(', ');
        return `INSERT INTO [${schema}].[${objectName}]\n    (${colList})\nVALUES\n    (${valList});`;
    }

    private async generateUpdateScript(node: DatabaseTreeItem, schema: string, objectName: string): Promise<string> {
        const cols = await this.getColumns(node.databaseName!, schema, objectName);
        const nonIdentityCols = cols.filter((c) => !c.IsIdentity);
        const setList = nonIdentityCols.map((c) => `    [${c.COLUMN_NAME}] = /* value */`).join(',\n');
        return `UPDATE [${schema}].[${objectName}]\nSET\n${setList}\nWHERE /* condition */;`;
    }

    private async generateExecuteScript(node: DatabaseTreeItem, schema: string, objectName: string): Promise<string> {
        const safeSchema = escapeSql(schema);
        const safeObject = escapeSql(objectName);
        const paramSql = `
            SELECT [PARAMETER_NAME], [DATA_TYPE], [CHARACTER_MAXIMUM_LENGTH], [PARAMETER_MODE]
            FROM [INFORMATION_SCHEMA].[PARAMETERS]
            WHERE [SPECIFIC_SCHEMA] = '${safeSchema}' AND [SPECIFIC_NAME] = '${safeObject}'
                AND [PARAMETER_MODE] IS NOT NULL
            ORDER BY [ORDINAL_POSITION]
        `;
        const result = await this.treeQueryService.execute(paramSql, node.databaseName!);
        const params = result.rows;

        if (node.nodeType === NodeType.Procedure) {
            if (params.length === 0) {
                return `EXEC [${schema}].[${objectName}];`;
            }
            const paramList = params.map((p) => {
                const output = p.PARAMETER_MODE === 'INOUT' ? ' OUTPUT' : '';
                return `    ${p.PARAMETER_NAME} = /* ${p.DATA_TYPE} */${output}`;
            }).join(',\n');
            return `EXEC [${schema}].[${objectName}]\n${paramList};`;
        }

        // Function
        if (params.length === 0) {
            return `SELECT [${schema}].[${objectName}]();`;
        }
        const paramList = params.map((p) => `/* ${p.PARAMETER_NAME}: ${p.DATA_TYPE} */`).join(', ');
        return `SELECT [${schema}].[${objectName}](${paramList});`;
    }
}
