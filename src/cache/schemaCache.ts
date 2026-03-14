import * as vscode from 'vscode';
import { ConnectionManager, TYPES } from '../connection/connectionManager';
import {
    ALL_OBJECTS_QUERY,
    ALL_ROUTINES_QUERY,
    ALL_COLUMNS_QUERY,
    TABLE_COLUMNS_QUERY,
} from '../queries/schemaQueries';

export interface ColumnInfo {
    name: string;
    dataType: string;
    isNullable: boolean;
    maxLength: number | null;
    ordinalPosition: number;
}

export interface ObjectInfo {
    name: string;
    type: 'TABLE' | 'VIEW' | 'PROCEDURE' | 'FUNCTION';
    columns?: ColumnInfo[];
}

export class SchemaCache {
    private objects: Map<string, ObjectInfo> = new Map();
    private columnsLoaded: Set<string> = new Set();
    private allColumnsLoaded = false;
    private lastRefresh: Date | null = null;
    private refreshTimer: NodeJS.Timeout | null = null;
    private _onSchemaLoaded = new vscode.EventEmitter<void>();
    public readonly onSchemaLoaded = this._onSchemaLoaded.event;

    constructor(private connectionManager: ConnectionManager) {}

    get isLoaded(): boolean {
        return this.objects.size > 0;
    }

    get objectCount(): number {
        return this.objects.size;
    }

    /** Load all object names (tables, views, SPs, functions) */
    async loadObjectNames(): Promise<void> {
        if (!this.connectionManager.isConnected) {
            return;
        }

        this.objects.clear();
        this.columnsLoaded.clear();
        this.allColumnsLoaded = false;

        // Load tables and views
        const tablesResult = await this.connectionManager.executeQuery(ALL_OBJECTS_QUERY);
        for (const row of tablesResult.rows) {
            const name = row['TABLE_NAME'] as string;
            const type = row['TABLE_TYPE'] === 'VIEW' ? 'VIEW' : 'TABLE';
            this.objects.set(name.toLowerCase(), { name, type: type as 'TABLE' | 'VIEW' });
        }

        // Load procedures and functions
        const routinesResult = await this.connectionManager.executeQuery(ALL_ROUTINES_QUERY);
        for (const row of routinesResult.rows) {
            const name = row['ROUTINE_NAME'] as string;
            const type = row['ROUTINE_TYPE'] === 'PROCEDURE' ? 'PROCEDURE' : 'FUNCTION';
            this.objects.set(name.toLowerCase(), { name, type: type as 'PROCEDURE' | 'FUNCTION' });
        }

        this.lastRefresh = new Date();
        this._onSchemaLoaded.fire();
    }

    /** Load all columns in background (bulk) */
    async loadAllColumns(): Promise<void> {
        if (!this.connectionManager.isConnected || this.allColumnsLoaded) {
            return;
        }

        const result = await this.connectionManager.executeQuery(ALL_COLUMNS_QUERY);

        for (const row of result.rows) {
            const tableName = (row['TABLE_NAME'] as string).toLowerCase();
            const obj = this.objects.get(tableName);
            if (!obj) { continue; }

            if (!obj.columns) {
                obj.columns = [];
            }

            obj.columns.push({
                name: row['COLUMN_NAME'] as string,
                dataType: row['DATA_TYPE'] as string,
                isNullable: row['IS_NULLABLE'] === 'YES',
                maxLength: row['CHARACTER_MAXIMUM_LENGTH'] as number | null,
                ordinalPosition: row['ORDINAL_POSITION'] as number,
            });

            this.columnsLoaded.add(tableName);
        }

        this.allColumnsLoaded = true;
    }

    /** Load columns for a specific table (lazy) */
    async loadColumnsFor(tableName: string): Promise<ColumnInfo[]> {
        const key = tableName.toLowerCase();

        // Already cached
        if (this.columnsLoaded.has(key)) {
            return this.objects.get(key)?.columns || [];
        }

        if (!this.connectionManager.isConnected) {
            return [];
        }

        const result = await this.connectionManager.executeQuery(TABLE_COLUMNS_QUERY, {
            tableName: { type: TYPES.NVarChar, value: tableName },
        });

        const obj = this.objects.get(key);
        if (!obj) { return []; }

        obj.columns = result.rows.map(row => ({
            name: row['COLUMN_NAME'] as string,
            dataType: row['DATA_TYPE'] as string,
            isNullable: row['IS_NULLABLE'] === 'YES',
            maxLength: row['CHARACTER_MAXIMUM_LENGTH'] as number | null,
            ordinalPosition: row['ORDINAL_POSITION'] as number,
        }));

        this.columnsLoaded.add(key);
        return obj.columns;
    }

    /** Get all tables and views */
    getTablesAndViews(): ObjectInfo[] {
        return Array.from(this.objects.values()).filter(
            o => o.type === 'TABLE' || o.type === 'VIEW'
        );
    }

    /** Get all procedures */
    getProcedures(): ObjectInfo[] {
        return Array.from(this.objects.values()).filter(o => o.type === 'PROCEDURE');
    }

    /** Get all functions */
    getFunctions(): ObjectInfo[] {
        return Array.from(this.objects.values()).filter(o => o.type === 'FUNCTION');
    }

    /** Find an object by name (case-insensitive) */
    findObject(name: string): ObjectInfo | undefined {
        return this.objects.get(name.toLowerCase());
    }

    /** Get columns for a table/view (from cache, or load lazily) */
    async getColumns(tableName: string): Promise<ColumnInfo[]> {
        const key = tableName.toLowerCase();
        const obj = this.objects.get(key);
        if (!obj) { return []; }

        if (obj.columns) {
            return obj.columns;
        }

        return this.loadColumnsFor(tableName);
    }

    /** Start auto-refresh timer */
    startAutoRefresh(): void {
        this.stopAutoRefresh();

        const config = vscode.workspace.getConfiguration('tsql-intellisense');
        const minutes = config.get<number>('autoRefreshMinutes', 30);
        if (minutes <= 0) { return; }

        this.refreshTimer = setInterval(() => {
            this.refresh();
        }, minutes * 60 * 1000);
    }

    /** Stop auto-refresh timer */
    stopAutoRefresh(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    /** Full refresh: reload object names + columns */
    async refresh(): Promise<void> {
        await this.loadObjectNames();
        // Load columns in background (don't await)
        this.loadAllColumns().catch(() => {});
    }

    dispose(): void {
        this.stopAutoRefresh();
        this._onSchemaLoaded.dispose();
    }
}
