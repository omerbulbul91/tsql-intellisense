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
│   ├── alterProcProvider.ts         -- Quick Pick ile SP seçme komutu
│   ├── queryRunner.ts              -- WebviewViewProvider, sorgu çalıştırma, sonuç paneli (tabs/stacked)
│   └── renameProvider.ts           -- F2 ile alias rename
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
| `EXEC / EXECUTE` | SP ve fonksiyon önerisi |
| `ALTER PROC` | SP listesi, seçince kodu getir |
| Genel fallback | Sorgu içinde keyword önerisi (ORDER BY, WHERE vs.) |

### Tablo Documentation Popup

- **TABLE**: CREATE TABLE scripti + PK + Indexes + FK + Triggers (⚡ ikonu)
- **VIEW**: Gerçek CREATE VIEW tanımı (DB'den)
- Tıklanabilir linkler: `Copy Script` (panoya kopyala) | `Open Script` (yeni tab'da aç)

### Kolon Bilgileri (Completion Listesinde)

- PK kolonlar: `int not null 🔑`
- FK kolonlar: `int 🔗`
- Normal kolonlar: `varchar(50) null`
- Tip + nullable bilgisi doğrudan completion listesinde görünür

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

- `F5` veya `Ctrl+Shift+Q` ile çalıştır
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

## Bilinen Sınırlamalar

- SQL parser regex tabanlı, karmaşık nested sorgularda hata yapabilir
- mssql eklentisinin şifreleri encrypted saklaması nedeniyle mssql bağlantıları okunamaz (şifre boş gelir)
- Formatlama özelliği henüz yok
