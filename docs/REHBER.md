# cmon Dashboard Rehberi

Bu rehber <http://localhost:8787> sayfasını nasıl okuyacağını anlatır: perde
arkasında ne olduğunu, her kartın neyi gösterdiğini ve sayıların nereden
geldiğini.

---

## 1. Perde arkası: cmon ne yapıyor?

```
claude  ──istek──▶  cmon proxy (127.0.0.1:8787)  ──aynı istek──▶  api.anthropic.com
        ◀─cevap──                                 ◀────cevap────
                         │
                         └─▶ ~/.cmon/captures/<session>.jsonl   (her istek+cevap bir satır)
                         └─▶ dashboard (SSE ile canlı)
```

- `cmon`, `claude`'u kendi alt süreci olarak başlatır ve yalnızca o sürece
  `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` verir. Böylece o oturumun her API
  isteği önce proxy'ye gelir.
- Proxy isteği **değiştirmeden** Anthropic'e iletir, cevabı Claude Code'a geri
  verir ve ikisinin bir kopyasını diske yazar. `authorization`, `x-api-key`,
  cookie başlıkları kayda hiç girmez.
- Dashboard her yeni kaydı anında alır ve onu on "katman"dan (cache analizi,
  çağrı sınıflandırma, geçmiş farkı vb.) geçirip kartlara döker.

**En önemli zihinsel model:** Claude Code her turda prompt'u baştan kurar ve
*tamamını* yeniden gönderir: araç tanımları + system prompt + tüm mesaj geçmişi.
Model önceki turu "hatırlamaz", her şey her seferinde yeniden okunur. Bunu ucuz
yapan tek şey **prompt cache**'tir. Dashboard'daki kartların çoğu bu tekrar
gönderilen yükün neyden oluştuğunu ve cache'in onu ne kadar iyi taşıdığını
gösterir.

**Örnek: tek bir mesaj, birkaç istek.** "testleri çalıştır" yazdığını düşün.
Proxy'den tipik olarak şöyle bir dizi geçer:

```
#41  agent loop          sen: "testleri çalıştır"  → model: tool_use Bash("npm test")
#42  bash security check  "npm test" güvenli mi?    → küçük, araçsız bir çağrı
#43  agent loop          + tool_result (test çıktısı) → model: "3 test kırık, ..."
```

`#41` ile `#43` neredeyse aynı istektir: aynı araçlar, aynı system prompt, aynı
geçmiş. `#43` sadece sona bir `tool_use` + `tool_result` çifti ekler. Cache
olmasaydı `#43`'te tüm geçmiş tam fiyatla yeniden okunurdu. Cache varken
yalnızca yeni eklenen kuyruk tam fiyattır.

---

## 2. Temel kavramlar

### Turn
Proxy'den geçen **bir HTTP isteği** bir turn'dür. Sohbette tek bir mesaj
yazman, arka planda birden fazla turn'e yol açabilir: model bir araç çağırır,
sonucu alır, tekrar istek atar, araya bir güvenlik kontrolü girer vb.
Turn numaraları (`#12` gibi) oturumdaki tüm isteklerin sırasıdır.

### Dört token sayısı (API'nin gerçek `usage` değerleri)

| Etiket | Ne demek | Fiyat (taban girdi fiyatına göre) |
| --- | --- | --- |
| **input** | Cache'ten gelmeyen, düz ücretlendirilen girdi tokenları. Genelde son cache breakpoint'inden sonraki kısa kuyruk. | 1× |
| **cache write** | Bu turda cache'e *yazılan* tokenlar (`cache_creation_input_tokens`). | 1.25× (5 dk TTL), 2× (1 saat TTL) |
| **cache read** | Önceki turdan cache'te bulunup yeniden kullanılan tokenlar. | 0.1× |
| **output** | Modelin ürettiği tokenlar (thinking dahil). | Çıktı fiyatı |

Dikkat: **input küçük görünür ama bu, prompt'un küçük olduğu anlamına gelmez.**
Modelin okuduğu toplam girdi = `input + cache write + cache read`. Dashboard'daki
"context" (bağlam) sayısı da tam olarak bu üçünün toplamıdır; output dahil
değildir.

**Örnek hesap** (temsili sayılar, Opus liste fiyatıyla: girdi $5, çıktı $25 /
milyon token):

