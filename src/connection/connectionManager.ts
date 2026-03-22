import * as vscode from 'vscode';
import * as mssql from 'mssql';

export interface ConnectionProfile {
    name: string;
    server: string;
    database: string;
    user?: string;
    password?: string;
    port?: number;
    trustServerCertificate?: boolean;
    encrypt?: 'optional' | 'mandatory' | 'strict';
    projectPath?: string;
    /** DB-specific project paths: { "OCTO_AKDENIZ": "c:\\...\\path", "OCTO_CORE": "c:\\...\\path" } */
    databaseProjects?: Record<string, string>;
}

export interface QueryResult {
    rows: Record<string, any>[];
    columns: string[];
}

export interface BatchResult {
    resultSets: QueryResult[];
    messages: string[];
    rowsAffected: number;
    error?: string;
    elapsed: number;
}

export class ConnectionManager {
    private pool: mssql.ConnectionPool | null = null;
    private activeProfile: ConnectionProfile | null = null;
    private statusBarItem: vscode.StatusBarItem;
    private _onConnectionChanged = new vscode.EventEmitter<ConnectionProfile | null>();
    public readonly onConnectionChanged = this._onConnectionChanged.event;
    private _connectingProfileName: string | null = null;

    get connectingProfileName(): string | null { return this._connectingProfileName; }
    get isConnecting(): boolean { return this._connectingProfileName !== null; }

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = 'tsql-intellisense.connect';
        // Status bar hidden — connection info shown in query file header instead
        this.statusBarItem.hide();
    }

    get isConnected(): boolean {
        return this.pool?.connected === true;
    }

    get currentProfile(): ConnectionProfile | null {
        return this.activeProfile;
    }

    /** Get saved connection profiles from both our settings and mssql extension */
    getSavedProfiles(): ConnectionProfile[] {
        const profiles: ConnectionProfile[] = [];

        // 1. Our own connections
        const ourConfig = vscode.workspace.getConfiguration('tsql-intellisense');
        const ourProfiles = ourConfig.get<ConnectionProfile[]>('connections', []);
        profiles.push(...ourProfiles);

        // 2. Read mssql extension connections
        const mssqlConfig = vscode.workspace.getConfiguration('mssql');
        const mssqlConnections = mssqlConfig.get<any[]>('connections', []);

        for (const mc of mssqlConnections) {
            // Skip if no server defined
            if (!mc.server) { continue; }

            // Skip duplicates — same server already in our own profiles
            const isDuplicate = profiles.some(
                p => p.server === mc.server
            );
            if (isDuplicate) { continue; }

            profiles.push({
                name: mc.profileName || `${mc.server}/${mc.database || 'default'}`,
                server: mc.server,
                database: mc.database || '',
                user: mc.user,
                password: mc.password,
                port: mc.port,
                trustServerCertificate: mc.trustServerCertificate !== false,
            });
        }

        return profiles;
    }

    private buildPoolConfig(profile: ConnectionProfile): any {
        let server = profile.server;
        let port = profile.port ?? 1433;

        // Handle "server,port" format
        if (server.includes(',')) {
            const parts = server.split(',');
            server = parts[0];
            port = parseInt(parts[1], 10) || port;
        }

        // Handle "server\\instance" — mssql needs backslash in server name
        const config: any = {
            server,
            port,
            database: profile.database || undefined,
            options: {
                encrypt: profile.encrypt === 'mandatory' || profile.encrypt === 'strict',
                trustServerCertificate: profile.trustServerCertificate !== false,
                enableArithAbort: true,
                instanceName: undefined as string | undefined,
            },
            connectionTimeout: 30000,
            requestTimeout: 0,
            pool: { max: 5, min: 1, idleTimeoutMillis: 600000 },
        };

        // Handle named instances (server\instance)
        if (server.includes('\\')) {
            const parts = server.split('\\');
            config.server = parts[0];
            config.options.instanceName = parts[1];
            config.port = undefined; // named instances don't use port
        }

        if (profile.user) {
            config.user = profile.user;
            config.password = profile.password;
        } else {
            config.options.trustedConnection = true;
        }

        return config;
    }

    /** Connect to a database using a profile */
    async connect(profile: ConnectionProfile): Promise<void> {
        if (this.pool) { await this.disconnect(); }
        this._connectingProfileName = profile.name;
        try {
            const config = this.buildPoolConfig(profile);
            const pool = new mssql.ConnectionPool(config);
            await pool.connect();
            this.pool = pool;
            this.activeProfile = profile;
            this.updateStatusBar();
            this._onConnectionChanged.fire(profile);
        } catch (err: any) {
            this.pool = null;
            this.activeProfile = null;
            this.updateStatusBar();
            throw new Error(`Connection failed: ${err.message}`);
        } finally {
            this._connectingProfileName = null;
        }
    }

    /** Cancel an in-progress connection attempt */
    cancelConnect(): void {
        if (this._connectingProfileName) {
            this._connectingProfileName = null;
            if (this.pool) {
                this.pool.close().catch(() => {});
                this.pool = null;
            }
        }
    }

    /** Disconnect from the current database */
    async disconnect(): Promise<void> {
        if (this.pool) {
            try { await this.pool.close(); } catch { /* ignore */ }
            this.pool = null;
            this.activeProfile = null;
            this.updateStatusBar();
            this._onConnectionChanged.fire(null);
        }
    }

    /** Execute a SQL query and return results */
    async executeQuery(sql: string, params?: Record<string, { type: any; value: any }>): Promise<QueryResult> {
        if (!this.pool || !this.pool.connected) { throw new Error('Not connected to database'); }

        const request = this.pool.request();
        (request as any).arrayRowMode = true; // get rows as arrays for proper unnamed column handling
        if (params) {
            for (const [name, param] of Object.entries(params)) {
                request.input(name, param.type, param.value);
            }
        }

        const result = await request.query(sql);
        return this.normalizeArrayResult(result);
    }

    /** Execute a SQL batch (supports GO separators, captures messages) */
    async executeBatch(sql: string): Promise<BatchResult> {
        const startTime = Date.now();
        const resultSets: QueryResult[] = [];
        const messages: string[] = [];
        let totalRowsAffected = 0;

        // Split by GO on its own line
        const batches = sql.split(/^\s*GO\s*$/gmi).filter(b => b.trim().length > 0);

        try {
            for (const batch of batches) {
                const batchResults = await this.executeSingleBatch(batch, messages);
                for (const result of batchResults) {
                    if (result.columns.length > 0 || result.rows.length > 0) {
                        resultSets.push(result);
                    }
                    totalRowsAffected += result.rows.length;
                }
            }

            return {
                resultSets,
                messages,
                rowsAffected: totalRowsAffected,
                elapsed: Date.now() - startTime,
            };
        } catch (err: any) {
            return {
                resultSets,
                messages,
                rowsAffected: totalRowsAffected,
                error: err.message,
                elapsed: Date.now() - startTime,
            };
        }
    }

    private async executeSingleBatch(sql: string, messages: string[]): Promise<QueryResult[]> {
        if (!this.pool || !this.pool.connected) { throw new Error('Not connected'); }

        // Use query() instead of batch() for arrayRowMode compatibility
        // GO splitting is already handled by executeBatch()
        const request = this.pool.request();
        (request as any).arrayRowMode = true;
        request.on('info', (info: any) => {
            if (info.message) { messages.push(info.message); }
        });

        const result = await request.query(sql);
        return this.normalizeArrayQueryResults(result);
    }

    /**
     * With arrayRowMode=true, result.recordset is an array of arrays (not objects).
     * result.columns contains ordered column metadata with name/index info.
     * We convert array rows to Record<string, any> with proper column names,
     * giving unnamed columns labels like "(No column name)".
     */
    private normalizeArrayResult(result: any): QueryResult {
        // result.columns is [[col1, col2, ...]] (array of arrays, one per recordset)
        // Take the first recordset's columns
        const rawCols = Array.isArray(result.columns?.[0]) ? result.columns[0] : result.columns;
        const columns = this.buildColumnNames(rawCols);
        const arrayRows = result.recordset || [];
        const rows = arrayRows.map((row: any[]) => {
            const obj: Record<string, any> = {};
            for (let i = 0; i < columns.length; i++) {
                obj[columns[i]] = this.formatValue(i < row.length ? row[i] : null);
            }
            return obj;
        });
        return { rows, columns };
    }

    /**
     * Convert query() result with arrayRowMode=true into QueryResult[].
     * With arrayRowMode, rows are arrays, columns metadata is in result.columns.
     * For multiple recordsets, we run a separate query per batch (GO-split already done).
     * So typically we have a single recordset here, but handle multiple just in case.
     */
    private normalizeArrayQueryResults(result: any): QueryResult[] {
        // Single recordset — the common case
        if (!result.recordsets || result.recordsets.length <= 1) {
            return [this.normalizeArrayResult(result)];
        }

        // Multiple recordsets — result.columns is [[cols0], [cols1], ...]
        return result.recordsets.map((rs: any[][], idx: number) => {
            if (!rs || rs.length === 0) {
                return { rows: [], columns: [] };
            }
            const rawCols = result.columns?.[idx];
            const columns = this.buildColumnNames(rawCols);
            const rows = rs.map((row: any[]) => {
                const obj: Record<string, any> = {};
                for (let i = 0; i < columns.length; i++) {
                    obj[columns[i]] = this.formatValue(i < row.length ? row[i] : null);
                }
                return obj;
            });
            return { rows, columns };
        });
    }

    /** Build display column names from mssql column metadata, handling unnamed columns */
    /** Format a cell value for display — handles Buffer (binary), Date, etc. */
    private formatValue(val: any): any {
        if (val === null || val === undefined) { return null; }
        // Binary data (Buffer) → hex string
        if (Buffer.isBuffer(val)) {
            if (val.length > 64) { return `0x${val.subarray(0, 32).toString('hex').toUpperCase()}... (${val.length} bytes)`; }
            return `0x${val.toString('hex').toUpperCase()}`;
        }
        // Date → SQL Server format
        if (val instanceof Date) {
            const y = val.getFullYear();
            const mo = String(val.getMonth() + 1).padStart(2, '0');
            const d = String(val.getDate()).padStart(2, '0');
            const h = String(val.getHours()).padStart(2, '0');
            const mi = String(val.getMinutes()).padStart(2, '0');
            const s = String(val.getSeconds()).padStart(2, '0');
            const ms = String(val.getMilliseconds()).padStart(3, '0');
            if (h === '00' && mi === '00' && s === '00' && ms === '000') {
                return `${y}-${mo}-${d}`;
            }
            return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
        }
        return val;
    }

    private buildColumnNames(colMeta: any[] | any | undefined): string[] {
        if (!colMeta) { return []; }

        // mssql columns can be an array of {name, index, ...} objects
        // OR an object keyed by column name: { "ColName": { index: 0, name: "ColName", ... } }
        let metaArray: any[];
        if (Array.isArray(colMeta)) {
            metaArray = colMeta;
        } else if (typeof colMeta === 'object') {
            // Object format: keys are column names, values have index property
            metaArray = Object.entries(colMeta)
                .map(([key, val]: [string, any]) => ({ name: key, index: val?.index ?? 0, ...val }))
                .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        } else {
            return [];
        }

        if (metaArray.length === 0) { return []; }
        const columns: string[] = [];
        let unnamedCount = 0;
        for (const col of colMeta) {
            const name = col.name ?? col;
            if (!name || name === '') {
                unnamedCount++;
                columns.push(unnamedCount === 1 ? '(No column name)' : `(No column name ${unnamedCount})`);
            } else {
                columns.push(String(name));
            }
        }
        return columns;
    }

    /** Test a connection profile without affecting current connection state */
    async testConnection(profile: ConnectionProfile): Promise<{ success: boolean; error?: string }> {
        try {
            const config = this.buildPoolConfig(profile);
            config.connectionTimeout = 10000;
            const pool = new mssql.ConnectionPool(config);
            await pool.connect();
            await pool.close();
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    /** Show Quick Pick to select a connection profile */
    async promptConnect(): Promise<void> {
        const profiles = this.getSavedProfiles();

        if (profiles.length === 0) {
            const action = await vscode.window.showWarningMessage(
                'No saved connections. Add connections in Settings → tsql-intellisense.connections',
                'Open Settings'
            );
            if (action === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'tsql-intellisense.connections');
            }
            return;
        }

        const items = profiles.map(p => ({
            label: p.name,
            description: `${p.server} / ${p.database}`,
            profile: p,
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a database connection',
        });

        if (selected) {
            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Connecting to ${selected.label}...` },
                    () => this.connect(selected.profile)
                );
                vscode.window.showInformationMessage(`Connected to ${selected.label}`);
            } catch (err: any) {
                vscode.window.showErrorMessage(err.message);
            }
        }
    }

    /**
     * Lightweight DB switch — reconnects pool with new database.
     * Does NOT update the status bar.
     */
    async softSwitchDatabase(dbName: string): Promise<void> {
        if (!this.pool || !this.activeProfile) { return; }
        if (this.activeProfile.database.toLowerCase() === dbName.toLowerCase()) { return; }
        try {
            const newProfile = { ...this.activeProfile, database: dbName };
            await this.pool.close();
            const config = this.buildPoolConfig(newProfile);
            const pool = new mssql.ConnectionPool(config);
            await pool.connect();
            this.pool = pool;
            this.activeProfile = newProfile;
        } catch { /* silently fail */ }
    }

    showEditorDb(_dbName: string | null): void {
        // No-op: status bar only shows connection name, not per-file DB
    }

    refreshStatusBar(): void {
        this.updateStatusBar();
    }

    /** Merge databaseProjects into active profile. Empty string value = delete that key. */
    updateDatabaseProjects(profileName: string, databaseProjects: Record<string, string>): void {
        if (this.activeProfile && this.activeProfile.name === profileName) {
            const merged: Record<string, string> = { ...(this.activeProfile.databaseProjects || {}) };
            for (const [db, path] of Object.entries(databaseProjects)) {
                if (path) { merged[db] = path; } else { delete merged[db]; }
            }
            this.activeProfile.databaseProjects = merged;
            this.updateStatusBar();
        }
    }

    private updateStatusBar(): void {
        if (this.activeProfile) {
            this.statusBarItem.text = `$(database) ${this.activeProfile.name}`;
            this.statusBarItem.tooltip = `${this.activeProfile.server}\nClick to switch connection`;
            this.statusBarItem.backgroundColor = undefined;
        } else {
            this.statusBarItem.text = '$(database) Not connected';
            this.statusBarItem.tooltip = 'Click to connect to a database';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
    }

    dispose(): void {
        if (this.pool) {
            this.pool.close().catch(() => {});
        }
        this.statusBarItem.dispose();
        this._onConnectionChanged.dispose();
    }
}

const TYPES = mssql.TYPES;
export { TYPES };
