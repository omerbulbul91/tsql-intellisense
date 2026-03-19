import * as vscode from 'vscode';
import { ConnectionManager, TYPES } from '../connection/connectionManager';
import { SchemaCache } from '../cache/schemaCache';
import { OBJECT_DEFINITION_QUERY } from '../queries/schemaQueries';

export class AlterProcProvider {
    constructor(
        private connectionManager: ConnectionManager,
        private schemaCache: SchemaCache
    ) {}

    /** Show Quick Pick with all SPs, fetch and open the selected one */
    async showAlterProcPicker(): Promise<void> {
        if (!this.connectionManager.isConnected) {
            vscode.window.showWarningMessage('T-SQL IntelliSense: Not connected to a database');
            return;
        }

        if (!this.schemaCache.isLoaded) {
            vscode.window.showWarningMessage('T-SQL IntelliSense: Schema not loaded yet');
            return;
        }

        const procedures = this.schemaCache.getProcedures();
        const items = procedures.map(p => ({
            label: p.name,
            description: 'PROCEDURE',
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a stored procedure to ALTER',
            matchOnDescription: true,
        });

        if (!selected) { return; }

        await this.fetchAndOpenProcedure(selected.label);
    }

    /** Fetch SP definition and open in a new editor */
    async fetchAndOpenProcedure(spName: string): Promise<void> {
        try {
            const result = await this.connectionManager.executeQuery(
                OBJECT_DEFINITION_QUERY,
                { objectName: { type: TYPES.NVarChar, value: spName } }
            );

            if (result.rows.length === 0 || !result.rows[0]['definition']) {
                vscode.window.showWarningMessage(`Could not retrieve definition for ${spName}`);
                return;
            }

            let definition = result.rows[0]['definition'] as string;

            // Replace CREATE with CREATE OR ALTER
            definition = definition.replace(
                /^(\s*)CREATE\s+(PROC(?:EDURE)?)/i,
                '$1CREATE OR ALTER $2'
            );

            // Open in a new untitled SQL document
            const doc = await vscode.workspace.openTextDocument({
                language: 'sql',
                content: definition,
            });

            await vscode.window.showTextDocument(doc);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to fetch SP definition: ${err.message}`);
        }
    }
}