| Kalem | Token | Birim fiyat | Tutar |
| --- | ---: | --- | ---: |
| input | 200 | $5 × 1 | $0.0010 |
| cache write (5 dk) | 3,000 | $5 × 1.25 | $0.0188 |
| cache read | 40,000 | $5 × 0.1 | $0.0200 |
| output | 500 | $25 | $0.0125 |
| **toplam** | | | **≈ $0.052** |

Context = 200 + 3,000 + 40,000 = **43,200** token. Aynı 43,200 token cache'siz
gönderilseydi girdi $0.216, toplam ≈ $0.229 olurdu. Cache kartındaki **saved**
hücresi tam olarak bu farkı (burada ≈ %77) gösterir. Gördüğün gibi 40K tokenlık
geçmiş, 3K tokenlık yazmadan daha ucuza gelir: cache'in bütün olayı budur.

### Cache, prefix ve breakpoint
- API cache'i **önek (prefix)** bazlı çalışır. İstek, cache açısından tek bir
  uzun dizi olarak düşünülür ve sıra hep aynıdır: önce araç tanımları, sonra
  system prompt, sonra mesajlar.
- İstekte `cache_control` ile işaretlenmiş bloklar **breakpoint**'tir. "Baştan
  buraya kadarını cache'le" demektir. Bir istekte en fazla **4** breakpoint
  olabilir.
- Bir sonraki turda önek baştan itibaren **byte byte aynıysa** o kısım cache'ten
  okunur (ucuz). Ortada bir şey değişirse, değişen noktadan sonrası yeniden
  yazılır (pahalı).
- **TTL**: cache girdisinin ömrü (5 dk ya da 1 saat). Bu süre boyunca istek
  gelmezse cache düşer. Her cache okuması süreyi **sıfırlar**, yani aktif bir
  sohbette 5 dk'lık cache sürekli taze kalır.

