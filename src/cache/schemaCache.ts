import * as vscode from 'vscode';
import { ConnectionManager, TYPES } from '../connection/connectionManager';
import { ts } from '../utils/timestamp';
import {
    ALL_OBJECTS_QUERY,
    ALL_ROUTINES_QUERY,
    ALL_COLUMNS_QUERY,
    TABLE_COLUMNS_QUERY,
    FK_QUERY,
    ALL_TRIGGERS_QUERY,
    ALL_INDEXES_QUERY,
    ALL_VIEW_DEFINITIONS_QUERY,
} from '../queries/schemaQueries';

export interface ColumnInfo {
    name: string;
    dataType: string;
    isNullable: boolean;
    maxLength: number | null;
    ordinalPosition: number;
    isIdentity?: boolean;
    hasDefault?: boolean;
}

export interface ObjectInfo {
    name: string;
    type: 'TABLE' | 'VIEW' | 'PROCEDURE' | 'FUNCTION' | 'TRIGGER';
    columns?: ColumnInfo[];
}

export interface TriggerInfo {
    name: string;
    tableName: string;
    definition: string;
}

export interface IndexInfo {
    name: string;
    tableName: string;
    type: string;
    isUnique: boolean;
    isPrimaryKey: boolean;
    columns: string;
}

export interface ForeignKeyInfo {
    fkName: string;
    parentTable: string;
    parentColumn: string;
    referencedTable: string;
    referencedColumn: string;
}

export class SchemaCache {
    private objects: Map<string, ObjectInfo> = new Map();
    private columnsLoaded: Set<string> = new Set();
    private allColumnsLoaded = false;
    /** Extra DB objects loaded via cross-DB queries: dbName → objectKey → ObjectInfo */
    private extraDbObjects: Map<string, Map<string, ObjectInfo>> = new Map();
    private extraDbColumnsLoaded: Set<string> = new Set(); // key: "dbName::tableName"
    private foreignKeys: ForeignKeyInfo[] = [];
    private fkLoaded = false;
    private triggers: Map<string, TriggerInfo[]> = new Map();
    private triggersLoaded = false;
    private indexes: Map<string, IndexInfo[]> = new Map();
    private indexesLoaded = false;
    private viewDefinitions: Map<string, string> = new Map();
    private viewDefsLoaded = false;
    private refreshTimer: NodeJS.Timeout | null = null;
    private _loadedDbName: string | null = null;
    private _onSchemaLoaded = new vscode.EventEmitter<void>();
    public readonly onSchemaLoaded = this._onSchemaLoaded.event;

    private get log(): vscode.OutputChannel { return this.connectionManager.log; }

    constructor(private connectionManager: ConnectionManager) {}

    get isLoaded(): boolean {
        return this.objects.size > 0;
    }

    get loadedDbName(): string | null {
        return this._loadedDbName;
    }

    get isFullyLoaded(): boolean {
        return this.allColumnsLoaded && this.fkLoaded && this.indexesLoaded && this.triggersLoaded && this.viewDefsLoaded;
    }

    get objectCount(): number {
        return this.objects.size;
    }

    /** Check if a specific DB's object names are loaded (main cache or extra cache) */
    isLoadedForDb(dbName: string): boolean {
        const db = dbName.toLowerCase();
        if (this._loadedDbName?.toLowerCase() === db) { return this.isLoaded; }
        return this.extraDbObjects.has(db);
    }

    /**
     * Load object names for any DB via cross-DB INFORMATION_SCHEMA queries.
     * Does NOT reconnect — works from current active connection.
     */
    async loadObjectNamesForDb(dbName: string): Promise<void> {
        const dbKey = dbName.toLowerCase();

        // If main cache is already loaded for this DB, nothing to do
        if (this._loadedDbName?.toLowerCase() === dbKey) {
            return;
        }

        if (!this.connectionManager.isConnected) { return; }
        if (this.extraDbObjects.has(dbKey)) { return; } // already loaded

        const start = Date.now();
        this.log.appendLine(`[${ts()}] Loading cross-DB objects for ${dbName}...`);
        const safe = dbName.replace(/\]/g, ']]');
        const result = await this.connectionManager.executeQuery(
            `SELECT name, type FROM (
                SELECT TABLE_NAME as name,
                    CASE TABLE_TYPE WHEN 'BASE TABLE' THEN 'TABLE' ELSE 'VIEW' END as type
                FROM [${safe}].INFORMATION_SCHEMA.TABLES
                UNION ALL
                SELECT ROUTINE_NAME, ROUTINE_TYPE
                FROM [${safe}].INFORMATION_SCHEMA.ROUTINES
                UNION ALL
                SELECT name, 'TRIGGER'
                FROM [${safe}].sys.triggers
                WHERE parent_class = 1
            ) t ORDER BY name`
        );

