/** Shared timestamp formatter for log lines — returns HH:MM:SS */
export function ts(): string {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