**İsteğin cache gözüyle hali.** Claude Code'un gönderdiği gövdenin iskeleti
kabaca şöyledir (kısaltılmış, kendi kaydını **Raw JSON**'da görebilirsin):

```jsonc
{
  "model": "claude-opus-5-5",
  "tools": [                                   // ① önekin en başı
    { "name": "Bash",  "description": "...", "input_schema": { ... } },
    { "name": "Read",  "description": "...", "input_schema": { ... } },
    ...
  ],
  "system": [                                  // ②
    { "type": "text", "text": "You are Claude Code, ..." },
    { "type": "text", "text": "...", "cache_control": { "type": "ephemeral" } }   // ◆ breakpoint
  ],
  "messages": [                                // ③ önekin sonu, her turn uzar
    { "role": "user",      "content": [ ... ] },
    { "role": "assistant", "content": [ ... ] },
    ...
    { "role": "user", "content": [
        { "type": "tool_result", "content": "...",
          "cache_control": { "type": "ephemeral" } }                               // ◆ breakpoint
    ] }
  ]
}
```

Cache bunu düz bir dizi olarak görür:

```
[Bash][Read]...[system 0][system 1◆][msg 0][msg 1]...[msg 37◆]
 └──────── araçlar ──────┘└─ system ─┘└──────── mesajlar ───────┘
```

**Turn'den turn'e ne olur?** Claude Code her turda son breakpoint'i yeni son
mesaja **kaydırır** (rolling breakpoint):

```
turn N    [tools][system◆][m0 … m37◆]
turn N+1  [tools][system◆][m0 … m37 ][m38 m39◆]
           └──────── cache read ─────┘└ write ┘
```

- `m0 … m37` önceki turn'de cache'lenmişti ve değişmedi → **cache read**.
- `m38 m39` yeni → **cache write** (bir sonraki turn'de bunlar da okunacak).
- Son breakpoint'ten sonra bir şey kalırsa → düz **input**.

Bu yüzden sağlıklı bir sohbette her turn'ün `cache read`'i kabaca bir önceki
turn'ün `cache read + cache write` toplamına eşittir. Bu kural bozulduğunda
Cache kartı **partial hit** ya da **miss** der.

Not: `cache_control` işaretinin kendisi içeriğin parçası sayılmaz. İşaret
`m37`'den `m39`'a taşındı diye `m37` "değişmiş" olmaz. cmon da karşılaştırma
yaparken bu işareti yok sayar.

**Perde arkasında eşleşme nasıl çalışır?**
- Sunucu, breakpoint'e kadar olan önekin içeriğinden bir anahtar üretir ve o
  anahtarla daha önce yazılmış bir girdi arar. Tek bir byte farkı bile farklı
  anahtar demektir. "Benzer" diye bir şey yoktur.
- Tam breakpoint'te eşleşme yoksa sunucu breakpoint'ten **geriye doğru** blok
  sınırlarını da dener (dokümana göre yaklaşık 20 blok). Böylece breakpoint
  kaydığında bir önceki turn'ün yazdığı önek yine bulunur. Ama değişiklik bu
  pencereden daha gerideyse eşleşme bulunamaz.
- Önek modele göre değişen bir **minimum uzunluğun** altındaysa cache'lenmez.
  Hata da vermez, işaret sessizce yok sayılır. Kısa yan çağrılarda `cache write`
  hep 0 görünmesinin sebebi budur.
- Cache girdisi ancak onu yazan isteğin cevabı başladıktan sonra kullanılabilir.
  Aynı anda başlayan paralel istekler (örn. aynı anda açılan subagent'lar)
  birbirinin cache'ini göremez, her biri kendisi yazar.
- Cache **model başınadır**. Sohbetin ortasında modeli değiştirirsen aynı önek
  yeni modelde sıfırdan yazılır.

**Neyin değişmesi neyi bozar?** Sıra araçlar → system → mesajlar olduğu için
bir değişiklik kendisinden sonraki her şeyi geçersiz kılar:

| Değişen | Bozulan | Tipik sebep |
| --- | --- | --- |
| Araç listesi / bir aracın tanımı | **her şey** | MCP sunucusu bağlandı/koptu, araç açıklaması güncellendi |
| System prompt | system + mesajlar | Prompt'a gömülü tarih/saat, git status, değişen bir talimat dosyası |
| Ortadaki bir mesaj | o mesajdan sonrası | Context editing (eski araç sonucunun temizlenmesi), compaction |
| Thinking ayarı, `tool_choice` | mesajlar | Effort/thinking bütçesinin turn'ler arasında değişmesi |
| Model | her şey | `/model` ile geçiş |

**Örnek: partial hit.** System prompt'un sonunda saniyeli bir zaman damgası
olduğunu düşün:

```
turn N    [tools][system: "... Current time: 14:02:11"◆][m0 … m37◆]
turn N+1  [tools][system: "... Current time: 14:02:48"◆][m0 … m39◆]
           └ read ┘└─────────── hepsi yeniden write ─────────────┘
```

Araçlar hâlâ cache'ten gelir ama system prompt ve **tüm geçmiş** her turn
yeniden yazılır. Cache kartı burada kırmızı çizgiyi `system[1]` üzerine koyar
ve hükmü *partial hit* olur. Tek bir değişken satır, her turn'ü 1.25× fiyatla
ödenen bir yazmaya çevirir.

**Örnek: önek aynı, yine de miss.** Kahve molası verdin, 7 dakika sonra
döndün:

```
turn N    14:02  [tools][system◆][m0 … m37◆]      5m TTL
turn N+1  14:09  [tools][system◆][m0 … m39◆]      7m since previous turn
```

Hiçbir byte değişmedi ama 5 dakikalık girdi düştü. Kart *miss* der ve
açıklamada süreyi TTL ile karşılaştırır. Burada düzeltilecek bir hata yoktur.
Uzun aralarla çalışılıyorsa 1 saatlik TTL daha ucuza gelebilir (yazması 2×,
ama her moladan sonra tüm geçmişi yeniden yazmaktan ucuz).

### Tahmin mi, ölçüm mü?
- Ring altındaki dört usage sayısı ve maliyetler **gerçek API verisinden**
  hesaplanır.
- Bölüm bazlı token sayıları (system prompt kaç token, Bash aracının tanımı kaç
  token vb.) **tahmindir**: `karakter sayısı / 4`. API bölüm bazlı sayı vermez.
  "Measure exactly" butonu bunları gerçek sayılarla değiştirir (bkz. §5.9).

### Maliyetler
- **Liste fiyatı** üzerinden hesaplanır (`src/pricing.js`): Fable 10/50,
  Opus 5/25, Sonnet 3/15, Haiku 4 1/5 $ (milyon token başına, girdi/çıktı).
- Abonelikle (OAuth) kullanıyorsan bu senin gerçek faturan değildir. Aynı
  trafiğin API'de ne tutacağını gösterir. Göreli karşılaştırma için (hangi kısım
  pahalı, cache ne kazandırıyor) yine de doğrudur.
- Fiyat tablosunda olmayan bir model (örn. Haiku 5.5) için maliyet **gösterilmez**
  (`—`). Tahmini fiyat uydurulmaz.

### Sayı biçimi
`34.9K` = 34.900, `1.2M` = 1.200.000. `≈` işareti tahmin ya da yaklaşık değer
anlamına gelir.

---

## 3. Sayfa düzeni

```
┌──────────┬──────────────────────────────────────────────────────────┐
│ Sessions │  Turns ribbon (her turn bir çubuk)       ◀ ▶  pinned ×    │
│ (oturum  │  saat · model · çağrı türü · cli/sdk-cli · HTTP hata     │
│  listesi)├──────────────────────────────────────────────────────────┤
│          │  Kartlar (Context window, Cache, History, ...)           │
└──────────┴──────────────────────────────────────────────────────────┘
```

- Kartların çoğu **seçili turn**'ü anlatır. Bazıları **tüm oturumu** anlatır
  (Where the calls go, Threads, Tool definitions, kartların alt satırları).
- O turn için söyleyecek bir şeyi olmayan kart **gizlenir**. Sıfırlarla dolu
  görünmez. Örneğin tek thread varsa Threads kartı hiç çıkmaz.
- Her kart katlanabilir. "Collapse all / Expand all" hepsini birden yapar.

---

## 4. Her zaman ekranda olanlar

### Sessions (sol ray)
Yakalanan her oturum, en yenisi üstte. Silmek iki tık ister (yanlışlıkla
silinmesin diye).

### Turns ribbon (turn şeridi)
- Her çubuk bir turn. **Yükseklik = o turdaki context token** (input + cache
  write + cache read), oturumdaki en büyük turn'e göre ölçeklenir.
- **İnce/dış hatlı çubuklar** konuşmanın parçası olmayan yan çağrılardır
  (güvenlik kontrolü, başlık üretimi, subagent vb.). **Kalın dolu çubuklar**
  ana agent döngüsüdür.
- **Soluk çubuk**: usage gelmemiş turn (genelde hata).
- Üzerine gelince: `#numara · context token · çağrı türü`.
- Tıkla ya da `←`/`→` (veya `j`/`k`) ile gez.
- Eski bir turn'e geçince **pinned ×** belirir. Yeni turn'ler gelse de görünüm
  yerinde kalır. Tıklayınca en yeniyi takip etmeye döner.
- Başlık altındaki satır: saat · model · çağrı türü · giriş noktası (`cli` =
  terminal, `sdk-cli` = Agent SDK) · varsa `HTTP 429` gibi hata.

---

## 5. Kartlar

### 5.1 Context window: "Pencere ne kadar dolu?"
- **Halka**: seçili turn'de modelin okuduğu toplam girdinin modelin context
  limitine oranı. Renkler: mavi = input, turuncu = cache write, yeşil = cache read.
- **Ortadaki %**: doluluk. Altında `X of Y ctx`.
- **Limit**: modele göre belirlenir. Opus/Sonnet 4.6+, Haiku 5.5, Fable ve
  Mythos için 1M, daha eski modeller için 200K (`context-1m` beta başlığı varsa
  1M).
- **Token usage this turn**: dört gerçek usage sayısı (§2).

Okuma: Yan çağrıları seçersen halka çok boş görünür. Bu normaldir, onların
kendi küçük pencereleri vardır. Pencere doluluğu için agent loop turn'lerine bak.

### 5.2 Where the calls go: "Para nereye gidiyor?" (oturum geneli)
Oturumdaki her isteği *gerçekte ne olduğuna* göre gruplar:

| Tür | Ne | Nasıl tanınıyor |
| --- | --- | --- |
| **agent loop** | Asıl sohbetin | İstekte araç tanımları var |
| **subagent** | Task/Agent ile açılan, kendi penceresi olan alt ajan | `x-claude-code-agent-id` başlığı |
| **bash security check** | Bash komutu çalışmadan önce onu sınıflandıran güvenlik modeli | System prompt "You are a security monitor…" ile başlıyor |
| **session title** | Resume listesi için oturuma isim verme | Başlık üretme prompt'u |
| **compaction** | Konuşmayı özetleyip sığdırma | Araçsız, özet isteyen çağrı |
| **quota probe** | Açılıştaki erişim/kota kontrolü | Gövdesi sadece `quota` olan 1 tokenlık istek |
| **token count** | Claude Code'un göndermeden önce pencereyi ölçmesi | `/v1/messages/count_tokens` |
| **utility call** | Bunların dışında kalan araçsız kısa çağrı | — |

Her satırda: `×adet`, maliyet · toplamdaki payı %, açıklama · model,
`X in · Y out` (girdi = input+cache write+cache read, çıktı).
Renk: turuncu = ana konuşma, yeşil = subagent, gri = arka plan/meta.

Alt satır: "N of M calls run beside the conversation, costing $X (%Y)" = kaç
isteğin sohbetin dışında olduğu ve ne tuttuğu. Bir de `claude-cli` sürümü.

### 5.3 Threads: "Subagent gerçekte ne tuttu?" (oturum geneli)
Sadece birden fazla thread varsa görünür.
- **the conversation**: ana sohbet. Araç sayısı ve tepe context değeriyle.
- **subagent \<id\>**: her alt ajan. Turn sayısı, maliyet, `in/out` tokenlar ve
  "spawned by Agent at turn #N · reported back K tokens".
- Alt satırdaki oran asıl önemli sayı: subagent'lar X token harcadı, geri
  sadece K token döndürdü ("N× what the conversation ever saw").
- Hangi çağrının hangi subagent'ı açtığı **sıralamadan çıkarılır**, kayıtta
  açıkça yazmaz. Kart da bunu belirtir.
- Satıra tıklamak o thread'in ilk turn'üne götürür.

**Örnek okuma** (temsili): Bir subagent 9 turn boyunca dosya okuyup aramış,
her turn kendi geçmişini yeniden göndermiş, toplam girdisi 600K token olmuş.
Ana sohbete döndürdüğü özet 2K token. Oran 300×: ana sohbet kendi penceresini
600K tokenla doldurmak yerine 2K'lık bir özet aldı. Subagent'ın değeri tam
olarak bu takastır. Ama özet işe yaramıyorsa, o 600K boşa gitmiş demektir.

Subagent'ın ilk turn'ü neden hep *cold start*? Çünkü kendi araç seti ve system
prompt'u vardır, yani önek ana sohbetle aynı değildir. Ana sohbetin cache'inden
faydalanamaz.

### 5.4 Cache: "Cache neden böyle davrandı?"
Seçili turn'ü **aynı konuşmanın** bir önceki turn'üyle karşılaştırır.

Üst satır: `N breakpoints · 5m TTL`.

**Hüküm (verdict):**

| Etiket | Renk | Anlamı | Ne yapmalı |
| --- | --- | --- | --- |
| **prefix hit** | yeşil | Önceki turn'ün cache'lediği her şey byte byte aynı. | Her şey yolunda. |
| **partial hit** | sarı | Cache'li bölgenin içinde bir şey değişti. Ondan sonrası yeniden yazıldı. | Kart hangi bloğun değiştiğini yazar. Sık tekrarlanıyorsa bir sızıntı var demektir. |
| **miss** | kırmızı | Hiçbir şey yeniden kullanılmadı. | Açıklamaya bak: önek değişmiş, TTL dolmuş ya da önek aynı ve süre dolmamış olduğu halde Anthropic tarafında silinmiş. |
| **cold start** | gri | Bu konuşmanın ilk turn'ü. | Normal. Subagent'ların ilk turn'ü de böyledir. |

`Xs since previous turn` hapı: önceki turn'den bu yana geçen süre. TTL ile
karşılaştırmak için.

**Prefix şeridi ("Prefix, in cache order"):** isteğin tamamı token ekseninde
yatay bir çubuk olarak çizilir.
- Açık turuncu dolgu = cache'lenen önek (son breakpoint'e kadar).
- Turuncu çentikler = breakpoint'ler.
- Kırmızı çizgi = **ilk farkın** olduğu yer. Önekin önceki turn'le eşleşmeyi
  bıraktığı nokta.

Önemli ayrıntı: Son breakpoint'ten *sonraki* farklar zarar saymaz. O kısım
zaten hiç cache'lenmemişti, sadece sohbet ilerliyor demektir.

**Maliyet hücreleri:**
- **this turn**: bu turn'ün liste fiyatıyla maliyeti.
- **if nothing cached**: cache hiç olmasaydı (tüm girdi tam fiyat).
- **saved**: aradaki fark, % ve $. İlk turn'de negatif olabilir (yazma okumadan
  pahalı). Bu normaldir. 20. turn'de negatifse sorun var.
