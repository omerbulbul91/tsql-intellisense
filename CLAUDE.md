# CLAUDE.md

## Proje Özeti

tsql-intellisense, Redgate SQL Prompt alternatifi bir VS Code eklentisidir. SQL Server veritabanlarına bağlanarak IntelliSense (tablo/kolon/SP tamamlama), sorgu çalıştırma ve ALTER PROC kod getirme özellikleri sunar.

## Build

```bash
npm run build    # esbuild ile dist/extension.js üretir
npm run watch    # değişikliklerde otomatik build
```

Test komutu yoktur. Doğrulama F5 ile Extension Development Host'ta yapılır.

## Debug / Test

1. VS Code'da bu klasörü aç
2. F5 → Extension Development Host penceresi açılır
3. SQL dosyası aç → IntelliSense ve Run Query test et
4. Bağlantı ayarı: `settings.json` → `tsql-intellisense.connections`

## Mimari

```
src/
├── extension.ts                     -- Giriş noktası, komut kayıtları, query shortcuts
├── connection/
│   └── connectionManager.ts         -- tedious bağlantı, executeQuery, executeBatch (multi result set)
├── cache/
│   └── schemaCache.ts               -- Bellek içi şema cache (tablo, view, SP, fonksiyon, kolon, FK, PK, index, trigger, view definition)
├── parser/
│   └── sqlContext.ts                 -- Regex tabanlı SQL bağlam algılama + extractNonAggColumns
├── providers/
│   ├── completionProvider.ts        -- CompletionItemProvider (tüm tamamlama mantığı)
│   ├── snippetProvider.ts          -- Redgate SQL Prompt snippet yükleyici
│   ├── alterProcProvider.ts         -- Quick Pick ile SP seçme komutu
│   ├── queryRunner.ts              -- WebviewViewProvider, sorgu çalıştırma, sonuç paneli (tabs/stacked)
│   ├── queryHistoryProvider.ts     -- TreeDataProvider, sorgu geçmişi (tarih/dosya gruplu ağaç)
│   └── renameProvider.ts           -- F2 ile alias rename
├── formatter/
│   ├── sqlFormatter.ts              -- Ana formatter pipeline (CREATE OR ALTER, spacing, dbo. prefix)
│   ├── sqlTokenizer.ts              -- SQL tokenizer (keyword/function/datatype/identifier/string/comment)
│   ├── casingRule.ts                -- Keyword/function/datatype casing (uppercase, upperCamelCase, lowercase)
│   ├── layoutRule.ts                -- SELECT clause layout, JOIN formatlama, tablo dbo. prefix
│   ├── statementRule.ts             -- Statement ayırma, BEGIN/END block indentation, DECLARE/EXEC detail
│   ├── caseRule.ts                  -- CASE expression formatlama
│   └── styleLoader.ts              -- Ayar yükleme ve varsayılanlar
├── queries/
│   └── schemaQueries.ts             -- SQL sorgu şablonları (INFORMATION_SCHEMA + sys tabloları)
└── snippets/
    └── sql.json                     -- SQL snippet'leri (loj, ij, rj, cj, st)
```

## Özellikler

### IntelliSense / Tamamlama

