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
}

export interface QueryResult {
    rows: Record<string, any>[];
    columns: string[];
}

export class ConnectionManager {
    private connection: Connection | null = null;
    private activeProfile: ConnectionProfile | null = null;
    private statusBarItem: vscode.StatusBarItem;
    private _onConnectionChanged = new vscode.EventEmitter<ConnectionProfile | null>();
    public readonly onConnectionChanged = this._onConnectionChanged.event;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = 'tsql-intellisense.connect';
        this.updateStatusBar();
        this.statusBarItem.show();
    }

    get isConnected(): boolean {
        return this.connection !== null;
    }

    get currentProfile(): ConnectionProfile | null {
        return this.activeProfile;
    }

    /** Get saved connection profiles from settings */
    getSavedProfiles(): ConnectionProfile[] {
        const config = vscode.workspace.getConfiguration('tsql-intellisense');
        return config.get<ConnectionProfile[]>('connections', []);
    }

    /** Connect to a database using a profile */
    async connect(profile: ConnectionProfile): Promise<void> {
        // Disconnect existing connection
        if (this.connection) {
            await this.disconnect();
        }

        return new Promise((resolve, reject) => {
            const config = {
                server: profile.server,
                authentication: {
                    type: (profile.user ? 'default' : 'ntlm') as 'default' | 'ntlm',
                    options: {
                        userName: profile.user || '',
                        password: profile.password || '',
                    },
                },
                options: {
                    database: profile.database,
                    port: profile.port || 1433,
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
    executeQuery(sql: string, params?: Record<string, { type: any; value: any }>): Promise<QueryResult> {
        return new Promise((resolve, reject) => {
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

    private updateStatusBar(): void {
        if (this.activeProfile) {
            this.statusBarItem.text = `$(database) ${this.activeProfile.name}`;
            this.statusBarItem.tooltip = `${this.activeProfile.server} / ${this.activeProfile.database}\nClick to switch connection`;
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
