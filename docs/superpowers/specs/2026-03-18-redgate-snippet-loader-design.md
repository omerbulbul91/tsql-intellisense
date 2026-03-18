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

Since clipboard read (`vscode.env.clipboard.readText()`) is async, resolve it in `resolveCompletionItem` rather than `provideCompletionItems` to avoid blocking the completion list.

## Out of Scope

- Multiple snippet directories
- Snippet editing UI
- Other Redgate-specific placeholders beyond $PASTE$ and $CURSOR$
- Snippet creation/management commands
