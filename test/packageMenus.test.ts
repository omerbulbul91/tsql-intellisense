/**
 * Programmatic tests for package.json context menu definitions.
 * Run: npx ts-node test/packageMenus.test.ts
 *
 * Ensures critical menu items are wired to the correct viewItem conditions.
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${testName}`);
    } else {
        failed++;
        console.log(`  ✗ ${testName}`);
    }
}

const pkgPath = path.resolve(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
const treeMenus: { command: string; when?: string; group?: string }[] =
    pkg.contributes.menus['view/item/context'] || [];

function findMenuEntry(command: string) {
    return treeMenus.filter((m: any) => m.command === command);
}

function whenMatches(when: string, viewItem: string): boolean {
    // Simple evaluator for the "when" expressions used in package.json
    // Supports: viewItem == X, viewItem =~ /regex/, || (OR)
    return when.split('||').some(part => {
        part = part.trim();
        const eqMatch = part.match(/^viewItem\s*==\s*(\S+)$/);
        if (eqMatch) { return eqMatch[1] === viewItem; }
        const reMatch = part.match(/^viewItem\s*=~\s*\/(.+)\/$/);
        if (reMatch) { return new RegExp(reMatch[1]).test(viewItem); }
        return false;
    });
}

// ─── editConnection must appear on Database nodes ───
console.log('\n[editConnection context menu]');
{
    const entries = findMenuEntry('tsql-intellisense.editConnection');
    assert(entries.length > 0, 'editConnection has a menu entry');

    const entry = entries[0];
    assert(!!entry.when, 'editConnection has a when clause');

    // Must match Connection nodes
    assert(whenMatches(entry.when!, 'ConnectionConnected'), 'editConnection shows on ConnectionConnected');
    assert(whenMatches(entry.when!, 'ConnectionDisconnected'), 'editConnection shows on ConnectionDisconnected');

    // Must match Database nodes
    assert(whenMatches(entry.when!, 'Database'), 'editConnection shows on Database nodes');
}

// ─── deleteConnection must NOT appear on Database nodes ───
console.log('\n[deleteConnection context menu]');
{
    const entries = findMenuEntry('tsql-intellisense.deleteConnection');
    assert(entries.length > 0, 'deleteConnection has a menu entry');

    const entry = entries[0];
    assert(!whenMatches(entry.when!, 'Database'), 'deleteConnection does NOT show on Database nodes');
}

// ─── backupDatabase / restoreDatabase only on Database ───
console.log('\n[backup/restore context menu]');
{
    const backup = findMenuEntry('tsql-intellisense.backupDatabase');
    assert(backup.length > 0, 'backupDatabase has a menu entry');
    assert(whenMatches(backup[0].when!, 'Database'), 'backupDatabase shows on Database');
    assert(!whenMatches(backup[0].when!, 'ConnectionConnected'), 'backupDatabase does NOT show on Connection');

    const restore = findMenuEntry('tsql-intellisense.restoreDatabase');
    assert(restore.length > 0, 'restoreDatabase has a menu entry');
    assert(whenMatches(restore[0].when!, 'Database'), 'restoreDatabase shows on Database');
}

// ─── newQueryFromTree on Database, Schema, and Connection ───
console.log('\n[newQueryFromTree context menu]');
{
    const entries = findMenuEntry('tsql-intellisense.newQueryFromTree');
    assert(entries.length > 0, 'newQueryFromTree has menu entries');

    // At least one entry should cover Database
    const coversDatabase = entries.some(e => e.when && whenMatches(e.when, 'Database'));
    assert(coversDatabase, 'newQueryFromTree available on Database');

    const coversConnection = entries.some(e => e.when && whenMatches(e.when, 'ConnectionConnected'));
    assert(coversConnection, 'newQueryFromTree available on ConnectionConnected');
}

// ─── Summary ───
console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'═'.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
