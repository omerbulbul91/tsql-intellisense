export interface ConnectionHeader {
    profileName: string;
    database: string;
    project: string | null;
}

const HEADER_REGEX = /^--\s*Connection:\s*(.+?)\s*\|\s*Database:\s*(.+?)\s*\|\s*Project:\s*(.+?)\s*$/;

export function parseConnectionHeader(firstLine: string): ConnectionHeader | null {
    const match = firstLine.match(HEADER_REGEX);
    if (!match) { return null; }
    return {
        profileName: match[1].trim(),
        database: match[2].trim(),
        project: match[3].trim() === 'null' ? null : match[3].trim(),
    };
}

export function buildConnectionHeader(profileName: string, database: string, project: string | null): string {
    return `-- Connection: ${profileName} | Database: ${database} | Project: ${project ?? 'null'}`;
}