- **written / read**: cache'e yazılan / cache'ten okunan token.

**Oturum satırı:** `session 94 prefix hit · 21 partial hit · …`, toplam harcama
ile cache'siz karşılığı ve önek değişikliği yüzünden yeniden yazılan token
toplamı.

### 5.5 Over the wire: "Neden yavaştı?"
- **time to first byte**: ilk byte'a kadar geçen süre. Kuyruk + prompt'un
  işlenmesi (*queue + prompt*). Uzun prompt'ta doğal olarak uzar.
- **generating**: ilk byte'tan sonraki üretim süresi ve `tok/s`.
- **total**: toplam süre.
- **on the wire**: gönderilen istek boyutu ve dönen cevap boyutu.
- Üst satır: HTTP durum kodu ve `request-id`. Anthropic destek/loglarıyla
  eşleştirmek için.

Okuma: TTFB uzun, üretim normalse model yavaş değildir. Bekleme ya da prompt
işleme uzun sürmüştür.

**Rate limit budget:** `anthropic-ratelimit-*` başlıklarından kalan kota,
`kalan / limit` ve ne zaman sıfırlanacağı. Çubuk rengi: yeşil > %30, sarı
%10–30, kırmızı < %10.

Alt satırlar: ölçülen turn sayısı, medyan/en yavaş TTFB, medyan tok/s, SDK'nın
sessizce yeniden denediği turn'ler, başarısız istekler (HTTP kodlarıyla) ve bu
turn'ün hatası (varsa `retry after`).