        const map = new Map<string, ObjectInfo>();
        for (const row of result.rows) {
            const name = row['name'] as string;
            const rawType = row['type'] as string;
            const type = rawType === 'TABLE' ? 'TABLE'
                : rawType === 'VIEW' ? 'VIEW'
                : rawType === 'PROCEDURE' ? 'PROCEDURE'
                : rawType === 'TRIGGER' ? 'TRIGGER'
                : 'FUNCTION';
            map.set(name.toLowerCase(), { name, type });
        }
        this.extraDbObjects.set(dbKey, map);
        this.log.appendLine(`[${ts()}] Cross-DB ${dbName}: ${map.size} objects (${Date.now() - start}ms)`);
    }

    /** Load columns for a table in any DB (routes to main cache if dbName is the active DB) */
    async loadColumnsForDbTable(dbName: string, tableName: string): Promise<ColumnInfo[]> {
        const dbKey = dbName.toLowerCase();
        const activeDb = this.connectionManager.currentProfile?.database?.toLowerCase();
        // If it's the active DB, use the main cache path
        if (activeDb === dbKey) {
            return this.getColumns(tableName);
        }

        const cacheKey = `${dbKey}::${tableName.toLowerCase()}`;

        const dbMap = this.extraDbObjects.get(dbKey);
        if (!dbMap) { return []; }

        const obj = dbMap.get(tableName.toLowerCase());
        if (!obj) { return []; }

        if (this.extraDbColumnsLoaded.has(cacheKey)) {
            return obj.columns || [];
        }

        if (!this.connectionManager.isConnected) { return []; }

        const safe = dbName.replace(/\]/g, ']]');
        const result = await this.connectionManager.executeQuery(
            `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH, ORDINAL_POSITION,
                    COLUMNPROPERTY(OBJECT_ID('[${safe}].dbo.' + TABLE_NAME), COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY,
                    CASE WHEN COLUMN_DEFAULT IS NOT NULL THEN 1 ELSE 0 END AS HAS_DEFAULT
             FROM [${safe}].INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_NAME = @tableName
             ORDER BY ORDINAL_POSITION`,
            { tableName: { type: TYPES.NVarChar, value: tableName } }
        );

        obj.columns = result.rows.map(row => ({
            name: row['COLUMN_NAME'] as string,
            dataType: row['DATA_TYPE'] as string,
            isNullable: row['IS_NULLABLE'] === 'YES',
            maxLength: row['CHARACTER_MAXIMUM_LENGTH'] as number | null,
            ordinalPosition: row['ORDINAL_POSITION'] as number,
            isIdentity: row['IS_IDENTITY'] === 1,
            hasDefault: row['HAS_DEFAULT'] === 1,
        }));
        this.extraDbColumnsLoaded.add(cacheKey);
        return obj.columns;
    }

    /** Get objects (tables/views/SPs/funcs) for a specific DB (or active if not specified) */
    getObjectsForDb(dbName: string): Map<string, ObjectInfo> {
        const dbKey = dbName.toLowerCase();
        if (!dbName || this._loadedDbName?.toLowerCase() === dbKey) { return this.objects; }
        return this.extraDbObjects.get(dbKey) || new Map();
    }

    /** Load all object names (tables, views, SPs, functions) */
    async loadObjectNames(): Promise<void> {
        if (!this.connectionManager.isConnected) {
            return;
        }

        this._loadedDbName = this.connectionManager.currentProfile?.database ?? null;
        this.objects.clear();
        this.columnsLoaded.clear();
        this.allColumnsLoaded = false;
        this.foreignKeys = [];
        this.fkLoaded = false;
        this.triggers.clear();
        this.triggersLoaded = false;
        this.indexes.clear();
        this.indexesLoaded = false;
        this.viewDefinitions.clear();
        this.viewDefsLoaded = false;

        const start = Date.now();
        this.log.appendLine(`[${ts()}] Schema loading object names for ${this._loadedDbName}...`);

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

        // Load trigger names (names only — definitions loaded separately in loadTriggers)
        const triggerNamesResult = await this.connectionManager.executeQuery(
            `SELECT name FROM sys.triggers WHERE parent_class = 1 ORDER BY name`
        );
        for (const row of triggerNamesResult.rows) {
            const name = row['name'] as string;
            this.objects.set(name.toLowerCase(), { name, type: 'TRIGGER' });
        }

        this.log.appendLine(`[${ts()}] Schema loaded ${this.objects.size} objects (${Date.now() - start}ms)`);
        this._onSchemaLoaded.fire();
    }

    /** Load all columns in background (bulk) */
    async loadAllColumns(): Promise<void> {
        if (!this.connectionManager.isConnected || this.allColumnsLoaded) {
            return;
        }

        const start = Date.now();
        this.log.appendLine(`[${ts()}] Loading all columns...`);
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
                isIdentity: row['IS_IDENTITY'] === 1,
                hasDefault: row['HAS_DEFAULT'] === 1,
            });

            this.columnsLoaded.add(tableName);
        }

        this.allColumnsLoaded = true;
        this.log.appendLine(`[${ts()}] All columns loaded: ${result.rows.length} columns (${Date.now() - start}ms)`);
    }

    /** Load columns for a specific table (lazy, or force reload) */
    async loadColumnsFor(tableName: string, forceReload = false): Promise<ColumnInfo[]> {
        const key = tableName.toLowerCase();

        // Already cached (skip if force reload)
        if (!forceReload && this.columnsLoaded.has(key)) {
            return this.objects.get(key)?.columns || [];
        }

        if (!this.connectionManager.isConnected) {
            return [];
        }

        this.log.appendLine(`[${ts()}] Loading columns for ${tableName}${forceReload ? ' (force)' : ''}...`);
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
            isIdentity: row['IS_IDENTITY'] === 1,
            hasDefault: row['HAS_DEFAULT'] === 1,
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

    /** Get all objects (tables, views, SPs, functions, triggers) */
    getAllObjects(): ObjectInfo[] {
        return Array.from(this.objects.values());
    }

    /** Find an object by name (case-insensitive) */
    findObject(name: string): ObjectInfo | undefined {
        return this.objects.get(name.toLowerCase());
    }

    /** Load foreign key relationships */
    async loadForeignKeys(): Promise<void> {
        if (!this.connectionManager.isConnected || this.fkLoaded) {
            return;
        }

        const start = Date.now();
        this.log.appendLine(`[${ts()}] Loading foreign keys...`);
        const result = await this.connectionManager.executeQuery(FK_QUERY);
        this.foreignKeys = result.rows.map(row => ({
            fkName: row['FK_NAME'] as string,
            parentTable: row['PARENT_TABLE'] as string,
            parentColumn: row['PARENT_COLUMN'] as string,
            referencedTable: row['REFERENCED_TABLE'] as string,
            referencedColumn: row['REFERENCED_COLUMN'] as string,
        }));
        this.fkLoaded = true;
        this.log.appendLine(`[${ts()}] Foreign keys loaded: ${this.foreignKeys.length} relations (${Date.now() - start}ms)`);
    }

    /** Get FK relationships between two tables */
    getForeignKeysBetween(table1: string, table2: string): ForeignKeyInfo[] {
        const t1 = table1.toLowerCase();
        const t2 = table2.toLowerCase();
        return this.foreignKeys.filter(fk => {
            const p = fk.parentTable.toLowerCase();
            const r = fk.referencedTable.toLowerCase();
            return (p === t1 && r === t2) || (p === t2 && r === t1);
        });
    }

    /** Load all triggers */
    async loadTriggers(): Promise<void> {
        if (!this.connectionManager.isConnected || this.triggersLoaded) {
            return;
        }

        const start = Date.now();
        this.log.appendLine(`[${ts()}] Loading triggers...`);
        const result = await this.connectionManager.executeQuery(ALL_TRIGGERS_QUERY);
        this.triggers.clear();

        for (const row of result.rows) {
            const tableName = (row['TABLE_NAME'] as string).toLowerCase();
            const trigger: TriggerInfo = {
                name: row['TRIGGER_NAME'] as string,
                tableName: row['TABLE_NAME'] as string,
                definition: row['TRIGGER_DEFINITION'] as string || '',
            };

            if (!this.triggers.has(tableName)) {
                this.triggers.set(tableName, []);
            }
            this.triggers.get(tableName)!.push(trigger);
        }
        this.triggersLoaded = true;
        this.log.appendLine(`[${ts()}] Triggers loaded: ${result.rows.length} triggers (${Date.now() - start}ms)`);
    }

    /** Get triggers for a table */
    getTriggers(tableName: string): TriggerInfo[] {
        return this.triggers.get(tableName.toLowerCase()) || [];
    }

    /** Check if a table has triggers */
    hasTriggers(tableName: string): boolean {
        const trigs = this.triggers.get(tableName.toLowerCase());
        return !!trigs && trigs.length > 0;
    }

    /** Load all indexes and primary keys */
    async loadIndexes(): Promise<void> {
        if (!this.connectionManager.isConnected || this.indexesLoaded) {
            return;
        }

        const start = Date.now();
        this.log.appendLine(`[${ts()}] Loading indexes...`);
        const result = await this.connectionManager.executeQuery(ALL_INDEXES_QUERY);
        this.indexes.clear();

        for (const row of result.rows) {
            const tableName = (row['TABLE_NAME'] as string).toLowerCase();
            const idx: IndexInfo = {
                name: row['INDEX_NAME'] as string,
                tableName: row['TABLE_NAME'] as string,
                type: row['INDEX_TYPE'] as string,
                isUnique: row['IS_UNIQUE'] as boolean,
                isPrimaryKey: row['IS_PRIMARY_KEY'] as boolean,
                columns: row['COLUMNS'] as string,
            };

            if (!this.indexes.has(tableName)) {
                this.indexes.set(tableName, []);
            }
            this.indexes.get(tableName)!.push(idx);
        }
        this.indexesLoaded = true;
        this.log.appendLine(`[${ts()}] Indexes loaded: ${result.rows.length} indexes (${Date.now() - start}ms)`);
    }

    /** Get indexes for a table */
    getIndexes(tableName: string): IndexInfo[] {
        return this.indexes.get(tableName.toLowerCase()) || [];
    }

    /** Load all view definitions */
    async loadViewDefinitions(): Promise<void> {
        if (!this.connectionManager.isConnected || this.viewDefsLoaded) {
            return;
        }

        const start = Date.now();
        this.log.appendLine(`[${ts()}] Loading view definitions...`);
        const result = await this.connectionManager.executeQuery(ALL_VIEW_DEFINITIONS_QUERY);
        this.viewDefinitions.clear();

        for (const row of result.rows) {
            const name = (row['TABLE_NAME'] as string).toLowerCase();
            const def = row['VIEW_DEFINITION'] as string;
            if (def) {
                this.viewDefinitions.set(name, def);
            }
        }
        this.viewDefsLoaded = true;
        this.log.appendLine(`[${ts()}] View definitions loaded: ${result.rows.length} views (${Date.now() - start}ms)`);
    }

    /** Get view definition */
    getViewDefinition(viewName: string): string | undefined {
        return this.viewDefinitions.get(viewName.toLowerCase());
    }

    /** Update cached view definition */
    setViewDefinition(viewName: string, definition: string): void {
        this.viewDefinitions.set(viewName.toLowerCase(), definition);
    }

    /** Get all FK relationships involving a specific table (as parent or referenced) */
    getForeignKeysForTable(tableName: string): ForeignKeyInfo[] {
        const t = tableName.toLowerCase();
        return this.foreignKeys.filter(fk =>
            fk.parentTable.toLowerCase() === t || fk.referencedTable.toLowerCase() === t
        );
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
            this.log.appendLine(`[${ts()}] Auto-refresh triggered (every ${minutes}min)`);
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

    /** Full refresh: reload object names + all metadata sequentially */
    async refresh(): Promise<void> {
        await this.loadObjectNames();
        // Sequential — tedious single connection cannot run parallel queries
        await this.loadAllColumns().catch(() => {});
        await this.loadForeignKeys().catch(() => {});
        await this.loadIndexes().catch(() => {});
        await this.loadTriggers().catch(() => {});
        await this.loadViewDefinitions().catch(() => {});
    }

    /** Fetch OBJECT_DEFINITION for a single object live from the DB */
    async fetchObjectDefinition(objectName: string): Promise<string | null> {
        if (!this.connectionManager.isConnected) { return null; }
        try {
            const result = await this.connectionManager.executeQuery(
                `SELECT OBJECT_DEFINITION(OBJECT_ID(@n)) AS def`,
                { n: { type: TYPES.NVarChar, value: objectName } }
            );
            return (result.rows[0]?.['def'] as string) ?? null;
        } catch { return null; }
    }

    dispose(): void {
        this.stopAutoRefresh();
        this._onSchemaLoaded.dispose();
    }
}
