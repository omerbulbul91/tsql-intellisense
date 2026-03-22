# Snippet Manager UI — Design Spec

**Date:** 2026-03-22
**Project:** tsql-intellisense (VS Code Extension)

## Overview

Snippet'leri yönetmek için VS Code editör alanında açılan bir webview tab. Arama, oluşturma, düzenleme, silme ve SQL kodu önizleme işlevlerini tek bir sayfada sunar. Mevcut `SnippetProvider` (completion provider) ile aynı dosya tabanlı altyapıyı paylaşır.

## Motivation

Şu anda snippet'ler dosya sistemi üzerinden manuel olarak yönetiliyor — JSON dosyaları oluşturma/düzenleme/silme doğrudan klasörde yapılıyor. Bu kullanıcı deneyimi zayıf ve hata yapmaya açık. Snippet Manager UI, Redgate SQL Prompt Options sayfasındaki snippet yönetim deneyimine benzer bir arayüz sunarak snippet CRUD işlemlerini kolaylaştıracak.

## Architecture

### Approach: Tek Webview Tab

Tüm snippet yönetim işlevleri tek bir webview tab içinde gerçekleşir. VS Code `WebviewPanel` API'si kullanılır.

### Components

#### 1. SnippetManagerProvider (yeni dosya)

**Dosya:** `src/providers/snippetManagerProvider.ts`

Sorumluluklar:
- WebviewPanel oluşturma ve yaşam döngüsü yönetimi
- Webview ↔ Extension arası `postMessage` iletişimi
- Snippet CRUD işlemlerini dosya sistemine yansıtma
- Snippet listesini yükleme ve webview'e gönderme
- İşlem sonrası `SnippetProvider.loadSnippets()` tetikleme (completion cache güncelleme)

#### 2. Webview HTML/JS (inline)

Tek sayfa, aşağıdaki bölümlerden oluşur:

### Page Layout

```
┌─────────────────────────────────────────────────────────┐
│  Snippet'ler (başlık)                                   │
├─────────────────────────────────────────────────────────┤
│  Snippet klasörü: [path input]                    [...]│
├─────────────────────────────────────────────────────────┤
│  [New...] [Edit...] [Delete]              [Search... 🔍]│
├──────────────────────────┬──────────────────────────────┤
│  SNIPPET    │ AÇIKLAMA   │  CODE                    [📋]│
├──────────────────────────┼──────────────────────────────┤
│  ► AP       │            │  ALTER TABLE tableName ...   │
│    ARAAAAAA │            │                              │
│    CS       │            │                              │
│    Chk_Tri..│            │                              │
│    ...      │            │                              │
├──────────────────────────┤                              │
│  243 snippets            │                              │
└──────────────────────────┴──────────────────────────────┘
```

#### Header Section
- **Başlık:** "Snippet'ler" (15px, bold)
- **Klasör yolu:** Text input (readonly, mevcut snippet folder path) + `...` butonu (folder picker açar)
- **Buton satırı:** Solda `New...`, `Edit...`, `Delete` butonları — Sağda arama kutusu (🔍 ikonu ile)

#### Left Panel — Snippet List (45% genişlik)
- **Tablo başlığı:** `SNIPPET | AÇIKLAMA` (uppercase, 11px, gri, 34px yükseklik)
- **Satırlar:** Her snippet bir satır. Seçili satır mavi arka plan (`#094771`)
- **Alt bilgi:** Toplam snippet sayısı (ör. "243 snippets")
- **Tıklama:** Satır tıklandığında sağ panelde kodu göster
- **Çift tıklama:** Edit modal'ı aç

#### Right Panel — Code Preview (55% genişlik)
- **Başlık:** `CODE` (sol panelle aynı stil — uppercase, 11px, gri, 34px yükseklik)
- **Kopyala butonu:** Başlık satırında sağda, clipboard SVG ikon buton (28x28px)
- **Editör:** Monaco Editor, readonly mode, SQL language, VS Code dark tema
- **İçerik:** Seçili snippet'in body'sini gösterir (`\n` → gerçek satır sonu dönüşümü ile)

#### Modal Dialog — New/Edit
Sayfa üzerinde overlay modal:
- **Başlık:** "Yeni Snippet" veya "Snippet Düzenle"
- **Alanlar:**
  - `Prefix` — text input (zorunlu)
  - `Description` — text input (opsiyonel)
  - `Body` — Monaco Editor (editable, SQL language, minimum 200px yükseklik)
- **Butonlar:** `Kaydet` (primary) + `İptal`
- **Arka plan:** Yarı saydam karartma overlay

### Search