### 5.6 Thinking: "Çıktının ne kadarı düşünmeydi?"
- Üst satır: `X of Y output tokens · %Z` = çıktının ne kadarı thinking.
- **Blok sırası** hapları: cevabın geliş sırası, örn.
  `thinking → text → tool call`. `thinking → tool call` araçlar arasında
  düşünme (interleaved) demektir.
- Not: thinking blokları genelde **boş metin + uzun imza (signature)** ile
  gelir. Ham düşünce geri dönmez ama tokenlar yine üretilmiş ve faturalanmıştır.
  İstekte ne istendiği de yazar (`thinking`, `effort`, task budget).
- Alt satırlar: kaç konuşma turn'ünün düşündüğü ve bu istekte geri gönderilen
  thinking bloklarının taşıdığı imza tokenları. Bu imzalar sonraki her turn'de
  yeniden gönderilir ve kimse okuyamaz.

Cevapta bir thinking bloğu kabaca şöyle görünür:

```json
{ "type": "thinking", "thinking": "", "signature": "EqQBCkYIBxgCKkB..." }
```

`thinking` alanı boş, `signature` ise şifreli ve uzun bir dizgedir. Claude Code
bu bloğu sonraki istekte geçmişe aynen geri koyar. Model düşünce zincirini bu
imzadan devam ettirir. Sonuç: çıktı token'ı olarak bir kez ödenen düşünme,
sonraki turn'lerde imza olarak tekrar tekrar girdiye (çoğu zaman cache read
olarak) biner.

