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
            pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
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
        if (params) {
            for (const [name, param] of Object.entries(params)) {
                request.input(name, param.type, param.value);
            }
        }

        const result = await request.query(sql);
        const recordset = result.recordset || [];
        const { columns, rows } = this.normalizeRecordset(recordset);
        return { rows, columns };
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

        const request = this.pool.request();
        request.on('info', (info: any) => {
            if (info.message) { messages.push(info.message); }
        });

        const result = await request.batch(sql);
        const recordsets = result.recordsets as any[][];

        if (recordsets.length === 0) {
            return [{ rows: [], columns: [] }];
        }

        return recordsets.map(rs => this.normalizeRecordset(rs));
    }

    /**
     * Normalize a recordset: handle unnamed columns (@@SERVERNAME, DB_NAME() etc.)
     * mssql gives unnamed columns an empty string key — multiple unnamed cols collide.
     * We use recordset.columns metadata to get proper column info.
     */
    private normalizeRecordset(recordset: any): { rows: Record<string, any>[]; columns: string[] } {
        if (!recordset || recordset.length === 0) {
            // Try to get columns from metadata even if no rows
            if (recordset?.columns) {
                return { rows: [], columns: Object.keys(recordset.columns) };
            }
            return { rows: [], columns: [] };
        }

        // mssql's recordset.columns is an object with column metadata
        // Each key is the column name (or '' for unnamed), with index/name/type info
        const colMeta = recordset.columns;
        if (!colMeta) {
            // Fallback: use row keys
            return { rows: recordset, columns: Object.keys(recordset[0]) };
        }

        // Build ordered column list from metadata
        const metaEntries = Object.entries(colMeta) as [string, any][];
        metaEntries.sort((a, b) => (a[1].index ?? 0) - (b[1].index ?? 0));

        const columns: string[] = [];
        const keyMap = new Map<string, string>(); // original key → display name
        let unnamedCount = 0;

        for (const [key, meta] of metaEntries) {
            let displayName = key;
            if (!key || key === '') {
                unnamedCount++;
                displayName = `(No column name${unnamedCount > 1 ? ' ' + unnamedCount : ''})`;
            }
            columns.push(displayName);
            if (key !== displayName) {
                keyMap.set(key, displayName);
            }
        }

        // If we have unnamed columns, we need to rebuild rows with proper keys
        if (keyMap.size > 0) {
            // mssql stores unnamed column values under '' key — but multiple unnamed cols
            // are actually stored as separate properties. Let's rebuild using column index.
            const rows = recordset.map((row: any) => {
                const newRow: Record<string, any> = {};
                for (let i = 0; i < metaEntries.length; i++) {
                    const [origKey] = metaEntries[i];
                    const displayName = columns[i];
                    // Access by original key or by index from the raw row array
                    newRow[displayName] = row[origKey];
                }
                return newRow;
            });
            return { rows, columns };
        }

        return { rows: recordset, columns };
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
