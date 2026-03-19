# SQL Formatter — Redgate SQL Prompt Stil Desteği

## Özet

tsql-intellisense eklentisine SQL formatlama özelliği eklenmesi. Redgate SQL Prompt stil dosyaları (JSON v2 formatı) okunarak SQL kodu bu kurallara göre formatlanır. RENIUMSTYLE varsayılan stil olarak gömülüdür.

## Motivasyon

- CLAUDE.md'de "Formatlama özelliği henüz yok" olarak belirtilmiş roadmap hedefi
- Kullanıcılar mevcut Redgate SQL Prompt stillerini (.json) doğrudan kullanabilecek
- Tutarlı SQL kod formatı sağlanacak

## Faz Planı

Kolaydan zora, artımlı geliştirme:

### Faz 1: Casing (Bu spec)
- Keyword casing (uppercase, lowercase, upperCamelCase, leaveAsIs)
- Built-in function casing
- Built-in datatype casing
- Tokenizer altyapısı (tüm fazların temeli)

### Faz 2: Temel Whitespace & Liste Kuralları
- `placeCommasBeforeItems` — virgül pozisyonu
- `alignItemsToTabStops` — tab hizalama
- Boş satır kuralları (statement arası, batch separator sonrası)

### Faz 3: JOIN & ON Formatlama
- `join.keywordAlignment` — JOIN keyword hizalama
- `on.placeOnNewLine` — ON pozisyonu
- `on.placeConditionOnNewLine` — condition yeni satırda
- `on.conditionAlignment` — condition hizalama

### Faz 4: DML Kuralları
- `addNewLineAfterDistinctAndTopClauses`
- `collapseShortStatements` (<120 karakter)
- `collapseShortSubqueries` (<120 karakter)

### Faz 5: DDL, CTE, CASE, Control Flow, Operators
- DDL: indent, constraint new lines, proc params
- CTE: expandedSplit, indent contents
- CASE: when alignment, collapse short
- Control flow: BEGIN/END, collapse
- AND/OR, IN operators

---

## Faz 1 Detaylı Tasarım

### Mimari

```
src/
├── formatter/
│   ├── sqlTokenizer.ts      -- SQL metni → token dizisi
│   ├── casingRule.ts         -- Casing kuralları uygulama
│   ├── styleLoader.ts       -- Stil JSON dosyasını okuma
│   └── sqlFormatter.ts      -- Orkestratör: tokenize → rule → çıktı
├── providers/
│   └── formatterProvider.ts -- VS Code formatting provider + komut
```

### Token Türleri

```typescript
type TokenType =
  | 'keyword'       // SELECT, FROM, WHERE, JOIN, ON, AND, OR...
  | 'function'      // COUNT, SUM, ISNULL, GETDATE, ROW_NUMBER...
  | 'datatype'      // INT, VARCHAR, DATETIME, UNIQUEIDENTIFIER...
  | 'identifier'    // tablo, kolon, SP adları, [bracketed] dahil
  | 'string'        // '...', N'...'
  | 'comment'       // -- ..., /* ... */
  | 'number'        // 123, 12.5, 0x1F
  | 'operator'      // =, <>, >=, <=, !=, +, -, *, /, %
  | 'punctuation'   // (, ), ,, ;, .
  | 'whitespace'    // boşluk, tab, newline

interface Token {
  type: TokenType;
  value: string;      // orijinal metin
  offset: number;     // kaynak metindeki başlangıç pozisyonu
}
```

### Tokenizer Öncelik Sırası

İlk eşleşen kazanır:

1. **String** — `'...'` ve `N'...'` (escape: `''`)
2. **Comment** — `--...\n` ve `/* ... */` (nested değil)
3. **Bracketed identifier** — `[...]`
4. **Number** — `\d+(\.\d+)?` ve `0x[0-9a-fA-F]+`
5. **Operator** — `<>`, `>=`, `<=`, `!=`, `=`, `<`, `>`, `+`, `-`, `*`, `/`, `%`
6. **Punctuation** — `(`, `)`, `,`, `;`, `.`
7. **Whitespace** — `\s+`
8. **Word** — `[a-zA-Z_@#][a-zA-Z0-9_@#]*` → keyword/function/datatype/identifier ayrımı

Word sınıflandırma: kelime (case-insensitive) keyword listesinde → `keyword`, function listesinde → `function`, datatype listesinde → `datatype`, hiçbiri → `identifier`.

### Keyword Listesi