| Bağlam | Davranış |
|--------|----------|
| `FROM / JOIN` | Tablo/view önerisi, otomatik alias üretimi. `dbo.` yazıldıysa seçilen tabloya tekrar `dbo.` eklenmez |
| `FROM table alias keyword` | SQL keyword önerisi (WHERE, ORDER BY, JOIN vs.) |
| `alias.` | O tablonun kolonları (PK 🔑, FK 🔗 ikonlu, tip + nullable bilgisiyle) |
| `SELECT` | Alias'lar + kolonlar + SQL fonksiyon snippet'leri + system variable'lar (@@ROWCOUNT, @@SPID, @@SERVERNAME vs.) |
| `SELECT ... *` | `* (expand all columns)` — tüm kolonları alias'lı açar (multi-table: tüm JOIN'li tabloların kolonları dahil). Cursor `*` sağına gelince otomatik tetiklenir, TAB ile expand. Virgülden sonra `*` yazılmadıysa gösterilmez, yazıldıysa gösterilir. FROM yoksa expand gelmez (tablo bilinmiyor). Tablo şemada bulunamazsa `expand unavailable: Table not found in schema` uyarısı gösterilir |
| `JOIN table alias ON` | Join condition önerisi (FK eşleşmeleri üstte, aynı isimli kolonlar altta) |
| `= ` (ON clause içinde) | Alias + tüm alias'ların kolonları |
| `( ` (fonksiyon içi) | Kolon önerisi (SUM(), COUNT() içinde) |
| `ORDER BY col` | ASC / DESC önerisi |
| `GROUP BY` | "All non-aggregated columns" snippet + alias'lar + kolonlar |
| `EXEC / EXECUTE` | Sadece SP önerisi (fonksiyonlar listelenmez — SELECT dbo.FnName() ile kullanılır) |
| `ALTER PROC` | SP listesi, seçince kodu getir |
| Genel fallback | Sorgu içinde keyword önerisi (ORDER BY, WHERE vs.) |

### Documentation Popup

Completion listesinde nesne seçildiğinde sağ panelde detaylı bilgi gösterilir.
Tüm nesne tipleri `resolveCompletionItem` ile **canlı DB'den** çekilir (cache'ten değil).

**Desteklenen nesne tipleri ve kaynak:**
- **TABLE** → `definitionProvider.buildTableScript()` — CREATE TABLE + PK + Index + FK + Check + Trigger
- **VIEW** → `schemaCache.fetchObjectDefinition()` — `OBJECT_DEFINITION()` sorgusu
- **SP (PROCEDURE)** → `schemaCache.fetchObjectDefinition()` — `OBJECT_DEFINITION()` sorgusu
- **FUNCTION** → `schemaCache.fetchObjectDefinition()` — `OBJECT_DEFINITION()` sorgusu
- **TRIGGER** → `schemaCache.fetchObjectDefinition()` — `OBJECT_DEFINITION()` sorgusu

**FROM/JOIN bağlamında TABLE popup ek içerik:**
- `Copy Script` | `Open Script` tıklanabilir linkler
- ⚡ Trigger'lı tablolar özel ikon ile gösterilir

**Önemli kurallar:**
- [2026-03-23] `resolveCompletionItem`'da detail karşılaştırması yaparken `T-SQL • ` prefix'i sıyırılmalı — `provideCompletionItems` tüm detail'lara bu prefix'i ekler
- [2026-03-23] `completionProvider`'dan `definitionProvider.buildTableScript()`'e erişim için `setDefinitionProvider()` ile bağlantı kurulmalı
- Doc popup hiçbir zaman completion'ı bloklamamalı (async await YAPMA)
- Metadata yüklenmediyse "Schema loading..." göster, boş bırakma
- `md.isTrusted = true` ve `md.supportHtml = true` set edilmeli (command linkler için)

### Kolon Bilgileri (Completion Listesinde)

- PK kolonlar: `int not null 🔑`
- FK kolonlar: `int 🔗`
- Normal kolonlar: `varchar(50) null`
- Tip + nullable bilgisi doğrudan completion listesinde görünür

### Go to Definition (F12)

- SP/Function üzerinde F12 → CREATE PROCEDURE/FUNCTION scripti yeni tab'da açılır
- View üzerinde F12 → CREATE VIEW scripti
- Table üzerinde F12 → CREATE TABLE + PK + Index + FK + Check + Default + Trigger scripti (IDENTITY, computed column dahil)
- Tüm nesne tipleri DB'den canlı çekilir (cache'ten değil). F12 sonrası sadece o nesnenin cache'i güncellenir (tablo/view kolonları, view definition) — tüm DB refresh yapılmaz
- **ÖNEMLİ:** `provideDefinition` içinde `showTextDocument` çağrılmamalı — VS Code bu metodu Ctrl+hover'da da çağırır, `showTextDocument` olursa hover'da bile yeni tab açılır. Sadece `Location` döndürülmeli, navigasyonu VS Code halleder

### SP Parametre Completion

