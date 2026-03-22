import { ConnectionManager, ConnectionProfile } from '../connection/connectionManager';

export function escapeSql(value: string): string {
    return value.replace(/'/g, "''");
}

/**
 * Tree-specific query service with per-profile connection pool map.
 * Each profile gets its own mssql ConnectionPool — multiple servers
 * can be browsed simultaneously without reconnecting.
 */
export class TreeQueryService {
    private pools = new Map<string, any>();
    private mssql: any;

    constructor(private connectionManager: ConnectionManager) {
        this.mssql = require('mssql');
    }

    /** Check if a specific profile has an active pool */
    isConnected(profileName?: string): boolean {
        if (!profileName) { return this.connectionManager.isConnected; }
        const pool = this.pools.get(profileName);
        return pool?.connected === true;
    }

    get currentProfileName(): string | undefined {
        return this.connectionManager.currentProfile?.name;
    }

    /** Connect a profile — creates a connection pool if not already open */
    async connect(profileName: string): Promise<void> {
        if (this.isConnected(profileName)) { return; }

        const profile = this.connectionManager.getSavedProfiles()
            .find(p => p.name === profileName);
        if (!profile) { throw new Error(`Profile "${profileName}" not found`); }

        // Parse server and port
        let server = profile.server;
        let port = profile.port ?? 1433;
        if (server.includes(',')) {
            const parts = server.split(',');
            server = parts[0];
            port = parseInt(parts[1], 10) || port;
        }

        const config: any = {
            server,
            port,
            database: profile.database || undefined,
            options: {
                encrypt: profile.encrypt === 'mandatory' || profile.encrypt === 'strict',
                trustServerCertificate: profile.trustServerCertificate ?? true,
                enableArithAbort: true,
            },
            connectionTimeout: 15000,
            requestTimeout: 0,
            pool: {
                max: 5,
                min: 0,
                idleTimeoutMillis: 600000,
            },
        };

        if (profile.user) {
            config.user = profile.user;
            config.password = profile.password;
        } else {
            // Windows authentication
            config.options.trustedConnection = true;
        }

        const pool = new this.mssql.ConnectionPool(config);
        await pool.connect();
        this.pools.set(profileName, pool);
    }

    /** Disconnect a specific profile's pool */
    async disconnect(profileName: string): Promise<void> {
        const pool = this.pools.get(profileName);
        if (pool) {
            try { await pool.close(); } catch { /* ignore */ }
            this.pools.delete(profileName);
        }
    }

    /** Disconnect all pools */
    async disconnectAll(): Promise<void> {
        for (const profileName of [...this.pools.keys()]) {
            await this.disconnect(profileName);
        }
    }

    /**
     * Execute SQL against a specific profile's pool.
     * If databaseName is provided, prepends USE [db]; to the query.
     */
    async execute(sql: string, databaseName?: string, profileName?: string): Promise<{ rows: Record<string, any>[] }> {
        // Determine which pool to use
        const name = profileName ?? this.getFirstConnectedProfile();
        if (!name) { throw new Error('No connection available'); }

        const pool = this.pools.get(name);
        if (!pool || !pool.connected) {
            throw new Error(`Not connected: ${name}`);
        }

        if (databaseName) {
            const safe = databaseName.replace(/\]/g, ']]');
            sql = `USE [${safe}];\n${sql}`;
        }

        const result = await pool.request().query(sql);

        // mssql returns recordsets array — take the last one (after USE)
        const recordsets = result.recordsets as any[][];
        const lastRecordset = recordsets.length > 0 ? recordsets[recordsets.length - 1] : [];
        return { rows: lastRecordset };
    }

    getProfiles(): ConnectionProfile[] {
        return this.connectionManager.getSavedProfiles();
    }

    private getFirstConnectedProfile(): string | undefined {
        for (const [name, pool] of this.pools) {
            if (pool?.connected) { return name; }
        }
        return undefined;
    }
}
