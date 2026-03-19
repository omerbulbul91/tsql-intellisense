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
| `FROM / JOIN` | Tablo/view önerisi, otomatik alias üretimi |
| `FROM table alias keyword` | SQL keyword önerisi (WHERE, ORDER BY, JOIN vs.) |
| `alias.` | O tablonun kolonları (PK 🔑, FK 🔗 ikonlu, tip + nullable bilgisiyle) |
| `SELECT` | Kolon önerisi + SQL fonksiyon snippet'leri (COUNT, SUM, ROW_NUMBER, CAST, ISNULL vs.) |
| `SELECT ... *` | `* (expand all columns)` — tüm kolonları alias'lı açar |
| `JOIN table alias ON` | Join condition önerisi (FK eşleşmeleri üstte, aynı isimli kolonlar altta) |
| `= ` (ON clause içinde) | Alias + tüm alias'ların kolonları |
| `( ` (fonksiyon içi) | Kolon önerisi (SUM(), COUNT() içinde) |
| `ORDER BY col` | ASC / DESC önerisi |
| `GROUP BY` | "All non-aggregated columns" snippet + alias'lar + kolonlar |
| `EXEC / EXECUTE` | Sadece SP önerisi (fonksiyonlar listelenmez — SELECT dbo.FnName() ile kullanılır) |
| `ALTER PROC` | SP listesi, seçince kodu getir |
| Genel fallback | Sorgu içinde keyword önerisi (ORDER BY, WHERE vs.) |

### Tablo/View Documentation Popup

Completion listesinde tablo/view seçildiğinde sağ panelde detaylı bilgi gösterilir.
Metadata arka planda yüklenir — yüklenene kadar "Schema loading..." görünür.

**TABLE popup içeriği (tamamı gösterilmeli):**
- `Copy Script` | `Open Script` tıklanabilir linkler
- CREATE TABLE scripti (tüm kolonlar, tip, nullable)
- PRIMARY KEY constraint
- UNIQUE / NONCLUSTERED / CLUSTERED INDEX'ler
- FOREIGN KEY constraint'ler (hangi tabloya referans verdiği)
- CHECK constraint'ler (varsa)
- DEFAULT constraint'ler (varsa)
- ⚡ Trigger'lar (CREATE TRIGGER scriptiyle)

**VIEW popup içeriği:**
- `Copy Script` | `Open Script` tıklanabilir linkler
- Gerçek CREATE VIEW tanımı (DB'den `OBJECT_DEFINITION` ile çekilir)
- Kolon listesi yedek olarak (view tanımı henüz yüklenmediyse)

**Önemli kurallar:**
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
- Table üzerinde F12 → CREATE TABLE + PK + Index + FK + Trigger scripti
- `OBJECT_DEFINITION` ile DB'den çekilir (SP/Function/View), Table için cache'ten üretilir

### SP Parametre Completion

- EXEC sonrası SP seçilince parametreleri otomatik doldurur
- OUTPUT parametreler için DECLARE satırları EXEC'in üstüne eklenir
- Her parametre: varsayılan değer + tip yorumu + hizalama
- Format: `@ParamName = 0  -- int`

### Alias Rename (F2)

- Alias üzerine F2 → tüm kullanım yerlerinde rename
- Definition (`FROM table alias`) ve usage (`alias.Column`) sitelerinden çalışır

### SQL Snippet'leri

| Kısayol | Sonuç |
|---------|-------|
| `loj` | LEFT OUTER JOIN ... ON |
| `lj` | LEFT JOIN ... ON |
| `ij` | INNER JOIN ... ON |
| `rj` | RIGHT JOIN ... ON |
| `cj` | CROSS JOIN ... |
| `st` | SELECT TOP 100 * FROM ... |

### Redgate SQL Prompt Snippet Desteği

- `tsql-intellisense.snippetFolder` ayarına Redgate snippet dizin yolu girilir
- Command Palette'den `T-SQL IntelliSense: Set Snippet Folder` ile folder picker açılabilir
- Dizindeki `.json` dosyaları Redgate formatında (`{id, prefix, description, body}`) okunur
- Placeholder dönüşümleri:
  - `$CURSOR$` → VS Code cursor pozisyonu
  - `$PASTE$` → pano içeriği (boşsa tabstop)
  - `$table_name$`, `$column_name$` vb. → VS Code tabstop (Tab ile gezilir)
  - `$SELECTIONSTART$` / `$SELECTIONEND$` → kaldırılır
- Completion listesinde detail alanında `SQL Prompt` etiketi, doc popup'ta body önizlemesi görünür
- Snippet'ler schema completion'larının altında sıralanır (`sortText: "zz_"`)

### Query Shortcuts (SSMS Tarzı)

| Kısayol | Varsayılan Sorgu | Açıklama |
|---------|-----------------|----------|
| `Alt+F1` | `EXEC sp_help '@WORD'` | Cursor'daki nesne bilgisi |
| `Ctrl+1` | `EXEC sp_who` | Aktif oturumlar |
| `Ctrl+2` | `EXEC sp_lock` | Kilitler |
| `Ctrl+3` | `SELECT TOP 100 * FROM @WORD` | Tablodan veri çek |

- `@WORD` → cursor altındaki kelime ile replace edilir
- Settings'ten özelleştirilebilir: `tsql-intellisense.queryShortcuts`

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
| 25 | Redgate snippet | Snippet prefix yaz (ör. `snp_`) | Completion listesinde "SQL Prompt" etiketiyle görünür |
| 26 | Snippet doc popup | Snippet seç, doc popup'a bak | **SQL Prompt Snippet** etiketi + SQL body önizlemesi |
| 27 | Snippet $PASTE$ | Metin kopyala, $PASTE$ snippet tetikle | Kopyalanan metin yapıştırılır |
| 28 | Snippet folder picker | Command Palette → Set Snippet Folder | Folder picker açılır, dizin seçilir |
| 29 | ALTER TABLE completion | `ALTER TABLE tab` yaz | Tablo listesi gelir, seçince CREATE scripti AÇILMAZ |
| 30 | CREATE OR ALTER sync | `CREATE OR ALTER TRIGGER` çalıştır | Proje dizininde dosya oluşur/güncellenir |
| 31 | F5 öncelik | Eklenti aktifken F5 | Senin runQuery çalışır (mssql değil) |
| 32 | Run Query butonu | SQL dosyasında toolbar'a bak | $(play) butonu görünür |

### Project Sync (DDL → SQL Project)

- `ALTER`, `CREATE`, `CREATE OR ALTER` sonrası PROC/VIEW/FUNCTION/TRIGGER/TABLE otomatik sync
- Bağlantı profilinde `projectPath` ayarı gerekli
- `ALTER TABLE` seçilince sadece isim tamamlanır, CREATE scripti açılmaz
- `ALTER VIEW/FUNCTION/TRIGGER` seçilince definition açılır

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