- EXEC sonrası SP seçilince parametreleri otomatik doldurur
- OUTPUT parametreler için DECLARE satırları EXEC'in üstüne eklenir
- Her parametre: varsayılan değer + tip yorumu + hizalama
- Format: `@ParamName = 0  -- int`

### Alias Rename (F2)

- Alias üzerine F2 → tüm kullanım yerlerinde rename
- Definition (`FROM table alias`) ve usage (`alias.Column`) sitelerinden çalışır

### SQL Snippet'leri

Built-in snippet'ler (`contributes.snippets`) kaldırılmıştır — tüm snippet'ler `tsql-intellisense.snippetFolder` ayarında belirtilen klasörden yüklenir. `snippets/sql.json` dosyası repoda durur ama `package.json`'da kayıtlı değildir. Çift snippet sorunu önlemek için `contributes.snippets` boş bırakılmalıdır.

### Snippet Klasörü Desteği

- `tsql-intellisense.snippetFolder` ayarına snippet dizin yolu girilir (herhangi bir klasör olabilir)
- Command Palette'den `T-SQL IntelliSense: Set Snippet Folder` ile folder picker açılabilir
- Dizindeki `.json` dosyaları Redgate formatında (`{id, prefix, description, body}`) okunur
- Placeholder dönüşümleri:
  - `$CURSOR$` → VS Code cursor pozisyonu
  - `$PASTE$` → pano içeriği (boşsa tabstop)
  - `$table_name$`, `$column_name$` vb. → VS Code tabstop (Tab ile gezilir)
  - `$SELECTIONSTART$` / `$SELECTIONEND$` → kaldırılır
- Completion listesinde detail alanında `T-SQL IntelliSense` etiketi, doc popup'ta SQL body önizlemesi görünür
- Snippet'ler schema completion'larının altında sıralanır (`sortText: "zz_"`)

### Snippet Manager

- Context menüden (sağ tık → Snippet Manager) veya Command Palette'den açılır
- `SnippetManagerProvider` WebviewPanel olarak editor tab'ında açılır
- "Add Snippet" komutu (seçili metin varsa) `SnippetManagerProvider.openNewWithBody()` ile "Yeni Snippet" dialog'unu açar
- [2026-03-23] Add Snippet açılırken alt panel (`workbench.action.closePanel`) kapatılmalı — dialog alt panelin altında kalmamalı
- [2026-03-23] Snippet CRUD işlemleri StyleFormProvider değil SnippetManagerProvider üzerinden yapılmalı

### Query History

