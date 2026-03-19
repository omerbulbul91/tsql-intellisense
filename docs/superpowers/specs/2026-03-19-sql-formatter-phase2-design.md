# SQL Formatter Faz 2 — Liste/Whitespace Kuralları (SELECT)

## Özet

Faz 1 (casing) üzerine SELECT sorguları için clause-based layout formatlama eklenmesi. Clause padding, virgül pozisyonu ve maxLineLength'e göre satır wrap kuralları.

## Kapsam

- **Sadece SELECT sorguları** — INSERT/UPDATE/DELETE Faz 2 kapsamında değil
- **Clause'lar:** SELECT, FROM, WHERE, ORDER BY, GROUP BY, HAVING
- **Subquery:** Parantez içindeki subquery keyword'leri yok sayılır (depth=0 kuralı)

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
3. `ORDER BY`, `GROUP BY` → iki token'lık compound keyword (keyword + whitespace + keyword)
4. Her clause'un öğelerini virgüllerle ayır
5. Her öğe = virgüller arası token grubu (whitespace trim edilir)

**Clause keyword listesi (depth=0):** SELECT, FROM, WHERE, ORDER BY, GROUP BY, HAVING

**Clause dışı tokenlar:** `;`, `GO`, comment'lar — olduğu gibi bırakılır.

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
    enabled: boolean;                 // layout aktif mi
    maxLineLength: number;            // varsayılan 120
    placeCommasBeforeItems: boolean;  // virgül başta mı (varsayılan true)
    alignItemsToTabStops: boolean;    // clause padding (varsayılan true)
}
```

### SqlFormatter Akışı

```typescript
format(sql: string): string {
    const tokens = tokenize(sql);
    const casingOptions = this.styleLoader.getCasingOptions();
    const layoutOptions = this.styleLoader.getLayoutOptions();
    const cased = applyCasing(tokens, casingOptions);
    if (layoutOptions.enabled) {
        const casedTokens = tokenize(cased);
        return applyLayout(casedTokens, layoutOptions);
    }
    return cased;
}
```

Re-tokenize gerekli çünkü casing token value'larını değiştirir, layout ise token pozisyonlarına ihtiyaç duyar.

### StyleLoader Değişiklikleri

JSON'dan okunan alanlar:
```json
{
    "lists": {
        "placeCommasBeforeItems": true,
        "alignItemsToTabStops": true,
        "placeSubsequentItemsOnNewLines": "never"
    }
}
```

`maxLineLength` → VS Code settings'ten: `tsql-intellisense.maxLineLength`

`getLayoutOptions()` metodu eklenir. Layout, `alignItemsToTabStops: true` veya `placeCommasBeforeItems` değiştirilmişse `enabled: true` olur.

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
— WHERE condition: "where x = 1 and y = 2" → clause olarak formatlanır
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
