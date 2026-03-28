# Export Schema Design

**Issue:** #3 — Export Schema
**Date:** 2026-03-28

## Summary

Aktif DB bağlantısındaki tüm nesneleri (Tables, Views, SPs, Functions, Triggers) seçilen klasöre SQL dosyaları olarak export eder.

## Access

- **DB tree context menu** (Database node sağ tık) — bağlantı zaten mevcut, kontrol gerekmez
- **Command Palette** (`T-SQL: Export Schema`) — bağlantı yoksa uyarı verir

## Flow

1. Folder picker açılır (varsayılan: profile'daki `projectPath`)
2. Schema yüklü değilse otomatik yüklenir. Yüklenemezse hata mesajı, dur
3. `withProgress({ cancellable: true })` ile tüm nesneler export edilir
4. Sonuç bildirimi: "X yazıldı, Y atlandı, Z hata"

## Folder Structure

```
<target>/dbo/
  Tables/              <- buildTableScript() (async, DB'den canlı)
  Views/               <- OBJECT_DEFINITION() orijinal format
  Stored Procedures/   <- OBJECT_DEFINITION() orijinal format
  Functions/           <- OBJECT_DEFINITION() orijinal format
  Triggers/            <- OBJECT_DEFINITION() orijinal format
```

## Script Generation

| Object Type | Source | Notes |
|-------------|--------|-------|
| TABLE | `definitionProvider.buildTableScript()` | CREATE TABLE + PK + Index + FK + Check + Trigger |
| VIEW | `OBJECT_DEFINITION()` | Orijinal format korunur |
| PROCEDURE | `OBJECT_DEFINITION()` | CREATE OR ALTER dönüşümü yapılmaz |
| FUNCTION | `OBJECT_DEFINITION()` | CREATE OR ALTER dönüşümü yapılmaz |
| TRIGGER | `OBJECT_DEFINITION()` | CREATE OR ALTER dönüşümü yapılmaz |

## Idempotency

- Dosya yazılmadan önce mevcut dosya okunur
- CRLF → LF normalize edildikten sonra byte-for-byte karşılaştırma yapılır
- İçerik aynıysa dosya yazılmaz — git diff oluşmaz
- Sadece gerçek değişiklik varsa dosya güncellenir

## Files

| File | Change |
|------|--------|
| `src/sync/schemaExporter.ts` | Yeni — SchemaExporter class |
| `src/extension.ts` | Komut kaydı |
| `src/cache/schemaCache.ts` | `getAllObjects()` metodu (yoksa ekle) |
| `package.json` | Komut + context menü |

## Architecture

### `SchemaExporter` class

```typescript
class SchemaExporter {
  constructor(
    connectionManager: ConnectionManager,
    schemaCache: SchemaCache,
    definitionProvider: DefinitionProvider
  )

  async exportAll(
    exportPath: string,
    progress: Progress,
    token: CancellationToken
  ): Promise<{ written: number; skipped: number; errors: number }>
}
```

- `definitionProvider.buildTableScript()` ile tablo scripti (async)
- `OBJECT_DEFINITION()` ile SP/View/Function/Trigger scripti
- Her nesne öncesi `token.isCancellationRequested` kontrolü
- CRLF → LF normalize
- Mevcut dosya ile karşılaştırma (idempotent write)

## Rules

- CREATE OR ALTER dönüşümü yapılmaz (orijinal format korunur)
- Whitespace normalize: CRLF → LF, trailing whitespace trim
- Dosya encoding: UTF-8 (BOM'suz)