### 5.7 History over time: "Pencere ne hızla doluyor?"
- Sadece ana konuşma turn'lerinin (yan çağrılar hariç) dört usage serisi,
  üst üste alan grafiği. Bir noktaya tıklamak o turn'e götürür.
- Üst satır: `N turns in session · M side calls excluded`.
- Alt satır 1: `growing ≈X tokens per turn · ≈N turns of headroom below the
  1M limit`. Son 12 turn'ün eğimine göre doğrusal bir projeksiyondur, ölçüm
  değildir.
- Alt satır 2 ve turn çipleri: transkriptin **sona ekleme dışında**
  değiştirildiği turn'ler:

| Etiket | Anlamı |
| --- | --- |
| **edited in place** | Var olan bir mesaj farklı döndü: yeniden yazıldı, kısaltıldı ya da yer açmak için bir araç sonucu temizlendi. |
| **replayed from an earlier point** | Ortak bir başlangıçtan sonra liste kısaldı. Daha önceki bir durum yeniden oynatıldı. |
| **compacted** | Geçmişin çoğu gitti, yerine özet geldi. |
| **history replaced** | Hiçbir şey kalmadı. |

"≈N tokens the model can no longer see" = bu düzenlemelerle modelin artık
göremediği token.

**Örnek: edited in place.** Uzun bir oturumda Claude Code yer açmak için eski
bir büyük araç sonucunu kısaltır:

```
turn 30  … m12: tool_result (Read, 18K tok: dosyanın tamamı) … m58
turn 31  … m12: tool_result ("[cleared]")                   … m58 m59
```

Mesaj sayısı aynı ama `m12` farklı. History kartı turn 31'i *edited in place*
olarak işaretler. Aynı anda Cache kartı da kırmızı çizgiyi `m12`'ye koyar:
`m12`'den sonraki her şey yeniden yazılır. Yani yer açmanın da bir bedeli var:
o turn'de geçmişin büyük kısmı 1.25× fiyatla yeniden cache'e yazılır.

