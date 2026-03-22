import { ConnectionManager, ConnectionProfile } from '../connection/connectionManager';

export function escapeSql(value: string): string {
    return value.replace(/'/g, "''");
}

export class TreeQueryService {
    constructor(private connectionManager: ConnectionManager) {}

    async execute(sql: string, databaseName?: string): Promise<{ rows: Record<string, any>[] }> {
        if (databaseName) {
            const safe = databaseName.replace(/\]/g, ']]');
            await this.connectionManager.executeQuery(`USE [${safe}]`);
        }
        const result = await this.connectionManager.executeQuery(sql);
        return { rows: result.rows };
    }

    isConnected(): boolean {
        return this.connectionManager.isConnected;
    }

    get currentProfileName(): string | undefined {
        return this.connectionManager.currentProfile?.name;
    }

    async connect(profileName: string): Promise<void> {
        const profile = this.connectionManager.getSavedProfiles()
            .find(p => p.name === profileName);
        if (!profile) { throw new Error(`Profile "${profileName}" not found`); }
        await this.connectionManager.connect(profile);
    }

    getProfiles(): ConnectionProfile[] {
        return this.connectionManager.getSavedProfiles();
    }
}
