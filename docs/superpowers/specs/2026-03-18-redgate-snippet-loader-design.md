# Redgate SQL Prompt Snippet Yükleyici

## Özet

Kullanıcının yapılandırdığı bir dizinden Redgate SQL Prompt snippet dosyalarını yükleme desteği. Snippet'ler VS Code completion öğeleri olarak sunulur ve kullanıcıların mevcut Redgate snippet kütüphanelerini tsql-intellisense içinde kullanmalarını sağlar.

## Motivasyon

Kullanıcının 245 adet Redgate SQL Prompt snippet'i var. Bunları farklı bir formata dönüştürmek yerine, eklenti Redgate JSON formatını yapılandırılmış bir dizin yolundan doğrudan okuyacak.

## Redgate Snippet Formatı

```json
{
  "id": "UUID-string",
  "prefix": "tetikleyici-kelime",
  "description": "opsiyonel açıklama",
  "body": "\\n satır sonları ve $CURSOR$ / $PASTE$ placeholder'ları içeren SQL şablonu"
}
```

Dizindeki her `.json` dosyası bir snippet içerir.

## Tasarım

### Yeni Dosya: `src/providers/snippetProvider.ts`

**Sınıf:** `SnippetProvider implements CompletionItemProvider`

**Sorumluluklar:**
- `tsql-intellisense.snippetFolder` ayarını oku
- Aktivasyonda dizindeki `*.json` dosyalarını tara
- Her dosyayı Redgate snippet formatı olarak parse et
- `CompletionItem[]`'e dönüştür ve bellekte cache'le
- Kullanıcı yazarken tamamlama önerisi sun (VS Code prefix eşleştirmesi)

**Placeholder dönüşümü:**
- `$CURSOR$` → `$0` (VS Code son cursor pozisyonu)
- `$PASTE$` → pano içeriği varsa yapıştır, yoksa `$1` (tabstop)
- `$PASTE$$CURSOR$` → pano içeriği + `$0`, pano boşsa `$1`
- Body içindeki `\n` → SnippetString'de gerçek satır sonları

**Yeniden yükleme:** `onDidChangeConfiguration` dinlenir, `tsql-intellisense.snippetFolder` değişince snippet'ler yeniden yüklenir.

### Değişiklik: `package.json`

Yeni ayar:
```json
"tsql-intellisense.snippetFolder": {
  "type": "string",
  "default": "",
  "description": "Redgate SQL Prompt snippet JSON dosyalarını içeren dizin yolu"
}
```

### Değişiklik: `extension.ts`

- `SnippetProvider` import ve oluşturma
- `vscode.languages.registerCompletionItemProvider` ile kayıt
- Trigger karakter gerekmez (normal prefix eşleştirmesi yeterli)

### Veri Akışı

```
Aktivasyon
  → snippetFolder ayarını oku
  → dizindeki *.json dosyalarını tara
  → her birini {id, prefix, description, body} olarak parse et
  → placeholder'ları dönüştür, CompletionItem[] oluştur
  → bellekte cache'le

Kullanıcı yazarken
  → VS Code prefix'i filterText/label ile eşleştirir
  → eşleşen snippet'leri tamamlama listesinde gösterir
  → seçilince: $PASTE$ çözümlenir (pano okunur), SnippetString eklenir
```

### CompletionItem Özellikleri

| Özellik | Değer |
|---------|-------|
| label | prefix (ör. "AP", "loj") |
| kind | CompletionItemKind.Snippet |
| detail | `"SQL Prompt"` + varsa description (ör. `"SQL Prompt: açıklama"`) |
| documentation | MarkdownString: üstte **SQL Prompt Snippet** kaynak etiketi, altında body önizlemesi (```sql fence ile syntax highlighting) |
| insertText | dönüştürülmüş body ile SnippetString |
| filterText | prefix |
| sortText | "zz_" prefix (schema completion'larının altında sıralanır) |

### $PASTE$ Çözümleme

Pano okuma (`vscode.env.clipboard.readText()`) async olduğundan `resolveCompletionItem`'da çözümlenir:

1. **Yükleme zamanında:** Body'deki `$PASTE$` yerinde sentinel placeholder `${1:PASTE}` bırakılır
2. **resolveCompletionItem'da:** Pano okunur, sentinel gerçek değerle veya pano boşsa `$1` tabstop ile değiştirilir
3. `$CURSOR$` → `$0` dönüşümü yükleme zamanında yapılır (async gerektirmez)

### Hata Yönetimi

- Geçersiz JSON veya eksik `prefix`/`body` alanı olan dosyalar atlanır, Output Channel'a uyarı yazılır
- `prefix` ve `body` zorunlu; `id` ve `description` opsiyonel
- Dizin mevcut değilse veya erişilemezse bir kez uyarı mesajı gösterilir
- Tanınmayan placeholder'lar (`$SELECTEDTEXT$`, `$DATE$` vb.) literal metin olarak bırakılır

### Yükleme Detayları

- Snippet'ler async yüklenir (`fs.promises.readdir` + `fs.promises.readFile`)
- Dosya isimleri önemsiz, sadece JSON içindeki `prefix` kullanılır
- `documentation` alanı MarkdownString ile SQL syntax highlighting (```sql fence) kullanır
- Document selector: `{ language: 'sql', scheme: '*' }` (mevcut provider ile tutarlı)
- Disposable'lar `context.subscriptions`'a eklenir

### Yeniden Yükleme

- `onDidChangeConfiguration` dinlenir, `snippetFolder` değişince yeniden yüklenir
- File watcher yok (kapsam dışı) — yeni snippet eklenince ayarı değiştirmek veya pencereyi yeniden yüklemek yeterli

## Kapsam Dışı

- Birden fazla snippet dizini desteği
- Snippet düzenleme arayüzü
- Dosya sistemi izleyici (snippet dizini değişiklik izleme)
- `$PASTE$` ve `$CURSOR$` dışındaki Redgate placeholder'ları
- Snippet oluşturma/yönetim komutları
