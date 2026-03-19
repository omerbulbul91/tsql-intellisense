# SQL Formatter Faz 2 — Liste/Whitespace Kuralları (SELECT)

## Özet

Faz 1 (casing) üzerine SELECT sorguları için clause-based layout formatlama eklenmesi. Clause padding, virgül pozisyonu ve maxLineLength'e göre satır wrap kuralları.

## Kapsam

- **Sadece SELECT sorguları** — INSERT/UPDATE/DELETE Faz 2 kapsamında değil
- **Clause'lar:** SELECT, FROM, WHERE, ORDER BY, GROUP BY, HAVING
- **Subquery:** Parantez içindeki keyword'ler yok sayılır (depth=0 kuralı — tüm parantez ifadeleri dahil: subquery, fonksiyon çağrıları)
- **CTE:** `WITH cte AS (SELECT ...)` — parantez içindeki SELECT depth>0, dış SELECT formatlanır
- **Batch:** `;` ve `GO` clause state'ini sıfırlar, her SELECT bağımsız formatlanır
- **SELECT DISTINCT / SELECT TOP N:** `DISTINCT` ve `TOP N` SELECT keyword'üne dahildir, padding hesabında keyword genişliğine eklenmez. Kolon listesi bunlardan sonra başlar.
- **SELECT *:** Virgüllü öğe listesi yok — padding uygulanır, wrap gerekmez
- **WHERE / HAVING:** Virgül ayırma yok, tüm içerik tek öğe olarak tutulur (AND/OR bölme Faz 5'te)

## Beklenen Çıktı Örneği

Giriş:
```sql
select k.KullaniciID, k.RolID, k.KullaniciKodu, k.KullaniciAdi, k.Password, k.DilID from dbo.RN100_Kullanicilar k order by k.KullaniciKodu
```

Çıktı (RENIUMSTYLE, maxLineLength=120):
```sql
Select    k.KullaniciID, k.RolID, k.KullaniciKodu, k.KullaniciAdi, k.Password, k.DilID
From      dbo.RN100_Kullanicilar k
Order By  k.KullaniciKodu
```

Çıktı (çok sayıda kolon, wrap gerekli):
```sql
Select    k.KullaniciID, k.RolID, k.KullaniciKodu, k.KullaniciAdi, k.Password, k.DilID, k.ITReportRolID, k.DBUserID
          , k.IsPhantomChk, k.VarsayilanLoomTipID, k.IsDepoDuzeltmeGC, k.RDPPath, k.EskiKullaniciKodu
          , k.HomePageDashboardID
From      dbo.RN100_Kullanicilar k
Order By  k.KullaniciKodu
```

## Layout Kuralları

### 1. Clause Padding (Dinamik)

Sorgudaki tüm clause keyword'ler tespit edilir, en uzun keyword bulunur, tüm keyword'ler bu uzunluğa + 2 boşluk padding ile hizalanır.

| Keyword | Uzunluk | Padding (en uzun: Order By=8) |
|---------|---------|-------------------------------|
| Select | 6 | `Select    ` (10 karakter) |
| From | 4 | `From      ` (10 karakter) |
| Where | 5 | `Where     ` (10 karakter) |
| Order By | 8 | `Order By  ` (10 karakter) |
| Group By | 8 | `Group By  ` (10 karakter) |
| Having | 6 | `Having    ` (10 karakter) |

Padding hesabı: `maxKeywordLength + 2` boşluk. Tüm clause keyword'ler bu genişliğe tamamlanır.

Eğer sorguda sadece SELECT ve FROM varsa:
- En uzun: `Select` (6) → padding = 8
- `Select  `, `From    ` (her ikisi 8 karakter)

### 2. Virgül Pozisyonu

**`placeCommasBeforeItems: true` (RENIUMSTYLE varsayılan):**
- İlk satırda öğeler arası: `, ` (virgül sonra boşluk)
- Devam satırı başı: padding boşluk + `, ` + öğeler
- Devam satırındaki `, ` keyword padding'den 2 karakter önce başlar

Örnek (padding=10):
```
Select    k.Col1, k.Col2, k.Col3
          , k.Col4, k.Col5
```

**`placeCommasBeforeItems: false`:**
- Tüm virgüller öğeden sonra: `k.Col1, k.Col2,`
- Devam satırı: sadece padding boşluk + öğeler

Örnek (padding=10):
```
Select    k.Col1, k.Col2, k.Col3,
          k.Col4, k.Col5
```

### 3. Satır Wrap (maxLineLength)

- İlk satır: `keyword + padding + öğeler` — maxLineLength'e kadar sığdır
- Sığmayan öğeler yeni satıra taşınır
- Her yeni satırda aynı kural: padding + (virgül baştaysa `, `) + öğeler → maxLineLength'e kadar
- Tek bir öğe maxLineLength'i aşarsa → o öğe tek başına satıra yazılır (bölünmez)

### 4. Clause Bölme Algoritması

Token stream üzerinde:
1. Parantez depth sayacı tut (depth=0'da çalış)
2. Depth=0'da clause keyword gördüğünde yeni clause başlat
3. `ORDER BY`, `GROUP BY` → compound keyword: keyword token + (whitespace/comment atla) + `BY` keyword. Araya comment girerse: `ORDER /* x */ BY` → yine compound keyword olarak tespit edilir.
4. Her clause'un öğelerini depth=0 virgüllerle ayır (parantez içi virgüller öğe ayırıcı değil: `ISNULL(a, b)` tek öğe)
5. Her öğe = virgüller arası token grubu (whitespace trim edilir, `AS alias` dahil tek öğe)
6. `SELECT DISTINCT` / `SELECT TOP N` → DISTINCT ve TOP (+ sayı) SELECT öğelerinden ayrılır, keyword prefix olarak tutulur
7. `;` ve `GO` → clause state sıfırlanır, sonraki SELECT bağımsız formatlanır

**Clause keyword listesi (depth=0):** SELECT, FROM, WHERE, ORDER BY, GROUP BY, HAVING

**Clause arası comment'lar:** Clause'lar arasındaki comment tokenları, bir sonraki clause'un önüne yerleştirilir.
**Öğe içi comment'lar:** Öğenin parçası olarak kalır, bölünmez.

### 5. Öğe İçi Whitespace

Her öğe içindeki whitespace normalize edilir:
- Birden fazla boşluk → tek boşluk
- Satır başı/sonu boşluklar trim

Öğe örnekleri:
- `k.KullaniciID` → olduğu gibi
- `dbo.RN100_Kullanicilar k` → olduğu gibi (alias dahil)
- `x = 1` → olduğu gibi (WHERE condition)
- `k.Col1 ASC` → olduğu gibi (ORDER BY direction)

## Mimari

### Yeni Dosya

```
src/formatter/layoutRule.ts  — applyLayout(tokens, options) → string
```

### LayoutOptions Interface

```typescript
interface LayoutOptions {
    maxLineLength: number;            // varsayılan 120, 0 = wrap yok
    placeCommasBeforeItems: boolean;  // virgül başta mı (varsayılan true)
    alignItemsToTabStops: boolean;    // clause padding aktif mi (varsayılan true)
}
```

**`alignItemsToTabStops` davranışı:**
- `true` → clause keyword + dinamik padding (en uzun keyword'e göre hizala)
- `false` → clause keyword + tek boşluk (padding yok, hizalama yok)

**`maxLineLength = 0` davranışı:** Wrap yapılmaz, tüm öğeler tek satırda kalır.

### SqlFormatter Akışı

```typescript
format(sql: string): string {
    const tokens = tokenize(sql);
    const casingOptions = this.styleLoader.getCasingOptions();
    const layoutOptions = this.styleLoader.getLayoutOptions();
    // Casing: token value'larını yerinde değiştirir
    applyCasingInPlace(tokens, casingOptions);
    // Layout: token stream'den formatlanmış string üretir
    return applyLayout(tokens, layoutOptions);
}
```

**`applyCasingInPlace`:** Mevcut `applyCasing`'in token dizisini döndüren versiyonu. Token'ların `.value` alanını yerinde günceller, re-tokenize gerekmez. Mevcut `applyCasing(tokens) → string` geriye uyumluluk için kalır, `applyCasingInPlace` eklenir.

Layout her zaman çağrılır — `alignItemsToTabStops: false` ve `placeCommasBeforeItems: false` olduğunda `applyLayout` token'ları basitçe birleştirip döndürür (mevcut davranış).

### StyleLoader Değişiklikleri

JSON'dan okunan alanlar:
```json
{
    "lists": {
        "placeCommasBeforeItems": true,
        "alignItemsToTabStops": true
    }
}
```

`maxLineLength` → VS Code settings'ten: `tsql-intellisense.maxLineLength` (Redgate stil dosyasında bu alan yok — IDE ayarı)

`getLayoutOptions()` metodu eklenir. Varsayılanlar: `placeCommasBeforeItems: true`, `alignItemsToTabStops: true`, `maxLineLength: 120`.

`applyOverrides` metodu `lists` alanını da kabul eder. `styleOverrides` settings yapısı:
```json
{
    "reservedKeywords": "upperCamelCase",
    "builtInFunctions": "uppercase",
    "builtInDataTypes": "upperCamelCase",
    "lists": {
        "placeCommasBeforeItems": true,
        "alignItemsToTabStops": true
    }
}
```

### Webview Panel (styleFormProvider.ts) Değişiklikleri

Sol menüde **Lists** bölümü aktif olur. İçerik:

- `Max line length:` → number input (varsayılan 120)
- `☑ Place commas before items` → checkbox
- `☑ Align items to tab stops` → checkbox
- Preview: SELECT sorgusu ile canlı önizleme

**Load from file** ile JSON yüklendiğinde `lists` bölümü de okunur ve ekrana yansır.

**Save** ile `styleOverrides` içine `lists` alanı da kaydedilir.

### Package.json Değişiklikleri

Yeni setting:
```json
"tsql-intellisense.maxLineLength": {
    "type": "number",
    "default": 120,
    "description": "SQL formatlama için maksimum satır uzunluğu"
}
```

### Değişecek Dosyalar

| Dosya | Durum | Açıklama |
|-------|-------|----------|
| `src/formatter/layoutRule.ts` | Yeni | Clause bölme + layout |
| `src/formatter/sqlFormatter.ts` | Düzenleme | applyLayout çağrısı |
| `src/formatter/styleLoader.ts` | Düzenleme | getLayoutOptions() |
| `src/providers/styleFormProvider.ts` | Düzenleme | Lists bölümü UI |
| `package.json` | Düzenleme | maxLineLength setting |
| `test/formatter.test.ts` | Düzenleme | Layout testleri |

## Test Stratejisi

### Birim Testleri

```
— Basit SELECT: "select a, b from T" → padding + casing
— Çok kolon wrap: 20 kolon, maxLineLength=80 → birden fazla satır
— Virgül başta: devam satırları ", " ile başlar
— Virgül sonda: placeCommasBeforeItems=false
— ORDER BY / GROUP BY: compound keyword doğru tespit
— Parantez içi subquery: "select a from (select b from T2) x" → iç SELECT'e dokunma
— String içi keyword: "select 'from' from T" → string'deki FROM yok sayılır
— Comment içi keyword: "select a -- from\nfrom T" → comment'taki FROM yok sayılır
— Tek clause: "select a, b" → FROM yok, padding SELECT'e göre
— Boş sonuç: boş string → boş string
— maxLineLength=0 veya çok büyük → wrap yok, tek satır
— WHERE condition: "where x = 1 and y = 2" → tek öğe, bölünmez
— SELECT DISTINCT: "select distinct a, b from T" → DISTINCT prefix, kolon listesi sonra
— SELECT TOP N: "select top 100 a, b from T" → TOP 100 prefix
— SELECT *: "select * from T" → wrap yok, padding uygulanır
— Fonksiyon içi virgül: "select isnull(a, b), c from T" → ISNULL(a, b) tek öğe
— CTE: "with cte as (select a from T1) select b from cte" → dış SELECT formatlanır
— Batch: "select a from T1; select b from T2" → her SELECT bağımsız
— FROM çoklu tablo: "select a from T1, T2 where T1.id = T2.id" → FROM öğeleri virgülle ayrılır
— AS alias: "select col1 as alias1, col2 as alias2 from T" → AS dahil tek öğe
— HAVING: "... having count(*) > 1" → tek öğe, virgül bölme yok
```

### Manuel Test

| # | Giriş | Beklenen |
|---|-------|----------|
| 1 | `select a, b, c from T` | `Select  a, b, c\nFrom    T` |
| 2 | 20 kolon SELECT | Wrap + virgül başta |
| 3 | SELECT + ORDER BY | Dinamik padding (Order By genişliğine göre) |
| 4 | Subquery | İç SELECT'e dokunulmaz |
| 5 | Webview Lists bölümü | maxLineLength, checkbox'lar görünür |
| 6 | Load from file | lists değerleri JSON'dan yüklenir |

## Bilinen Sınırlamalar

- Sadece SELECT sorguları formatlanır (INSERT/UPDATE/DELETE sonraki fazda)
- JOIN clause'ları ayrı formatlanmaz (Faz 3'te)
- Subquery içi format yok (sadece dış SELECT)
- UNION ile birleşik sorgularda her SELECT ayrı formatlanmaz
- WHERE içindeki AND/OR satır bölme yok (Faz 5'te)