```
SELECT, FROM, WHERE, JOIN, ON, AND, OR, NOT, IN, EXISTS, BETWEEN, LIKE, IS, NULL,
AS, BY, ORDER, GROUP, HAVING, DISTINCT, TOP, INTO, VALUES, UNION, ALL, ANY, SOME,
CROSS, FULL, INNER, LEFT, RIGHT, OUTER, WITH, OVER, PARTITION,
INSERT, UPDATE, DELETE, SET, EXEC, EXECUTE,
CREATE, ALTER, DROP, TRUNCATE,
DECLARE, BEGIN, END, IF, ELSE, WHILE, RETURN, BREAK, CONTINUE,
TRY, CATCH, THROW, RAISERROR,
CASE, WHEN, THEN, ELSE, END,
GO, PRINT, USE,
TRANSACTION, COMMIT, ROLLBACK, SAVE,
PROCEDURE, PROC, FUNCTION, TABLE, VIEW, INDEX, TRIGGER, DATABASE, SCHEMA,
PRIMARY, KEY, FOREIGN, REFERENCES, CONSTRAINT, DEFAULT, CHECK, UNIQUE,
CLUSTERED, NONCLUSTERED, ASC, DESC,
OUTPUT, RETURNS, READONLY,
PIVOT, UNPIVOT, EXCEPT, INTERSECT,
MERGE, MATCHED, SOURCE, TARGET,
GRANT, REVOKE, DENY,
CURSOR, OPEN, CLOSE, FETCH, NEXT, DEALLOCATE,
NOLOCK, HOLDLOCK, UPDLOCK, ROWLOCK, TABLOCK, READUNCOMMITTED, READCOMMITTED,
OPTION, RECOMPILE, MAXDOP
```

### Function Listesi

```
-- Aggregate
COUNT, SUM, AVG, MIN, MAX, STRING_AGG, CHECKSUM_AGG, COUNT_BIG,
STDEV, STDEVP, VAR, VARP,
-- Window
ROW_NUMBER, RANK, DENSE_RANK, NTILE, LAG, LEAD,
FIRST_VALUE, LAST_VALUE, PERCENT_RANK, CUME_DIST,
-- Conversion
CAST, CONVERT, TRY_CAST, TRY_CONVERT, PARSE, TRY_PARSE,
-- String
LEN, DATALENGTH, LEFT, RIGHT, SUBSTRING, CHARINDEX, PATINDEX,
REPLACE, STUFF, TRIM, LTRIM, RTRIM, UPPER, LOWER, REVERSE,
REPLICATE, SPACE, CONCAT, CONCAT_WS, STRING_SPLIT, QUOTENAME,
CHAR, ASCII, UNICODE, NCHAR, FORMAT,
-- Date/Time
GETDATE, GETUTCDATE, SYSDATETIME, SYSUTCDATETIME,
DATEADD, DATEDIFF, DATEDIFF_BIG, DATENAME, DATEPART,
YEAR, MONTH, DAY, EOMONTH, DATEFROMPARTS, DATETIME2FROMPARTS,
ISDATE, SWITCHOFFSET, TODATETIMEOFFSET,
-- Math
ABS, CEILING, FLOOR, ROUND, POWER, SQRT, SIGN, LOG, LOG10, EXP,
RAND, PI, SIN, COS, TAN, ASIN, ACOS, ATAN, ATN2,
-- NULL handling
ISNULL, COALESCE, NULLIF, IIF, CHOOSE,
-- System
NEWID, NEWSEQUENTIALID, SCOPE_IDENTITY, IDENT_CURRENT,
@@IDENTITY, @@ROWCOUNT, @@ERROR, @@TRANCOUNT,
OBJECT_ID, OBJECT_NAME, OBJECT_DEFINITION, DB_ID, DB_NAME,
SCHEMA_ID, SCHEMA_NAME, TYPE_ID, TYPE_NAME,
COL_NAME, COL_LENGTH, COLUMNPROPERTY,
USER_NAME, SUSER_SNAME, SYSTEM_USER, SESSION_USER,
HOST_NAME, APP_NAME, ERROR_MESSAGE, ERROR_NUMBER, ERROR_SEVERITY,
-- JSON
JSON_VALUE, JSON_QUERY, JSON_MODIFY, ISJSON, OPENJSON,
-- XML
NODES, VALUE, QUERY, EXIST
```

### Datatype Listesi

```
INT, BIGINT, SMALLINT, TINYINT, BIT,
DECIMAL, NUMERIC, FLOAT, REAL, MONEY, SMALLMONEY,
CHAR, VARCHAR, NCHAR, NVARCHAR, TEXT, NTEXT,
DATE, DATETIME, DATETIME2, SMALLDATETIME, TIME, DATETIMEOFFSET,
UNIQUEIDENTIFIER, XML, SQL_VARIANT,
BINARY, VARBINARY, IMAGE, TIMESTAMP, ROWVERSION,
GEOGRAPHY, GEOMETRY, HIERARCHYID,
CURSOR, TABLE
```

### Casing Modları

| Mod | Giriş | Çıkış |
|-----|-------|-------|
| `uppercase` | `select`, `Select` | `SELECT` |
| `lowercase` | `SELECT`, `Select` | `select` |
| `upperCamelCase` | `select`, `SELECT` | `Select` |
| `leaveAsIs` | herhangi | değişmez |

**Multi-word keyword casing (upperCamelCase):**
- `LEFT OUTER JOIN` → `Left Outer Join` (her kelime ayrı token, her birine uygulanır)
- `ORDER BY` → `Order By`
- `INSERT INTO` → `Insert Into`