- **Kapsam:** Snippet prefix, description ve body üzerinde full-text arama
- **Davranış:** Anlık filtreleme (keyup'ta), case-insensitive
- **Sonuç:** Liste filtrelenir, toplam sayı güncellenir (ör. "12 / 243 snippets")

### Data Flow

```
User Action → Webview postMessage → SnippetManagerProvider
    ↓
File System (JSON read/write/delete)
    ↓
SnippetProvider.loadSnippets() (completion cache refresh)
    ↓
Webview postMessage ← Updated snippet list
```

### Message Protocol (Webview ↔ Extension)

**Webview → Extension:**
| Message | Payload | Açıklama |
|---------|---------|----------|
| `loadSnippets` | — | Snippet listesini yükle |
| `createSnippet` | `{prefix, description, body}` | Yeni snippet oluştur |
| `updateSnippet` | `{originalPrefix, prefix, description, body}` | Snippet güncelle |
| `deleteSnippet` | `{prefix}` | Snippet sil (onay sonrası) |
| `openFolderPicker` | — | Klasör seçici aç |

**Extension → Webview:**
| Message | Payload | Açıklama |
|---------|---------|----------|
| `snippetsLoaded` | `{snippets: RedgateSnippet[], folder: string}` | Snippet listesi |
| `snippetSaved` | `{success, error?}` | Kaydetme sonucu |
| `snippetDeleted` | `{success, error?}` | Silme sonucu |
| `folderChanged` | `{folder}` | Yeni klasör yolu |

### Prefix Validation

Prefix dosya adı olarak kullanıldığından aşağıdaki kurallar uygulanır:
- **Yasaklı karakterler:** `/`, `\`, `:`, `?`, `"`, `<`, `>`, `|`, `*` ve `..` — modal'da kaydetmeden önce doğrulama yapılır
- **Windows reserved adlar:** `CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9` yasaklı
- **Boş prefix:** kabul edilmez
- **Dosya adı:** Prefix doğrudan dosya adı olarak kullanılır (`${prefix}.json`)

### Duplicate Prefix Handling

- **Create:** Kaydetmeden önce `${prefix}.json` dosyasının varlığı kontrol edilir. Varsa hata mesajı gösterilir: "Bu prefix zaten mevcut."
- **Update:** Prefix değiştirilirse yeni prefix'in mevcut bir dosyayla çakışıp çakışmadığı kontrol edilir.

### File Operations

- **Create:** `fs.writeFile(path.join(folder, `${prefix}.json`), JSON.stringify(snippet, null, 2))` — duplicate check sonrası
- **Update:** Eski dosyayı sil + yeni dosya yaz (prefix değişebilir → dosya adı değişir) — yeni prefix duplicate check sonrası
- **Delete:** `fs.unlink(path.join(folder, `${prefix}.json`))` — silmeden önce VS Code confirmation dialog: "'{prefix}' snippet'ini silmek istediğinize emin misiniz?"
- **Read:** `SnippetProvider.getSnippets()` public metodu ile (aşağıya bkz.)

### SnippetProvider Refactoring

`SnippetProvider`'a aşağıdaki public metotlar eklenir (snippet okuma mantığı tekrarını önlemek için):

```typescript
// Raw snippet listesini döndürür (UI için)
public getSnippets(): RedgateSnippet[] { ... }

// Snippet klasör yolunu döndürür
public getSnippetFolder(): string { ... }
```

`RedgateSnippet` interface'i `snippetProvider.ts`'den export edilir.

### Empty State Handling

- **Klasör ayarlanmamış:** "Snippet klasörü ayarlanmamış. [...] butonuna tıklayarak bir klasör seçin."
- **Klasör boş:** "Bu klasörde snippet bulunamadı. New butonuna tıklayarak yeni snippet oluşturun."
- **Klasör erişilemez:** "Snippet klasörüne erişilemiyor: {path}. Klasör yolunu kontrol edin."

### Monaco Editor Integration

Webview içinde Monaco Editor kullanımı:
- Monaco Editor extension bundle'a dahil edilir (`node_modules/monaco-editor/min`) — CSP uyumluluğu ve offline çalışma için CDN yerine bundled tercih edilir
- İki instance: biri preview (readonly), biri modal (editable)
- Dil: `sql`
- Tema: `vs-dark`

### Webview State

- `retainContextWhenHidden: true` — kullanıcı başka sekmeye geçip geri döndüğünde state korunur
- Modal açıkken sekme değiştirilirse, geri dönüldüğünde modal hâlâ açık kalır

### Clipboard

- Kopyala butonu webview tarafında `navigator.clipboard.writeText()` ile çalışır — extension'a mesaj göndermeye gerek yok

### Error Display

- CRUD hataları (dosya yazma izni, disk dolu vb.) modal içinde inline hata mesajı olarak gösterilir
- Hata metni kırmızı renkte, ilgili alanın altında

### Keyboard Shortcuts

- Modal içinde `Escape` → modal'ı kapat
- Modal içinde `Ctrl+S` → kaydet

### Sort Order

- Snippet listesi prefix'e göre alfabetik sıralı (case-insensitive)

### Registration (extension.ts)

```typescript
// Snippet Manager command
context.subscriptions.push(
    vscode.commands.registerCommand('tsql-intellisense.openSnippetManager', () => {
        SnippetManagerProvider.createOrShow(context.extensionUri, snippetProvider);
    })
);
```

Command palette ve/veya context menu'den erişilebilir:
```json
{
    "command": "tsql-intellisense.openSnippetManager",
    "title": "Snippet Manager",
    "category": "T-SQL"
}
```

## Out of Scope

- Snippet import/export
- Snippet kategorileri veya etiketleme
- Snippet paylaşımı
- Drag & drop sıralama
- Snippet şablonları

## Dependencies

- `monaco-editor` (bundled)
- Mevcut `SnippetProvider` (completion cache refresh + raw snippet data için)
- VS Code `WebviewPanel` API
- Node.js `fs` modülü (dosya CRUD)