- Sidebar'da `QUERY HISTORY` TreeView paneli — tarih grubu → dosya grubu → entry hiyerarşisi
- Her sorgu çalıştırıldığında `addEntry()` ile kayıt eklenir (globalState'te persist)
- [2026-03-24] FileGroupItem (dosya grubu) label'da `#seqNo` gösterilmez — child entry'lerde zaten var
- [2026-03-24] Tek tık dosya açmaz — tooltip hover'da SQL query ile birlikte gösterilir
- [2026-03-24] Çift tık dosyayı açar (pinned tab)
- [2026-03-24] Tooltip: bağlantı adı, DB, tarih + SQL code block (4000 karakter, syntax highlighted)
- Aynı fileName + sql kombinasyonu tekrar çalışırsa eski kayıt silinip yenisi eklenir (dedup)
- Ayarlar: `queryHistory.enabled`, `queryHistory.maxEntries` (100), `queryHistory.retentionDays` (7), `queryHistory.maxQuerySize` (1MB)

### Query Shortcuts (SSMS Tarzı)

| Kısayol | Varsayılan Sorgu | Açıklama |
|---------|-----------------|----------|
| `Alt+F1` | `EXEC sp_help '@WORD'` | Cursor'daki nesne bilgisi |
| `Ctrl+1` | `EXEC sp_who` | Aktif oturumlar |
| `Ctrl+2` | `EXEC sp_lock` | Kilitler |
| `Ctrl+3` | `SELECT TOP 100 * FROM @WORD` | Tablodan veri çek |
| `Ctrl+F1` | (boş) | Kullanıcı tanımlı |
| `Ctrl+4` - `Ctrl+9` | (boş) | Kullanıcı tanımlı |

- `@WORD` → cursor altındaki kelime ile replace edilir
- Settings'ten özelleştirilebilir: `tsql-intellisense.queryShortcuts`
- Tüm kısayollar (Alt+F1, Ctrl+F1, Ctrl+1..Ctrl+9) package.json'da komut + keybinding olarak kayıtlı olmalı

### Sorgu Çalıştırma

- `F5` ile çalıştır (eklenti aktifken mssql yerine bu eklenti öncelikli)
- Editör toolbar'da Run Query butonu (`$(play)` ikonu) görünür
- GO batch separator desteği
- **Multiple result set desteği** (sp_help gibi SP'ler için)
- İki görüntüleme modu: `tabs` (sekmeler) veya `stacked` (alt alta) — settings'ten ayarlanır
- CSV/JSON export
- Sıralanabilir kolon başlıkları

### Şema Cache

- Bağlantıda: nesne adları yüklenir (INFORMATION_SCHEMA.TABLES + ROUTINES)
- Arka planda: kolonlar, FK'lar, indexler, trigger'lar, view tanımları toplu yüklenir
- Lazy: ilk kullanımda tekil tablo kolonları yüklenir
- 30dk otomatik yenileme

## Bağlam Algılama (SqlContextType)

Regex tabanlı cursor pozisyonu analizi. Türler:
- `AFTER_FROM_JOIN` — tablo/view adı öner
- `AFTER_EXEC` — SP/fonksiyon adı öner
- `AFTER_ALIAS_DOT` — alias'ın tablosunun kolonlarını öner
- `AFTER_ALTER_PROC` — SP listesi göster, seçince kodu getir
- `AFTER_SELECT` — kolon öner (alias prefix ile) + SQL fonksiyon snippet'leri
- `AFTER_TABLE_NAME` — keyword öner (WHERE, ORDER BY, JOIN, GO vs.)
- `AFTER_ORDER_BY_COLUMN` — ASC/DESC öner
- `AFTER_ON` — JOIN condition önerisi (FK + same-name columns + aliases)
- `AFTER_GROUP_BY` — non-agg columns + aliases + kolonlar

## Settings

| Ayar | Varsayılan | Açıklama |
|------|-----------|----------|
| `tsql-intellisense.connections` | `[]` | Kayıtlı bağlantı profilleri |
| `tsql-intellisense.autoRefreshMinutes` | `30` | Şema cache yenileme süresi (0=kapalı) |
| `tsql-intellisense.resultDisplayMode` | `stacked` | Sonuç görüntüleme: `tabs` veya `stacked` |
| `tsql-intellisense.queryShortcuts` | SSMS varsayılanları | Query shortcut tanımları |
| `tsql-intellisense.snippetFolder` | `""` | Redgate SQL Prompt snippet dizin yolu |

## Kodlama Kuralları

- Dil: TypeScript, ES2020 target
- Bundler: esbuild (tek dosya çıktı: dist/extension.js)
- SQL Server bağlantısı: tedious paketi
- VS Code API: CompletionItemProvider, WebviewViewProvider, RenameProvider
- Yeni dosya eklendiğinde `extension.ts`'te import ve komut kaydı unutulmamalı

## Bağımlılıklar

- **tedious** — SQL Server TDS protokolü driver'ı
- **@types/vscode** — VS Code API tipleri
- **esbuild** — bundler

## Test

### Otomatik (programatik)

```bash
npm test    # 199 test (context detection + projectSync/snippet + formatter)
```

### Manuel Checklist (F5 ile Extension Dev Host'ta)

| # | Test | Yaz | Beklenen |
|---|------|-----|----------|
| 1 | FROM tablo önerisi | `FROM asort` | Tablo listesi + doc popup (CREATE TABLE + PK + Index + FK) |
| 2 | VIEW doc popup | FROM sonrası view seç | CREATE VIEW tanımı (DB'den) |
| 3 | Trigger ikonu | Trigger'lı tablo | ⚡ ikonu + trigger scripti doc'ta |
| 4 | Copy/Open Script | Doc popup'ta link tıkla | Panoya kopyala / yeni tab'da aç |
| 5 | Alias.dot kolonlar | `am.` yaz | Kolonlar (PK 🔑, FK 🔗, tip, nullable) |
| 6 | SELECT kolon önerisi | `SELECT ` (FROM'lu sorgu) | Kolonlar + SQL fonksiyon snippet'leri |
| 7 | Fonksiyon içi kolon | `SUM(` | Kolon önerisi |
| 8 | Keyword önerisi | `FROM T k wh` | WHERE, ORDER BY vs. |
| 9 | Fallback keyword | `WHERE k.ID = 1 or` | ORDER BY önerisi |
| 10 | GO yazma | `go` yaz | GO önerisi, sorunsuz yazılır |
| 11 | JOIN ON condition | `LEFT JOIN T2 r ON ` | FK eşleşmeleri + aynı isimli kolonlar |
| 12 | = sonrası alias | `ON r.ID = ` | Alias'lar + tüm kolonlar |
| 13 | ORDER BY ASC/DESC | `ORDER BY k.Name de` | DESC / ASC |
| 14 | GROUP BY | `GROUP BY ` | Non-agg columns + alias'lar |
| 15 | EXEC SP önerisi | `EXEC sp_` | Sadece SP listesi (fonksiyon olmamalı) |
| 16 | F2 alias rename | Alias üzerinde F2 | Tüm kullanımlarda rename |
| 17 | SQL snippet | `loj` + Tab | LEFT OUTER JOIN ... ON |
| 18 | Alt+F1 sp_help | Tablo üzerinde Alt+F1 | sp_help sonucu (stacked/tabs) |
| 19 | Ctrl+3 SELECT | Tablo üzerinde Ctrl+3 | SELECT TOP 100 * FROM tablo |
| 20 | Multi result set | sp_help çalıştır | Ayrı gridler (stacked veya tabs) |
| 21 | F12 SP definition | SP adı üzerinde F12 | CREATE PROCEDURE scripti yeni tab'da |
| 22 | F12 Table definition | Tablo adı üzerinde F12 | CREATE TABLE + PK + FK + Index scripti |
| 23 | F12 View definition | View adı üzerinde F12 | CREATE VIEW scripti |
| 24 | SP param completion | `EXEC spName` seç | Parametreler otomatik doldurulur (DECLARE + format) |
| 25 | Snippet completion | Snippet prefix yaz (ör. `snp_`) | Completion listesinde "T-SQL IntelliSense" etiketiyle görünür |
| 26 | Snippet doc popup | Snippet seç, doc popup'a bak | SQL body önizlemesi (başlık tekrarı olmamalı) |
| 27 | Snippet $PASTE$ | Metin kopyala, $PASTE$ snippet tetikle | Kopyalanan metin yapıştırılır |
| 28 | Snippet folder picker | Command Palette → Set Snippet Folder | Folder picker açılır, dizin seçilir |
| 29 | ALTER TABLE completion | `ALTER TABLE tab` yaz | Tablo listesi gelir, seçince CREATE scripti AÇILMAZ |
| 30 | CREATE OR ALTER sync | `CREATE OR ALTER TRIGGER` çalıştır | Proje dizininde dosya oluşur/güncellenir |
| 31 | F5 öncelik | Eklenti aktifken F5 | Senin runQuery çalışır (mssql değil) |
| 32 | Run Query butonu | SQL dosyasında toolbar'a bak | $(play) butonu görünür |

### Export Schema

- `T-SQL: Export Schema` komutu — Command Palette + Database node context menü
- Tüm DB nesnelerini (Table, View, SP, Function, Trigger) seçilen klasöre `.sql` dosyaları olarak export eder
- Klasör yapısı: `<hedef>/dbo/{Tables,Views,Stored Procedures,Functions,Triggers}/<Name>.sql`
- Cache-first: tüm scriptler `schemaCache`'ten alınır (DB sorgusu yok), ~1sn'de 1700+ nesne
- TABLE scriptleri cache'teki columns/indexes/FK/triggers'tan üretilir
- VIEW/SP/Function/Trigger tanımları `loadObjectDefinitions()` ile toplu cache'lenir, CREATE OR ALTER dönüşümü yapılmaz
- İdempotent write: mevcut dosya ile byte-for-byte karşılaştırma, aynıysa yazmaz (git diff oluşmaz)
- CRLF → LF + trailing whitespace normalize
- Cancel desteği (her nesne öncesi kontrol)
- Tree context menüden geldiğinde `connectionManager` bağlı değilse otomatik bağlanır
- Output Channel'a (`T-SQL Connection`) başlangıç/bitiş zamanı ve sonuç loglanır

### Project Sync (DDL → SQL Project)

- `ALTER`, `CREATE`, `CREATE OR ALTER` sonrası PROC/VIEW/FUNCTION/TRIGGER/TABLE otomatik sync
- Bağlantı profilinde `projectPath` ayarı gerekli
- `ALTER TABLE` seçilince sadece isim tamamlanır, CREATE scripti açılmaz
- `ALTER VIEW/FUNCTION/TRIGGER` seçilince definition açılır

## Rakip Analizi

| Kaynak | Repo | Açıklama |
|--------|------|----------|
| vscode-mssql | https://github.com/Microsoft/vscode-mssql | Microsoft'un resmi SQL Server eklentisi — Object Explorer, query execution, connection yönetimi referans implementasyon |

Yeni özellik eklerken vscode-mssql'in aynı özelliği nasıl çözdüğüne bakılmalı (UX akışı, komut parametreleri, context menu yapısı).

## Bilinen Sınırlamalar

- SQL parser regex tabanlı, karmaşık nested sorgularda hata yapabilir
- mssql eklentisinin şifreleri encrypted saklaması nedeniyle mssql bağlantıları okunamaz (şifre boş gelir)
### SQL Formatter

7 aşamalı pipeline:
1. **Tokenize** — SQL'i keyword/function/datatype/identifier/string/comment token'larına ayırır
2. **Casing** — Keyword (upperCamelCase), Function (UPPERCASE), Datatype (upperCamelCase) casing uygular
3. **CREATE OR ALTER** — `ALTER PROC/VIEW/FUNCTION/TRIGGER` → `CREATE OR ALTER` dönüşümü (zaten varsa tekrarlamaz)
4. **Spacing** — `=` etrafında boşluk, `,` sonrası boşluk ekler
5. **EXEC dbo.** — `Execute SpName` → `Execute dbo.SpName` (qualifyObjectNames ayarı)
6. **Statement Formatting** — Statement ayırma, BEGIN/END block indentation, DECLARE alignment, EXEC wrapping
7. **Layout** — SELECT clause tab-stop hizalama, JOIN formatlama, tablo dbo. prefix, satır kaydırma

#### Formatter Kuralları

| Kural | Açıklama |
|-------|----------|
| CREATE OR ALTER | ALTER PROC/VIEW/FUNCTION/TRIGGER otomatik CREATE OR ALTER'a dönüşür. Zaten CREATE OR ALTER ise tekrar eklemez |
| SP Parametre Girintisi | PROC/PROCEDURE ile AS arasındaki `@Param` satırları 4 space girintilenir |
| Block Comment İçerik | `/* */` içindeki satırlar `/*` delimiter'ına göre +4 space girintilenir |
| Operator Spacing | `=` operatörünün her iki tarafında boşluk (`=FF` → `= FF`, `=3` → `= 3`) |
| Comma Spacing | Virgül sonrası boşluk (`',16,1)` → `', 16, 1)`) |
| EXECUTE dbo. | Niteliksiz SP adlarına dbo. prefix eklenir |
| SELECT Layout | SELECT/FROM/WHERE/ORDER BY/GROUP BY tab-stop hizalama (maxKw + 2) |
| JOIN Formatlama | JOIN condition yeni satırda, tablo başlangıcına hizalı |
| Comma Before | Devam satırlarında virgül başta (`, item`) |
| Block Indentation | BEGIN/END, IF/ELSE/WHILE derinlik takibi (4 space/level) |
| WHERE/FROM Scope | Layout'ta WHERE/FROM sadece SELECT sonrası clause olarak algılanır (UPDATE WHERE'i bozmaz) |

#### Test

```bash
npm test    # 199 test (41 context + 51 projectSync + 78 tokenizer/casing/layout/case/statement + 29 statementRule)
```

`test/spFormat.test.ts` — Gerçek dünya Türkçe SP ile 78 satırlık end-to-end doğrulama

### Loglama (Logging)

Projede merkezi bir logger modülü yoktur — loglama doğrudan VS Code `OutputChannel` API'si ve `console.log/error` ile yapılır.

#### Output Channel'lar

| Kanal Adı | Oluşturulduğu Yer | Kullanım |
|-----------|--------------------|----------|
| `T-SQL Connection` | `connectionManager.ts` (L48) | Bağlantı, sorgu, DB switch, zamanlama (`_ts()` helper) |
| `T-SQL Snippets` | `extension.ts` (L332) | Snippet dosya yükleme logları |
| `T-SQL Formatter` | `extension.ts` (L375) | Style dosyası yükleme, konfigürasyon logları |

#### Loglama Mekanizması

- **ConnectionManager**: `this.log` property'si (`vscode.OutputChannel`), tüm bağlantı/sorgu olaylarını loglar. `_ts()` helper ile timestamp eklenir
- **SchemaCache**: `connectionManager.log` üzerinden loglar (kendi OutputChannel'ı yok — `private get log()` getter ile erişir)
- **SnippetProvider**: Constructor'da `OutputChannel` parametre alır, snippet yükleme loglarını yazar
- **StyleLoader**: Constructor'da opsiyonel `OutputChannel` alır, `private log(msg)` helper method ile loglar
- **Webview (Grid) scriptleri**: `console.log/error` ile `[TSQL]` prefix'li client-side loglama (queryRunner, agGridRenderer, handsontableRenderer, tabulatorRenderer)
- **ProjectSync**: `console.error` ile hata logları (`[ProjectSync]` prefix)

#### Kurallar

- Yeni modül eklerken mevcut OutputChannel'lardan birini kullan veya gerekçeli yeni kanal oluştur
- Hata loglarında `console.error` kullan, bilgi loglarında `OutputChannel.appendLine` tercih et
- Webview (client-side) loglarında `[TSQL]` prefix'i zorunlu — DevTools'ta filtreleme kolaylığı sağlar
- SchemaCache gibi modüller kendi OutputChannel oluşturmak yerine ConnectionManager'ın kanalını paylaşmalı

### Bağlantı Mimarisi (İki Pool)

Projede iki bağımsız bağlantı katmanı vardır:

| Katman | Sınıf | Kullanım |
|--------|-------|----------|
| **connectionManager** | `ConnectionManager` | IntelliSense, query execution, schema cache, export |
| **treeQueryService** | `TreeQueryService` | Object Explorer tree (DB listesi, tablo/kolon gösterimi) |

- Tree'de connection node expand edildiğinde `connectionTreeProvider.ensureConnection()` → `treeQueryService.connect()` çağrılır — bu sadece tree pool'unu açar, `connectionManager` bağlanmaz
- `connectionManager` ancak `treeConnect` komutu (sağ tık → Connect) veya IntelliSense/query çalıştırıldığında bağlanır
- [2026-03-28] Tree context menüsünden çağrılan komutlar (Export Schema vb.) `connectionManager` bağlı değilse otomatik bağlanmalı — `node.profileName` ile profile bulunup `connectionManager.connect()` çağrılmalı
- Tree'de bağlantı durumu `contextValue` ile gösterilir: `ConnectionConnected` (yeşil ikon) / `ConnectionDisconnected` (kırmızı ikon). `treeConnect` komutu başarılı olduğunda `contextValue` güncellenir ve ikon yeşile döner

### Cancel (İptal) Mantığı

Bağlantı ve sorgu çalıştırma işlemlerinde kullanıcı iptal desteği vardır.

#### Bağlantı İptali

- `_connectInternal()` → `vscode.window.withProgress({ cancellable: true })` ile Cancel butonu gösterir
- İptal edildiğinde `cancelled = true` flag set edilir, `pool.close()` çağrılır
- İptal sonrası `pool = null`, `activeProfile = null` reset edilir ve loglanır
- `cancelConnect()` metodu dışarıdan çağrılabilir (henüz bağlanmamışsa pool'u kapatır)
- İptal hem başarılı bağlantı sonrası hem catch bloğunda kontrol edilmeli — race condition önlenir

#### Eşzamanlı Bağlantı Koruması

- `connect()` metodu `_connectPromise` ile deduplicate eder — aynı profile'e ikinci çağrı gelirse mevcut promise reuse edilir
- Farklı profil geldiğinde yeni `_connectInternal` başlar, `this.pool` varsa önce `disconnect()` çağrılır
- [2026-03-24] İlk bağlantı henüz tamamlanmamışken (pool=null) farklı profil ile ikinci çağrı gelirse iki paralel bağlantı girişimi oluşabilir — `_connectPromise` kontrolü sadece aynı profil için çalışır

#### Sorgu İptali

- `cancelQuery()` → `this._activeRequest.cancel()` ile TDS protokolünde ATTENTION paketi gönderir (mssql/tedious)
- `_activeRequest` her `executeSingleBatch()` başında set edilir, sorgu bitince `null` yapılır
- `isQueryRunning` getter ile aktif sorgu durumu kontrol edilebilir

#### QueryRunner Tarafı

- F5 (`runQuery`) ve shortcut (`runQueryText`) her ikisi de `withProgress({ cancellable: true })` kullanır
- Cancel butonuna basıldığında `connectionManager.cancelQuery()` çağrılır
- F5'te bağlantı kopmuşsa otomatik reconnect + retry yapılır — retry sırasında da cancel çalışır

#### Kurallar

- Yeni uzun süren işlem eklerken mutlaka `withProgress({ cancellable: true })` kullan
- Cancel sonrası state temizliği yapılmalı (`pool = null`, `_activeRequest = null` vb.)
- Cancel loglanmalı — Output Channel'a timestamp ile yazılmalı
- `_activeRequest` yalnızca `executeSingleBatch` içinde set edilmeli, başka yerden doğrudan atama yapılmamalı

## Çalışma Kuralları

- Test sırasında bulunan hata veya eksik özellikler, sormadan CLAUDE.md'ye kural olarak eklenir
- Ship sonrası `vsce package && vsce publish` çalıştır (marketplace'e otomatik yayınla)
- [2026-03-28] VS Code user settings (`%APPDATA%/Code/User/settings.json`) düzenlerken ASLA Write ile tüm dosyayı yazma — Read ile oku, Edit ile sadece ilgili bloğu değiştir. Aksi halde snippet klasörü, query shortcuts, style ayarları gibi diğer ayarlar kaybolur

### Test Sonrası Otomatik Eylemler

**Test BAŞARISIZ olduğunda:**
- Hatanın kök nedenini tespit et
- Düzeltmeyi uygula ve testi tekrar çalıştır
- Hatanın tekrarını önleyecek kuralı CLAUDE.md'ye ekle (format: `[TARİH] [MODÜL] kural açıklaması`)
- Eğer hata bir edge case ise, ilgili fonksiyona guard clause ekle

**Test BAŞARILI olduğunda:**
- Test kapsamını (coverage) kontrol et — eksik branch veya edge case varsa yeni test ekle
- Testin dokunduğu modüllerde TODO veya FIXME varsa raporla
- Performans regresyonu olup olmadığını değerlendir (önceki çalışma süresine kıyasla)

### CLAUDE.md Güncelleme Kuralları
- Her eklenen kural tek satırda, aksiyon odaklı olmalı (örn: "DataGrid'e 10K+ satır yüklerken mutlaka virtualScroll: true kullan")
- Aynı kural zaten varsa tekrar ekleme
- Kurallar modül bazlı gruplandırılmalı

### Rename Provider
- [2026-03-23] F2 alias rename yaparken FROM/JOIN'deki tablo adı pozisyonları hariç tutulmalı — alias = tablo adı olduğunda tablo adını değiştirmemeli

### Extension Page (About Extension)
- [2026-03-23] "About Extension" komutu `extension.open` değil `workbench.extensions.search` ile `@id:omerbulbul.tsql-intellisense` filtresi kullanmalı — Extensions sidebar'daki zengin sağ tık menüsüne (Install Specific Version, Download VSIX vs.) erişim sağlar