**upperCamelCase dönüşüm kuralı:**
- İlk harf büyük, geri kalan küçük: `GETDATE` → `Getdate`? Hayır — bu fonksiyon casing.
- upperCamelCase sadece keyword'lere ve datatype'lara uygulanır (stil dosyasında öyle tanımlı)
- Fonksiyonlar `uppercase` → `GETDATE`, `COUNT`

### Style Loader

`snippetProvider.ts` ile aynı pattern:

```typescript
interface SqlStyle {
  metadata: { id: string; name: string };
  casing: {
    reservedKeywords: 'uppercase' | 'lowercase' | 'upperCamelCase' | 'leaveAsIs';
    builtInFunctions: 'uppercase' | 'lowercase' | 'upperCamelCase' | 'leaveAsIs';
    builtInDataTypes: 'uppercase' | 'lowercase' | 'upperCamelCase' | 'leaveAsIs';
    useObjectDefinitionCase?: boolean;
  };
  // Faz 2+ alanları opsiyonel, kademeli eklenir
}
```

- `tsql-intellisense.styleFolder` ayarından dizin okunur
- Dizindeki ilk `.json` dosyası yüklenir
- Ayar boşsa → embedded RENIUMSTYLE varsayılan kullanılır

### VS Code Entegrasyonu

**Yeni setting:**
```json
"tsql-intellisense.styleFolder": {
  "type": "string",
  "default": "",
  "description": "Path to folder containing Redgate SQL Prompt style files (.json)"
}
```

**Yeni komut:**
```json
{
  "command": "tsql-intellisense.formatSql",
  "title": "T-SQL IntelliSense: Format SQL"
},
{
  "command": "tsql-intellisense.setStyleFolder",
  "title": "T-SQL IntelliSense: Set Style Folder"
}
```

**Keybinding:**
```json
{
  "command": "tsql-intellisense.formatSql",
  "key": "ctrl+k y",
  "when": "editorLangId == sql && tsqlIntellisense.active"
}
```

**Provider registration (extension.ts):**
```typescript
// DocumentFormattingEditProvider + DocumentRangeFormattingEditProvider
const formatterProvider = new FormatterProvider(styleLoader);
context.subscriptions.push(
  vscode.languages.registerDocumentFormattingEditProvider('sql', formatterProvider),
  vscode.languages.registerDocumentRangeFormattingEditProvider('sql', formatterProvider)
);

// Ctrl+K Y komutu — seçim varsa seçimi, yoksa tüm dosyayı formatlar
context.subscriptions.push(
  vscode.commands.registerCommand('tsql-intellisense.formatSql', () => {
    formatterProvider.formatActiveEditor();
  })
);
```

**Formatlama davranışı:**
- `Ctrl+K Y`: seçim varsa → seçili metin, yoksa → tüm dosya
- `Shift+Alt+F`: tüm dosya (VS Code standard)
- Seçili metin formatlanırken sadece seçilen aralığa TextEdit uygulanır

### Dosya Listesi

| Dosya | Durum | Açıklama |
|-------|-------|----------|
| `src/formatter/sqlTokenizer.ts` | Yeni | SQL tokenizer |
| `src/formatter/casingRule.ts` | Yeni | Casing kuralları |
| `src/formatter/styleLoader.ts` | Yeni | Stil dosya okuyucu |
| `src/formatter/sqlFormatter.ts` | Yeni | Orkestratör |
| `src/providers/formatterProvider.ts` | Yeni | VS Code provider |
| `src/extension.ts` | Düzenleme | Import + komut/provider kaydı |
| `package.json` | Düzenleme | Command, keybinding, setting ekle |

### Test Stratejisi

**Birim testleri (npm test'e eklenir):**
- Tokenizer: string, comment, keyword, identifier, number, operator doğru ayrılıyor mu
- Casing: her mod (uppercase, lowercase, upperCamelCase, leaveAsIs) doğru çalışıyor mu
- String/comment içindeki keyword'lere dokunulmuyor mu
- Bracketed identifier'lara dokunulmuyor mu
- Multi-word keyword'ler doğru dönüşüyor mu

**Manuel test (F5):**
- `select * from Customers where id = 1` → casing uygulanmış
- String içi: `'select from'` → değişmemiş
- Comment içi: `-- select from` → değişmemiş
- `[select]` → değişmemiş (identifier)
- Seçim formatla → sadece seçim değişmiş
- Tüm dosya formatla → tüm dosya değişmiş

### Bilinen Sınırlamalar (Faz 1)

- Sadece casing yapılır, whitespace/indentation değişmez
- Stil dosyasının sadece `casing` bölümü okunur
- `LEFT` kelimesi hem keyword (LEFT JOIN) hem function (LEFT(...)) olabilir — bağlam analizi yapılmaz, function listesi öncelikli (eğer parantez açılıyorsa function, değilse keyword olarak değerlendirilebilir — bu Faz 1'de basit tutulur, sonraki token'a bakılır)