**Örnek: compacted.** `/compact` sonrası 120 mesajlık geçmiş, tek bir özet
mesajına iner. Grafikte context alanı bir anda çöker. Takip eden turn bir
*miss* ya da *partial hit*'tir (önek artık tamamen farklı).

### 5.8 What fills the window: "Pencerede ne var?"
- **Oran çubuğu**: System prompt (turuncu) / Messages (mavi) / Tool
  definitions (yeşil). Altında her grubun yaklaşık token sayısı ve öğe sayısı.
- Üst satır: `~X tok estimated from the request body`. Bu bir **tahmindir**.
- **"N individual sections — open any of them"**: her bölüm (tek tek mesajlar
  `message[5]`, araçlar `tool: Bash` vb.) büyüklüğe göre sıralanır.
  Filtre kutusu var. Tıklayınca açılan panelde tam metin, aracın parametreleri
  ve ham şeması ya da mesajın içerik blokları cache işaretleriyle görünür.
  Hepsinde kopyalama butonu var.

### 5.9 Measure exactly
"What fills the window" kartındaki buton. Dört `count_tokens` çağrısıyla
(boş istek, +araçlar, +system, tam istek) bölümleri **gerçek** sayıya çevirir:

- `system prompt / messages / tool definitions / request overhead / total`:
  gerçek sayı · `est` tahmin.
- "the chars/4 estimate was under by %X · 3.62 chars per token": tahminin bu
  istekte ne kadar saptığı. Sayfadaki diğer tüm tahminleri bu oranla okursun.
- **Gerçek istek atar, kota harcar.** Sonuç cache'lenir, ikinci tık bedavadır.

Neden dört çağrı? `count_tokens` sadece toplam verir. Bölümleri ayırmak için
tek mesajlık minimal bir istek taban alınır, her bölüm ona ayrı ayrı eklenir ve
farklar alınır:

```
base   = count(minimal istek)              → istek iskeleti (overhead)
tools  = count(base + tools)  − base       → araç tanımları
system = count(base + system) − base       → system prompt
full   = count(tam istek)
messages = full − tools − system − base    → mesajlar
```

Neden `chars/4` sapar? Tokenizer metni karakter değil parça parça böler.
Düz İngilizce metin kabaca 4 karaktere 1 token'a yakındır. JSON şemaları,
kod, uzun hash/imza dizgeleri ve Türkçe gibi metinler daha fazla token'a
bölünür. Araç şemaları ağırlıklı bir istekte tahminin aşağıda kalması bu
yüzdendir.

### 5.10 Tool definitions: "Hangi araçları kapatabilirim?" (oturum geneli)
- Üst satır: `N tools · X tokens of definitions`.
- Her satır: araç adı, `×çağrı sayısı` ya da **never called** (soluk),
  tanımın token maliyeti ve `· Y back` (araçtan dönen sonuç tokenları).
- Alt satırlar:
  - "N of M tools were never called — X tokens (%Y) re-sent on every turn"
  - "definitions account for ≈$A of the $B this session spent on prompts":
    her turn'ün gerçek prompt harcaması, tanımların prompt içindeki payına göre
    bölüştürülür (tanımlar cache'ten okunduğu için tam fiyatla saymak yanlış
    olurdu).
  - Araç listesi oturum içinde değişti mi? Değiştiyse her değişiklik **tüm
    cache'i** geçersiz kılar (araçlar önekin en başında).

Neden "≈$A" bölüştürülüyor? Örnek (temsili): Bir turn'ün prompt maliyeti $0.05
ve tanımlar o prompt'un %20'si. O turn için tanımlara $0.01 yazılır. Tanımlar
çoğu turn cache'ten 0.1× fiyatla okunduğu için, "tanım tokenı × tam fiyat"
hesabı gerçek bedeli on kat şişirirdi.

Kullanılmayan bir aracı kapatmanın asıl kazancı her turn'deki küçük cache read
değil, **cache'in yeniden yazıldığı** turn'lerdir (ilk turn, TTL sonrası,
compaction): o turn'lerde tanımlar 1.25× fiyatla baştan yazılır.

### 5.11 Inside the system prompt
- System prompt kendi markdown başlıklarına göre bölümlere ayrılır, her biri
  token ve % ile sıralanır. Bölüm turn'ler arasında değiştiyse yanında sarı
  durum etiketi çıkar.
