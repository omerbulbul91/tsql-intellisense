import { SchemaCache } from './schemaCache';
import { ConnectionManager } from '../connection/connectionManager';

export class SchemaCacheManager {
    private caches = new Map<string, SchemaCache>();
    private _active: SchemaCache | undefined;

    get(profileName: string, dbName: string): SchemaCache | undefined {
        return this.caches.get(`${profileName}::${dbName}`);
    }

    getOrCreate(profileName: string, dbName: string, connectionManager: ConnectionManager): SchemaCache {
        const key = `${profileName}::${dbName}`;
        if (!this.caches.has(key)) {
            this.caches.set(key, new SchemaCache(connectionManager));
        }
        return this.caches.get(key)!;
    }

    remove(profileName: string, dbName: string): void {
        const key = `${profileName}::${dbName}`;
        const cache = this.caches.get(key);
        if (cache) {
            cache.stopAutoRefresh();
            this.caches.delete(key);
        }
    }

    clear(): void {
        for (const cache of this.caches.values()) {
            cache.stopAutoRefresh();
        }
        this.caches.clear();
        this._active = undefined;
    }

    get active(): SchemaCache | undefined { return this._active; }
    set active(cache: SchemaCache | undefined) { this._active = cache; }

    dispose(): void {
        for (const cache of this.caches.values()) {
            cache.dispose();
        }
        this.caches.clear();
        this._active = undefined;
    }
}
