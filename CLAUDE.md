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
├── extension.ts                     -- Giriş noktası, komut kayıtları
├── connection/
│   └── connectionManager.ts         -- tedious bağlantı, executeQuery, executeBatch
├── cache/
│   └── schemaCache.ts               -- Bellek içi şema cache (tablo, view, SP, fonksiyon, kolon)
├── parser/
│   └── sqlContext.ts                 -- Regex tabanlı SQL bağlam algılama
├── providers/
│   ├── completionProvider.ts        -- CompletionItemProvider (tüm tamamlama mantığı)
│   ├── alterProcProvider.ts         -- Quick Pick ile SP seçme komutu
│   └── queryRunner.ts              -- WebviewViewProvider, sorgu çalıştırma, sonuç paneli
└── queries/
    └── schemaQueries.ts             -- INFORMATION_SCHEMA SQL sorgu şablonları
```

## Temel Kavramlar

### Bağlam Algılama (SqlContextType)

Regex tabanlı cursor pozisyonu analizi. Türler:
- `AFTER_FROM_JOIN` — tablo/view adı öner
- `AFTER_EXEC` — SP/fonksiyon adı öner
- `AFTER_ALIAS_DOT` — alias'ın tablosunun kolonlarını öner
- `AFTER_ALTER_PROC` — SP listesi göster, seçince kodu getir
- `AFTER_SELECT` — kolon öner (alias prefix ile)
- `AFTER_TABLE_NAME` — keyword öner (WHERE, ORDER BY, JOIN vs.)

### Şema Cache

- Bağlantıda: nesne adları yüklenir (INFORMATION_SCHEMA.TABLES + ROUTINES)
- Arka planda: tüm kolonlar toplu yüklenir (INFORMATION_SCHEMA.COLUMNS)
- Lazy: ilk kullanımda tekil tablo kolonları yüklenir
- 30dk otomatik yenileme

### Sorgu Çalıştırma

- `WebviewViewProvider` ile alt panelde (QUERY RESULTS tab'ı)
- GO batch separator desteği
- CSV/JSON export
- Sıralanabilir kolon başlıkları

## Kodlama Kuralları

- Dil: TypeScript, ES2020 target
- Bundler: esbuild (tek dosya çıktı: dist/extension.js)
- SQL Server bağlantısı: tedious paketi
- VS Code API: CompletionItemProvider, WebviewViewProvider
- Yeni dosya eklendiğinde `extension.ts`'te import ve komut kaydı unutulmamalı

## Bağımlılıklar

- **tedious** — SQL Server TDS protokolü driver'ı
- **@types/vscode** — VS Code API tipleri
- **esbuild** — bundler

## Bilinen Sınırlamalar

- SQL parser regex tabanlı, karmaşık nested sorgularda hata yapabilir
- mssql eklentisinin şifreleri encrypted saklaması nedeniyle mssql bağlantıları okunamaz (şifre boş gelir)
- Formatlama özelliği henüz yok
