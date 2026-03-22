import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface RedgateSnippet {
    id?: string;
    prefix: string;
    description?: string;
    body: string;
}

export class SnippetProvider implements vscode.CompletionItemProvider {
    private items: vscode.CompletionItem[] = [];
    private snippets: RedgateSnippet[] = [];
    private snippetFolder: string = '';
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    async loadSnippets(): Promise<void> {
        const folder = vscode.workspace.getConfiguration('tsql-intellisense').get<string>('snippetFolder', '');
        this.items = [];
        this.snippets = [];
        this.snippetFolder = folder;

        if (!folder) {
            return;
        }

        // Dizin erişim kontrolü
        try {
            await fs.promises.access(folder, fs.constants.R_OK);
        } catch {
            vscode.window.showWarningMessage(`Snippet dizini bulunamadı veya erişilemiyor: ${folder}`);
            return;
        }

        const files = await fs.promises.readdir(folder);
        const jsonFiles = files.filter(f => f.endsWith('.json'));

        for (const file of jsonFiles) {
            try {
                const content = await fs.promises.readFile(path.join(folder, file), 'utf-8');
                const snippet: RedgateSnippet = JSON.parse(content);

                if (!snippet.prefix || !snippet.body) {
                    this.outputChannel.appendLine(`[Snippet] Atlandı (prefix/body eksik): ${file}`);
                    continue;
                }

                this.snippets.push(snippet);
                const item = this.createCompletionItem(snippet);
                this.items.push(item);
            } catch (err: any) {
                this.outputChannel.appendLine(`[Snippet] Parse hatası: ${file} — ${err.message}`);
            }
        }

        this.outputChannel.appendLine(`[Snippet] ${this.items.length} snippet yüklendi (${folder})`);
    }

    private createCompletionItem(snippet: RedgateSnippet): vscode.CompletionItem {
        const item = new vscode.CompletionItem(snippet.prefix, vscode.CompletionItemKind.Snippet);

        // Detail: kaynak etiketi
        item.detail = snippet.description
            ? `SQL Prompt: ${snippet.description}`
            : 'SQL Prompt Snippet';

        // Documentation: kaynak + body önizlemesi (SQL syntax highlighting)
        const bodyPreview = snippet.body.replace(/\\n/g, '\n');
        const previewLines = bodyPreview.split('\n').slice(0, 10).join('\n');
        const md = new vscode.MarkdownString();
        md.appendMarkdown('**SQL Prompt Snippet**\n\n');
        md.appendCodeblock(previewLines, 'sql');
        item.documentation = md;

        // Body dönüşümü: $CURSOR$ → $0, $PASTE$ → sentinel
        let converted = snippet.body.replace(/\\n/g, '\n');
        // Özel placeholder'lar
        converted = converted.replace(/\$PASTE\$\$CURSOR\$/g, '${1:PASTE}$0');
        converted = converted.replace(/\$CURSOR\$/g, '$0');
        converted = converted.replace(/\$PASTE\$/g, '${1:PASTE}');
        converted = converted.replace(/\$SELECTIONSTART\$/g, '');
        converted = converted.replace(/\$SELECTIONEND\$/g, '');

        // Genel $name$ placeholder'ları → ${N:name} tabstop'larına dönüştür
        // Aynı isimli placeholder'lar aynı numara alır
        const placeholderMap = new Map<string, number>();
        let nextIndex = converted.includes('${1:PASTE}') ? 2 : 1;
        converted = converted.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)\$/g, (_match, name) => {
            if (!placeholderMap.has(name)) {
                placeholderMap.set(name, nextIndex++);
            }
            return `\${${placeholderMap.get(name)}:${name}}`;
        });

        item.insertText = new vscode.SnippetString(converted);
        item.filterText = snippet.prefix;
        item.sortText = `zz_${snippet.prefix}`;

        return item;
    }

    public getSnippets(): RedgateSnippet[] {
        return this.snippets;
    }

    public getSnippetFolder(): string {
        return this.snippetFolder;
    }

    provideCompletionItems(
        _document: vscode.TextDocument,
        _position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.CompletionItem[] {
        return this.items;
    }

    async resolveCompletionItem(
        item: vscode.CompletionItem,
        _token: vscode.CancellationToken
    ): Promise<vscode.CompletionItem> {
        if (item.insertText instanceof vscode.SnippetString && item.insertText.value.includes('${1:PASTE}')) {
            try {
                const clipboard = await vscode.env.clipboard.readText();
                if (clipboard) {
                    // Pano içeriği varsa sentinel'i clipboard ile değiştir
                    const escaped = clipboard.replace(/\$/g, '\\$');
                    item.insertText = new vscode.SnippetString(
                        item.insertText.value.replace('${1:PASTE}', escaped)
                    );
                } else {
                    // Pano boşsa tabstop olarak bırak ($1)
                    item.insertText = new vscode.SnippetString(
                        item.insertText.value.replace('${1:PASTE}', '$1')
                    );
                }
            } catch {
                item.insertText = new vscode.SnippetString(
                    item.insertText.value.replace('${1:PASTE}', '$1')
                );
            }
        }
        return item;
    }
}
