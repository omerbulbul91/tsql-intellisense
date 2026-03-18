import * as vscode from 'vscode';
import { Connection, Request, TYPES, ColumnMetaData } from 'tedious';

export interface ConnectionProfile {
    name: string;
    server: string;
    database: string;
    user?: string;
    password?: string;
    port?: number;
    trustServerCertificate?: boolean;
    projectPath?: string;
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
    private connection: Connection | null = null;
    private activeProfile: ConnectionProfile | null = null;
    private statusBarItem: vscode.StatusBarItem;
    private _onConnectionChanged = new vscode.EventEmitter<ConnectionProfile | null>();
    public readonly onConnectionChanged = this._onConnectionChanged.event;
    private requestQueue: (() => void)[] = [];
    private isRequestRunning = false;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = 'tsql-intellisense.connect';
        this.updateStatusBar();
        this.statusBarItem.show();
    }

    /** Wait for any running request to finish before executing */
    private waitForTurn(): Promise<void> {
        if (!this.isRequestRunning) {
            this.isRequestRunning = true;
            return Promise.resolve();
        }
        return new Promise(resolve => {
            this.requestQueue.push(resolve);
        });
    }

    private releaseRequest(): void {
        if (this.requestQueue.length > 0) {
            const next = this.requestQueue.shift()!;
            next();
        } else {
            this.isRequestRunning = false;
        }
    }

    get isConnected(): boolean {
        return this.connection !== null;
    }

    /** Parse "server,port" format into separate server and port */
    private parseServerPort(profile: ConnectionProfile): { server: string; port: number } {
        let server = profile.server;
        let port = profile.port || 1433;
        // Handle "server,port" format (SSMS style)
        if (server.includes(',')) {
            const parts = server.split(',');
            server = parts[0].trim();
            const parsed = parseInt(parts[1].trim());
            if (!isNaN(parsed)) { port = parsed; }
        }
        return { server, port };
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

            // Skip duplicates (same server+database already in our list)
            const isDuplicate = profiles.some(
                p => p.server === mc.server && p.database === mc.database
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

    /** Connect to a database using a profile */
    async connect(profile: ConnectionProfile): Promise<void> {
        // Disconnect existing connection
        if (this.connection) {
            await this.disconnect();
        }

        return new Promise((resolve, reject) => {
            const { server, port } = this.parseServerPort(profile);
            const config = {
                server,
                authentication: {
                    type: (profile.user ? 'default' : 'ntlm') as 'default' | 'ntlm',
                    options: {
                        userName: profile.user || '',
                        password: profile.password || '',
                    },
                },
                options: {
                    database: profile.database,
                    port,
                    trustServerCertificate: profile.trustServerCertificate !== false,
                    encrypt: false,
                    rowCollectionOnRequestCompletion: true,
                    connectTimeout: 10000,
                    requestTimeout: 30000,
                },
            };

            const conn = new Connection(config);

            conn.on('connect', (err) => {
                if (err) {
                    this.connection = null;
                    this.activeProfile = null;
                    this.updateStatusBar();
                    reject(new Error(`Connection failed: ${err.message}`));
                } else {
                    this.connection = conn;
                    this.activeProfile = profile;
                    this.updateStatusBar();
                    this._onConnectionChanged.fire(profile);
                    resolve();
                }
            });

            conn.on('error', (err) => {
                vscode.window.showErrorMessage(`T-SQL IntelliSense: Connection error - ${err.message}`);
                this.connection = null;
                this.activeProfile = null;
                this.updateStatusBar();
                this._onConnectionChanged.fire(null);
            });

            conn.connect();
        });
    }

    /** Disconnect from the current database */
    async disconnect(): Promise<void> {
        if (this.connection) {
            this.connection.close();
            this.connection = null;
            this.activeProfile = null;
            this.updateStatusBar();
            this._onConnectionChanged.fire(null);
        }
    }

    /** Execute a SQL query and return results */
    async executeQuery(sql: string, params?: Record<string, { type: any; value: any }>): Promise<QueryResult> {
        await this.waitForTurn();
        try {
            return await new Promise<QueryResult>((resolve, reject) => {
                if (!this.connection) {
                    reject(new Error('Not connected to database'));
                    return;
                }

                const rows: Record<string, any>[] = [];
                const columns: string[] = [];

                const request = new Request(sql, (err, rowCount, resultRows) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve({ rows, columns });
                    }
                });

                // Add parameters if provided
                if (params) {
                    for (const [name, param] of Object.entries(params)) {
                        request.addParameter(name, param.type, param.value);
                    }
                }

                request.on('columnMetadata', (columnsMetadata: ColumnMetaData[]) => {
                    for (const col of columnsMetadata) {
                        columns.push(col.colName);
                    }
                });

                request.on('row', (rowColumns: any[]) => {
                    const row: Record<string, any> = {};
                    for (const col of rowColumns) {
                        row[col.metadata.colName] = col.value;
                    }
                    rows.push(row);
                });

                this.connection.execSql(request);
            });
        } finally {
            this.releaseRequest();
        }
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
        await this.waitForTurn();
        try {
            return await new Promise<QueryResult[]>((resolve, reject) => {
                if (!this.connection) {
                    reject(new Error('Not connected to database'));
                    return;
                }

                const resultSets: QueryResult[] = [];
                let currentColumns: string[] = [];
                let currentRows: Record<string, any>[] = [];

                const request = new Request(sql, (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        // Push last result set if it has data
                        if (currentColumns.length > 0 || currentRows.length > 0) {
                            resultSets.push({ rows: currentRows, columns: currentColumns });
                        }
                        resolve(resultSets);
                    }
                });

                request.on('columnMetadata', (columnsMetadata: ColumnMetaData[]) => {
                    // New result set starting — save previous one if exists
                    if (currentColumns.length > 0 || currentRows.length > 0) {
                        resultSets.push({ rows: currentRows, columns: currentColumns });
                    }
                    // Start new result set
                    currentColumns = columnsMetadata.map(c => c.colName);
                    currentRows = [];
                });

                request.on('row', (rowColumns: any[]) => {
                    const row: Record<string, any> = {};
                    for (const col of rowColumns) {
                        row[col.metadata.colName] = col.value;
                    }
                    currentRows.push(row);
                });

                request.on('infoMessage', (info: any) => {
                    if (info.message) {
                        messages.push(info.message);
                    }
                });

                this.connection.execSql(request);
            });
        } finally {
            this.releaseRequest();
        }
    }

    /** Test a connection profile without affecting current connection state */
    async testConnection(profile: ConnectionProfile): Promise<{ success: boolean; error?: string }> {
        return new Promise((resolve) => {
            const { server, port } = this.parseServerPort(profile);
            const config = {
                server,
                authentication: {
                    type: (profile.user ? 'default' : 'ntlm') as 'default' | 'ntlm',
                    options: {
                        userName: profile.user || '',
                        password: profile.password || '',
                    },
                },
                options: {
                    database: profile.database,
                    port,
                    trustServerCertificate: profile.trustServerCertificate !== false,
                    encrypt: false,
                    connectTimeout: 10000,
                },
            };

            const testConn = new Connection(config);

            testConn.on('connect', (err) => {
                if (err) {
                    resolve({ success: false, error: err.message });
                } else {
                    testConn.close();
                    resolve({ success: true });
                }
            });

            testConn.on('error', () => {
                // Swallow — handled in connect callback
            });

            testConn.connect();
        });
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

    refreshStatusBar(): void {
        this.updateStatusBar();
    }

    private updateStatusBar(): void {
        if (this.activeProfile) {
            const folderIcon = this.activeProfile.projectPath ? '$(folder)' : '$(folder-x)';
            this.statusBarItem.text = `$(database) ${folderIcon} ${this.activeProfile.name}`;
            const projectInfo = this.activeProfile.projectPath
                ? `Project: ${this.activeProfile.projectPath}`
                : 'Project: Not configured';
            this.statusBarItem.tooltip = `${this.activeProfile.server} / ${this.activeProfile.database}\n${projectInfo}\nClick to switch connection`;
            this.statusBarItem.backgroundColor = undefined;
        } else {
            this.statusBarItem.text = '$(database) DB: Not connected';
            this.statusBarItem.tooltip = 'Click to connect to a database';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
    }

    dispose(): void {
        if (this.connection) {
            this.connection.close();
        }
        this.statusBarItem.dispose();
        this._onConnectionChanged.dispose();
    }
}

export { TYPES };
