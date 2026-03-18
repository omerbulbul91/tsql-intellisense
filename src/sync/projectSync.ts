import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionManager, TYPES } from '../connection/connectionManager';
import { SchemaCache } from '../cache/schemaCache';

export interface DdlInfo {
    action: 'ALTER' | 'CREATE';
    objectType: 'PROCEDURE' | 'VIEW' | 'FUNCTION' | 'TRIGGER' | 'TABLE';
    schema: string;
    objectName: string;
}

const DDL_REGEX = /^\s*(ALTER|CREATE(?:\s+OR\s+ALTER)?)\s+(PROC(?:EDURE)?|VIEW|FUNCTION|TRIGGER|TABLE)\s+(?:\[?(\w+)\]?\.)?\[?(\w+)\]?/im;

const SUBDIRECTORY_MAP: Record<string, string> = {
    'PROCEDURE': 'Stored Procedures',
    'VIEW': 'Views',
    'FUNCTION': 'Functions',
    'TRIGGER': 'Triggers',
    'TABLE': 'Tables',
};

export function detectDdl(sql: string): DdlInfo | null {
    const match = sql.match(DDL_REGEX);
    if (!match) { return null; }

    let objectType = match[2].toUpperCase();
    if (objectType === 'PROC') { objectType = 'PROCEDURE'; }

    const rawAction = match[1].toUpperCase();
    return {
        action: (rawAction.includes('ALTER') ? 'ALTER' : 'CREATE') as 'ALTER' | 'CREATE',
        objectType: objectType as DdlInfo['objectType'],
        schema: match[3] || 'dbo',
        objectName: match[4],
    };
}

export class ProjectSync {
    constructor(
        private connectionManager: ConnectionManager,
        private schemaCache: SchemaCache
    ) {}

    async syncAfterExecution(
        sql: string,
        projectPath: string,
        buildTableScript: (tableName: string) => string | null
    ): Promise<void> {
        const batches = sql.split(/^\s*GO\s*$/gmi).filter(b => b.trim());

        for (const batch of batches) {
            const ddl = detectDdl(batch);
            if (!ddl) { continue; }

            try {
                await this.syncObject(ddl, projectPath, buildTableScript);
            } catch (err: any) {
                vscode.window.showWarningMessage(`Project Sync: ${ddl.objectName} — ${err.message}`);
            }
        }
    }

    private async syncObject(
        ddl: DdlInfo,
        projectPath: string,
        buildTableScript: (tableName: string) => string | null
    ): Promise<void> {
        let createScript: string | null = null;

        if (ddl.objectType === 'TABLE') {
            // Force reload schema cache for this table, then rebuild script
            await this.schemaCache.loadColumnsFor(ddl.objectName, true);
            createScript = buildTableScript(ddl.objectName);
        } else {
            // PROC, VIEW, FUNCTION, TRIGGER: fetch canonical CREATE from DB
            createScript = await this.fetchObjectDefinition(ddl.objectName);
        }

        if (!createScript) {
            vscode.window.showWarningMessage(`Project Sync: Could not retrieve definition for ${ddl.objectName}`);
            return;
        }

        // Resolve file path
        const subDir = SUBDIRECTORY_MAP[ddl.objectType] || '';
        const filePath = path.join(projectPath, ddl.schema, subDir, `${ddl.objectName}.sql`);

        // Check if file exists before writing
        const fileExists = fs.existsSync(filePath);

        // Ensure directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Write file
        fs.writeFileSync(filePath, createScript, 'utf-8');

        // Add to .sqlproj if new file
        if (!fileExists) {
            await this.addToSqlproj(projectPath, ddl.schema, subDir, ddl.objectName);
        }

        // Notify user with full path
        const action = fileExists ? 'Updated' : 'Created';
        vscode.window.showInformationMessage(`Project Sync: ${action} ${filePath}`);
    }

    private async fetchObjectDefinition(objectName: string): Promise<string | null> {
        try {
            const result = await this.connectionManager.executeQuery(
                `SELECT OBJECT_DEFINITION(OBJECT_ID(@objectName)) AS [definition]`,
                { objectName: { type: TYPES.NVarChar, value: objectName } }
            );
            if (result.rows.length > 0 && result.rows[0]['definition']) {
                return (result.rows[0]['definition'] as string).trim();
            }
        } catch (err: any) {
            console.error(`[ProjectSync] fetchObjectDefinition failed for ${objectName}:`, err.message);
        }
        return null;
    }

    private async addToSqlproj(
        projectPath: string,
        schema: string,
        subDir: string,
        objectName: string
    ): Promise<void> {
        try {
            const files = fs.readdirSync(projectPath);
            const sqlprojFile = files.find(f => f.endsWith('.sqlproj'));
            if (!sqlprojFile) { return; }

            const sqlprojPath = path.join(projectPath, sqlprojFile);
            let content = fs.readFileSync(sqlprojPath, 'utf-8');

            const relativePath = `${schema}\\${subDir}\\${objectName}.sql`;

            // Skip if already included
            if (content.includes(relativePath)) { return; }

            // Find last <Build Include="..."> entry and insert after it
            const lastBuildIdx = content.lastIndexOf('<Build Include="');
            if (lastBuildIdx === -1) { return; }

            // Find end of that element (either /> or </Build>)
            const selfCloseIdx = content.indexOf('/>', lastBuildIdx);
            const endTagIdx = content.indexOf('</Build>', lastBuildIdx);

            let insertPoint: number;
            if (selfCloseIdx !== -1 && (endTagIdx === -1 || selfCloseIdx < endTagIdx)) {
                insertPoint = selfCloseIdx + 2; // after />
            } else if (endTagIdx !== -1) {
                insertPoint = endTagIdx + '</Build>'.length;
            } else {
                return;
            }

            // Detect indentation from existing entry
            const lineStart = content.lastIndexOf('\n', lastBuildIdx) + 1;
            const indent = content.substring(lineStart, lastBuildIdx);

            const newEntry = `\n${indent}<Build Include="${relativePath}" />`;
            content = content.slice(0, insertPoint) + newEntry + content.slice(insertPoint);

            fs.writeFileSync(sqlprojPath, content, 'utf-8');
        } catch (err: any) {
            console.error(`[ProjectSync] addToSqlproj failed:`, err.message);
        }
    }
}
