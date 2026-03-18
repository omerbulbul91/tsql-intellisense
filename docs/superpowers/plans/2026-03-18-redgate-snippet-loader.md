# Redgate SQL Prompt Snippet Loader - Implementasyon Planı

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kullanıcının Redgate SQL Prompt snippet dizinini ayardan göstererek, mevcut snippet'lerini VS Code completion olarak sunmak.

**Architecture:** Yeni `SnippetProvider` sınıfı dizindeki JSON dosyalarını async okur, Redgate formatını parse eder, `$PASTE$`/`$CURSOR$` placeholder'larını VS Code SnippetString'e dönüştürür. `resolveCompletionItem` ile clipboard desteği sağlanır.

**Tech Stack:** TypeScript, VS Code CompletionItemProvider API, fs.promises

---

## Chunk 1: Implementasyon

### Task 1: package.json'a snippetFolder ayarı ekle

**Files:**
- Modify: `package.json:204` (configuration.properties bloğunun sonuna)

- [ ] **Step 1: Ayarı ekle**

`tsql-intellisense.queryShortcuts` bloğunun kapanışından sonra, `properties` kapanışından önce ekle:

```json
"tsql-intellisense.snippetFolder": {
  "type": "string",
  "default": "",
  "description": "Redgate SQL Prompt snippet JSON dosyalarını içeren dizin yolu"
}
```

- [ ] **Step 2: Build kontrolü**

Run: `npm run build`
Expected: Hatasız build

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat: snippetFolder ayarı ekle"
```

---

### Task 2: SnippetProvider oluştur

**Files:**
- Create: `src/providers/snippetProvider.ts`

- [ ] **Step 1: SnippetProvider sınıfını yaz**

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface RedgateSnippet {
    id?: string;
    prefix: string;
    description?: string;
    body: string;
}

export class SnippetProvider implements vscode.CompletionItemProvider {
    private items: vscode.CompletionItem[] = [];
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    async loadSnippets(): Promise<void> {
        const folder = vscode.workspace.getConfiguration('tsql-intellisense').get<string>('snippetFolder', '');
        this.items = [];

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
        // Önce $PASTE$$CURSOR$ birleşik olanı yakala
        converted = converted.replace(/\$PASTE\$\$CURSOR\$/g, '${1:PASTE}$0');
        // Sonra tek başına olanları
        converted = converted.replace(/\$CURSOR\$/g, '$0');
        converted = converted.replace(/\$PASTE\$/g, '${1:PASTE}');

        item.insertText = new vscode.SnippetString(converted);
        item.filterText = snippet.prefix;
        item.sortText = `zz_${snippet.prefix}`;

        return item;
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
```

- [ ] **Step 2: Build kontrolü**

Run: `npm run build`
Expected: Hatasız build

- [ ] **Step 3: Commit**

```bash
git add src/providers/snippetProvider.ts
git commit -m "feat: SnippetProvider — Redgate snippet yükleyici"
```

---

### Task 3: extension.ts'e SnippetProvider kaydı ekle

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Import ekle**

`extension.ts` satır 8'den sonra:
```typescript
import { SnippetProvider } from './providers/snippetProvider';
```

- [ ] **Step 2: Provider oluştur ve kaydet**

`activate()` fonksiyonu içinde, definition provider kaydından sonra (satır ~54 sonrası) ekle:

```typescript
// Register snippet provider for Redgate SQL Prompt snippets
const snippetOutputChannel = vscode.window.createOutputChannel('T-SQL Snippets');
const snippetProvider = new SnippetProvider(snippetOutputChannel);
snippetProvider.loadSnippets();
context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
        { language: 'sql', scheme: '*' },
        snippetProvider
    )
);

// Reload snippets when setting changes
context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('tsql-intellisense.snippetFolder')) {
            snippetProvider.loadSnippets();
        }
    })
);
```

- [ ] **Step 3: Build kontrolü**

Run: `npm run build`
Expected: Hatasız build

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts
git commit -m "feat: SnippetProvider'ı extension'a kaydet"
```

---

### Task 4: Manuel test (F5)

- [ ] **Step 1: Settings'e snippet dizini ekle**

VS Code settings.json'a ekle:
```json
"tsql-intellisense.snippetFolder": "C:\\Users\\ÖmerBülbül\\OneDrive - RENIUM\\Belgeler - Proje\\General\\GitHub\\SQL-DEV\\SQL-PROMPT\\Snippets"
```

- [ ] **Step 2: Extension Development Host'ta test**

F5 ile başlat, SQL dosyasında:
1. Redgate snippet prefix'lerinden birini yaz (ör. `snp_`, `AP`, `DynamicPivot`)
2. Completion listesinde snippet görünmeli
3. Detail'de "SQL Prompt" veya "SQL Prompt: açıklama" olmalı
4. Doc popup'ta **SQL Prompt Snippet** etiketi + SQL body önizlemesi olmalı
5. Mevcut `loj`, `st` gibi yerleşik snippet'ler de hala çalışmalı

- [ ] **Step 3: $PASTE$ testi**

1. Bir metin kopyala (Ctrl+C)
2. `$PASTE$` içeren bir snippet tetikle
3. Kopyalanan metin snippet'e yapıştırılmalı

- [ ] **Step 4: Hata yönetimi testi**

1. Geçersiz bir dizin yolu ayarla → uyarı mesajı görmeli
2. Output Channel'da ("T-SQL Snippets") yükleme loglarını kontrol et

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: Redgate SQL Prompt snippet loader tamamlandı"
```
