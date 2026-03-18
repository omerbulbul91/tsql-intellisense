# Redgate SQL Prompt Snippet Loader

## Summary

Add support for loading Redgate SQL Prompt snippet files from a user-configured directory. Snippets are presented as VS Code completion items, enabling users to reuse their existing Redgate snippet libraries within tsql-intellisense.

## Motivation

User has 245 Redgate SQL Prompt snippets. Rather than converting them to a different format, the extension should natively read the Redgate JSON format from a configured folder path.

## Redgate Snippet Format

```json
{
  "id": "UUID-string",
  "prefix": "trigger-keyword",
  "description": "optional description",
  "body": "SQL template with \\n newlines and $CURSOR$ / $PASTE$ placeholders"
}
```

Each `.json` file in the directory contains one snippet.

## Design

### New File: `src/providers/snippetProvider.ts`

**Class:** `SnippetProvider implements CompletionItemProvider`

**Responsibilities:**
- Read `tsql-intellisense.snippetFolder` setting
- On activation, scan directory for `*.json` files
- Parse each file as Redgate snippet format
- Convert to `CompletionItem[]` and cache in memory
- Provide completions when user types (prefix-based matching by VS Code)

**Placeholder conversion:**
- `$CURSOR$` → `$0` (VS Code final cursor position)
- `$PASTE$` → clipboard content if available, otherwise `$1` (tabstop)
- `$PASTE$$CURSOR$` → clipboard content + `$0`, or `$1` if clipboard empty
- Body `\n` → actual newlines in SnippetString

**Reload:** Listen to `onDidChangeConfiguration` for `tsql-intellisense.snippetFolder` changes and reload snippets.

### Changes: `package.json`

Add setting:
```json
"tsql-intellisense.snippetFolder": {
  "type": "string",
  "default": "",
  "description": "Path to folder containing Redgate SQL Prompt snippet JSON files"
}
```

### Changes: `extension.ts`

- Import and instantiate `SnippetProvider`
- Register with `vscode.languages.registerCompletionItemProvider('sql', provider)`
- No trigger characters needed (normal prefix matching)

### Data Flow

```
Activation
  → read snippetFolder setting
  → scan *.json files in directory
  → parse each as {id, prefix, description, body}
  → convert placeholders, create CompletionItem[]
  → cache in memory

User typing
  → VS Code matches prefix against filterText/label
  → show matching snippets in completion list
  → on accept: resolve $PASTE$ (read clipboard), insert SnippetString
```

### Completion Item Properties

| Property | Value |
|----------|-------|
| label | prefix (e.g. "AP", "loj") |
| kind | CompletionItemKind.Snippet |
| detail | description or "SQL Prompt Snippet" |
| documentation | body preview (first 3 lines) |
| insertText | SnippetString with converted body |
| filterText | prefix |

### $PASTE$ Resolution

Since clipboard read (`vscode.env.clipboard.readText()`) is async, resolve it in `resolveCompletionItem`:

1. **At load time:** Body'deki `$PASTE$` yerinde sentinel placeholder `${1:PASTE}` bırakılır
2. **resolveCompletionItem'da:** Clipboard okunur, sentinel gerçek değerle veya boşsa `$1` tabstop ile değiştirilir
3. `$CURSOR$` → `$0` dönüşümü load time'da yapılır (async gerektirmez)

### Error Handling

- Geçersiz JSON veya eksik `prefix`/`body` alanı olan dosyalar atlanır, Output Channel'a warning yazılır
- `prefix` ve `body` zorunlu; `id` ve `description` opsiyonel
- Dizin mevcut değilse veya erişilemezse bir kez warning mesajı gösterilir
- Unrecognized placeholder'lar (`$SELECTEDTEXT$`, `$DATE$` vb.) literal metin olarak bırakılır

### Loading

- Snippet'ler async yüklenir (`fs.promises.readdir` + `fs.promises.readFile`)
- `sortText: "zz_"` prefix ile snippet'ler schema completion'larının altında sıralanır
- Dosya isimleri önemsiz, sadece JSON içindeki `prefix` kullanılır
- `documentation` alanı MarkdownString ile SQL syntax highlighting (```sql fence) kullanır
- Document selector: `{ language: 'sql', scheme: '*' }` (mevcut provider ile tutarlı)
- Disposable'lar `context.subscriptions`'a eklenir

### Reload

- `onDidChangeConfiguration` dinlenir, `snippetFolder` değişince yeniden yüklenir
- File watcher yok (kapsam dışı) — yeni snippet eklenince setting'i değiştirmek veya window reload yeterli

## Out of Scope

- Multiple snippet directories
- Snippet editing UI
- File system watcher (snippet dizini değişiklik izleme)
- Other Redgate-specific placeholders beyond $PASTE$ and $CURSOR$
- Snippet creation/management commands