- **Injected into the messages**: mesajların içine gömülen `<system-reminder>`
  blokları, türüne göre (`×adet`, token). Bunlar sohbet gibi görünür ve sohbet
  gibi faturalanır ama sohbet değildir.
- Alt satır: "unchanged across every turn" ya da system prompt'un değiştiği
  turn'ler (çipler). Her değişiklik cache önekini orada bitirir.

### 5.12 Time machine
**Compare this turn against:** Seçili turn'ü *aynı türden* başka bir turn'le
karşılaştırır. Üç satır gösterir:
- **messages**: token farkı. Kaç mesaj eklendi, düştü, yerinde düzenlendi,
  baştan kaçı ortak.
- **tool definitions**: eklenen, çıkarılan ve yeniden yazılan araçlar.
- **system prompt**: eklenen, çıkarılan ve yeniden yazılan bölümler.
- Model değiştiyse o da gösterilir (model değişimi cache'i doğrudan bozar).

**Send it again, changed (Replay):** Turn'ü değiştirerek API'ye yeniden yollar:
- **model**: oturumda kullanılan modellerden biri.
- **tools**: *as captured* / *only the ones ever called* / *none at all*.
- **system prompt**: *as captured* / *dropped*.

Sonuç iki sütunda karşılaştırılır: model, gönderilen araç sayısı, prompt
(tahmini), faturalanan girdi, çıktı, maliyet, **stop reason**, çağrılan araçlar
ve "What it said this time".
İpucu: Önce stop reason'a ve çağrılan araçlara bak. `tool_use` → `end_turn`
olduysa model artık işi yapmıyor, sadece anlatıyor demektir.
**Gerçek istek atar, kota harcar**, çıktı 4K tokenla sınırlıdır ve sonuç
kayda yazılmaz.

### 5.13 Raw JSON
Yakalanan isteğin ve cevabın tamamı, katlanabilir ağaç olarak.
- **Copy as curl**: isteği çalıştırılabilir komut olarak kopyalar (anahtar
  `$ANTHROPIC_API_KEY` olarak bırakılır).
- **Copy request**: sadece gövde (fixture olarak).

---

## 6. Hazır okuma reçeteleri

| Soru | Nereye bak |
| --- | --- |
| Para nereye gidiyor? | **Where the calls go**, sonra **Cache** oturum satırı (harcama ve cache'siz karşılığı), sonra **Tool definitions** (kullanılmayan araçların payı). |
| Cache neden sürekli soğuk? | Turn'leri gez ve **Cache** hükmüne bak. Art arda *partial hit* görüyorsan kart değişen bloğu yazar (genelde zaman damgası ya da ortadaki bir `system` mesajı). Önek aynıyken *miss* varsa sorun TTL'dir. **Inside the system prompt** alt satırı prompt'un değiştiği turn'leri listeler. |
| Hangi araçları kapatabilirim? | **Tool definitions** → *never called* olanlar. Kapatmanın sonucu değiştirip değiştirmediğini görmek için **Replay**'de tools'u *only the ones ever called* yap, stop reason'ı ve çağrılan araçları karşılaştır. |
| Bu turn neden uzun sürdü? | **Over the wire**: TTFB mi uzun, generating mi? Retry var mı? |
| Context bitecek mi? | **History over time** alt satırı: turn başına büyüme ve kalan turn sayısı. |
| Subagent değdi mi? | **Threads**: harcanan token / geri dönen token oranı. |
| Bu tokenlar doğru mu? | **Measure exactly**. |
| Bu turn'ü dışarıda tekrar üretmek istiyorum | **Raw JSON → Copy as curl**. |

---

## 7. Dikkat edilecekler

- Bölüm bazlı tokenlar **tahmindir** (`chars/4`). Usage ve maliyet gerçek API
  verisine dayanır.
- Maliyet **API liste fiyatıdır**. Abonelikte gerçek faturan değildir.
- "Turns of headroom" bir **projeksiyondur**. Son 12 turn'ün hızıyla devam
  edersen ne olacağını gösterir.
- Subagent'ı hangi çağrının açtığı **çıkarımdır**.
- Kota harcayan sadece iki şey var: **Measure exactly** ve **Replay**. İkisi de
  sadece tıklayınca çalışır. Sayfanın geri kalanı diskteki kayıtlardan okunur.
- Kayıtlar (`~/.cmon/captures/`) prompt'larının ve araç çıktılarının tamamını
  düz metin olarak tutar. İşin bitince silebilirsin.
