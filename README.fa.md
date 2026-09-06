<div dir="rtl">

# opencode-converter-api

[English](README.md) | **فارسی**

یک Cloudflare Worker که سرویس [opencode zen](https://opencode.ai/docs/zen/) را پشت APIهای استاندارد و رایج قرار می‌دهد — قابل استقرار روی زیرساخت خودتان:

- **`POST /v1/chat/completions`** — سازگار با OpenAI Chat Completions
- **`POST /v1/messages`** — سازگار با Anthropic Messages
- **`POST /v1/responses`** — سازگار با OpenAI Responses
- **`GET /v1/models`** و **`GET /v1/models/{id}`** — فهرست زنده‌ی مدل‌ها، مستقیم از zen

هر سه فرمت از **استریم (SSE)**، **فراخوانی ابزار (tool calling)** و **ورودی چندرسانه‌ای** (تصویر، صدا، ویدیو و PDF — در حد توانایی هر مدل) پشتیبانی می‌کنند. کلید zen خودتان را بیاورید — این worker هیچ چیزی ذخیره نمی‌کند و چیزی جز درخواست شما را پروکسی نمی‌کند.

```
any OpenAI / Anthropic / Responses client
            │  (your key or none)
            ▼
   opencode-converter-api (this worker)
            │  presents as opencode CLI
            ▼
      opencode.ai/zen/v1
```

## شروع سریع

با سه دستور، نسخه‌ی خودتان را مستقر کنید:

```bash
npm install
npx wrangler login
npm run deploy          # uses wrangler.toml
```

حالا اولین درخواست را بفرستید — یک مدل رایگان، بدون نیاز به کلید:

```bash
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

برای اجرای محلی: `npm run dev` (worker روی `http://localhost:8787`).

> **توصیه:** دسترسی ناشناس به پلن رایگان از طریق worker مستقرشده قابل‌اعتماد نیست (zen روی IPهای دیتاسنتری سختگیرانه محدودسازی می‌کند — بخش [پلن رایگان و محدودیت‌ها](#rate-limits) را ببینید). کلید zen خودتان را بفرستید — ساختنش رایگان است — تا سهمیه‌ی اختصاصی و پایدار داشته باشید و به مدل‌های پولی هم دسترسی پیدا کنید:

```bash
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H 'Authorization: Bearer <zen-key>' -H 'Content-Type: application/json' \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"hi"}]}'
```

کلید zen شما می‌تواند با هرکدام از این‌ها ارسال شود — کلید داخل خودِ درخواست از کلاینت به worker و از آنجا به zen می‌رود و **هرگز در تنظیمات این worker ذخیره نمی‌شود**:

| ارسال کلید به‌صورت | مثال |
|---|---|
| توکن Bearer | `Authorization: Bearer <zen-key>` |
| هدر به سبک Anthropic | `x-api-key: <zen-key>` |
| هدر به سبک Gemini | `x-goog-api-key: <zen-key>` |
| پارامتر آدرس | `…/v1/models?key=<zen-key>` |

بدون هیچ کلیدی، دسترسی ناشناس به پلن رایگان دارید (`Bearer public` — دقیقاً مثل opencode CLI وقتی لاگ‌اوت است)؛ مدل‌های رایگان کار می‌کنند و مدل‌های پولی خطای احراز هویت zen را برمی‌گردانند.

## مثال‌های بیشتر

```bash
# Anthropic style (your key, paid model)
curl https://<your-worker>.workers.dev/v1/messages \
  -H 'x-api-key: <zen-key>' -H 'Content-Type: application/json' \
  -d '{"model":"claude-haiku-4-5","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'

# OpenAI Responses style
curl https://<your-worker>.workers.dev/v1/responses \
  -H 'Authorization: Bearer <zen-key>' -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.6-luna","input":"hi"}'

# Multimodal (image on a vision-capable model, e.g. any muse-*/gemini-*/claude-*/gpt-*)
curl http://localhost:8787/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"muse-spark-1.2-contributor-free","messages":[{"role":"user","content":[
        {"type":"text","text":"what is this?"},
        {"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}]}]}'
```

ابزارها (tools)، `stream`، `stop`، `temperature`، `top_p`، `max_tokens` / `max_output_tokens`، `reasoning_effort` / `thinking.budget_tokens` و فرمت‌های پاسخ JSON-Schema بین هر سه فرمت ترجمه می‌شوند.

**نکات سریع**

- با ارسال `x-session-id: <یک-شناسه-ثابت>` درخواست‌هایتان زیر یک نشست zen گروه‌بندی می‌شوند (مطابق رفتار خود CLI).
- هر درخواست به‌صورت پیش‌فرض در **بالاترین سطح استدلالِ پشتیبانی‌شده توسط مدل** اجرا می‌شود؛ برای رعایت درخواست کلاینت، `FORCE_MAX_REASONING=0` را تنظیم کنید.
- بدون لاگ‌برداری از درخواست‌ها، بدون ذخیره‌ی کلید، بدون حالت (state): همه‌چیز در همین چرخه‌ی درخواست/پاسخ خلاصه می‌شود.

---

## ⚙️ تنظیمات پیشرفته

### کلیدهای مخفی (اختیاری)

```bash
npx wrangler secret put GATEWAY_KEY      # gate your deployment
npx wrangler secret put DEFAULT_ZEN_KEY  # deployment-wide zen key
```

- **`GATEWAY_KEY`** — درخواست‌کنندگان باید علاوه بر کلید zen، هدر `x-oc-gateway-key: <gateway-key>` را هم بفرستند (یا از آن به‌عنوان bearer استفاده کنند) تا deployment شما در برابر غریبه‌ها محافظت شود؛ در این حالت کلید zen از `x-zen-key`/`x-api-key`/`?key=` گرفته می‌شود.
- **`DEFAULT_ZEN_KEY`** — یک کلید zen پیش‌فرض در سطح deployment که وقتی درخواست‌کننده کلیدی نمی‌فرستد استفاده می‌شود.

### متغیرهای محیطی

همه اختیاری‌اند؛ در `wrangler.toml` زیر `[vars]` یا به‌صورت secret تنظیمشان کنید. مقادیر پیش‌فرض منطقی‌اند — لزوماً نیازی به دست‌زدن به آن‌ها نیست.

| متغیر | پیش‌فرض | چه چیزی را کنترل می‌کند |
|---|---|---|
| `UPSTREAM_RETRIES` | `3` (حداکثر ۲۰) | تعداد تلاش مجدد وقتی zen شلوغ است (429 / 502 / 503 / 529) |
| `UPSTREAM_TOTAL_DEADLINE_MS` | `90000` | سقف زمانی کل توالی تلاش مجدد برای شلوغی (۹۰ ثانیه) |
| `UPSTREAM_NETWORK_RETRIES` | `150` (حداکثر ۱۰۰۰) | تعداد اتصال مجدد در خرابی‌های شبکه (قطع اتصال، DNS/TLS، تایم‌اوت) |
| `UPSTREAM_NETWORK_DEADLINE_MS` | `900000` | سقف زمانی کل اتصال‌های مجدد (۱۵ دقیقه) |
| `UPSTREAM_NETWORK_DELAY_CAP_MS` | `5000` | سقف فاصله‌ی زمانی بین تلاش‌های اتصال مجدد (۵ ثانیه) |
| `UPSTREAM_EMPTY_RETRIES` | `30` (حداکثر ۲۰۰) | تعداد شروع مجدد وقتی مدل پاسخ خالی برمی‌گرداند |
| `UPSTREAM_HEADER_TIMEOUT_MS` | `120000` | حداکثر انتظار برای هدرهای پاسخ zen قبل از اتصال مجدد (۱۲۰ ثانیه) |
| `UPSTREAM_BODY_TIMEOUT_MS` | `240000` | بدنه‌ی پاسخ غیراستریم باید در این بازه تمام شود (۲۴۰ ثانیه) |
| `UPSTREAM_STALL_TIMEOUT_MS` | `300000` | حد توقف استریم — بدون داده‌ی SSE به این طول (۳۰۰ ثانیه) |
| `STREAM_DEADLINE_MS` | `570000` | مهلت کل استریم (۵۷۰ ثانیه) |
| `FORCE_MAX_REASONING` | `1` | برای رعایت سطح استدلالِ درخواستی کلاینت، `0` بگذارید |
| `FALLBACK_VERSION` | — | ثابت‌کردن نسخه‌ی CLI به‌جای دریافت زنده از npm |

### رفتار تلاش مجدد و مهلت‌ها

هر فراخوانی upstream محدود است — هیچ درخواستی تا ابد معلق نمی‌ماند. دو بودجه‌ی **مستقل** وجود دارد: یک اتصال مجدد هرگز از بودجه‌ی تلاش برای شلوغی مصرف نمی‌کند و برعکس.

| | خرابی‌های شبکه (قطع اتصال، خطای DNS/TLS، تایم‌اوت) | شلوغی سرور بالادستی (429 / 502 / 503 / 529) |
|---|---|---|
| تعداد تلاش | **۱۵۰** (`UPSTREAM_NETWORK_RETRIES`) | ۳ (`UPSTREAM_RETRIES`) |
| مهلت کل | ۱۵ دقیقه (`UPSTREAM_NETWORK_DEADLINE_MS`) | ۹۰ ثانیه (`UPSTREAM_TOTAL_DEADLINE_MS`) |
| فاصله‌ی بین تلاش‌ها | ۲۵۰ms، ۵۰۰ms، ۱s، ۲s و سپس ۵s ثابت، با کمی تصادف (`UPSTREAM_NETWORK_DELAY_CAP_MS`) | نمایی تا ۹ ثانیه، با احترام به `Retry-After` |

در مهلت (timeout)، کلاینت یک خطای تمیز در همان فرمت API خودش دریافت می‌کند (کلاینت‌های استریم رویداد خطای SSE می‌گیرند و استریم‌های فرمت OpenAI همچنان با `finish_reason` + `[DONE]` بسته می‌شوند). تلاش‌های مجدد به‌محض قطع اتصال کلاینت متوقف می‌شوند و قطع اتصال، فراخوانی upstream را هم لغو می‌کند.

> **نکته‌ی پلتفرم:** کلاودفلر سقفی برای تعداد subrequestهای خروجی هر درخواست دارد (۵۰ در پلن Free و ۱۰۰۰ در پلن‌های پولی)؛ بنابراین worker مستقرشده در پلن Free فقط می‌تواند حدود ۴۵ بار اتصال مجدد بزند. در این حالت خطا به‌وضوح همین را می‌گوید و پیام رمزآلودی نمی‌بینید. `wrangler dev` محلی و پلن‌های پولی از کل ۱۵۰ تلاش استفاده می‌کنند.

---

## 🔍 جزئیات فنی

<a id="rate-limits"></a>

<details>
<summary><b>مسیریابی اندپوینت‌ها (چطور یک URL به همه‌ی مدل‌ها سرویس می‌دهد)</b></summary>

zen به‌صورت بومی چهار لهجه‌ی (dialect) API متفاوت دارد که برای هر خانواده‌ی مدل قفل شده‌اند:

| خانواده‌ی مدل | اندپوینت zen | لهجه‌ی zen |
|---|---|---|
| `gpt-*`، `grok-*`، `muse-*` | `/zen/v1/responses` | OpenAI Responses |
| `claude-*`، `qwen*` | `/zen/v1/messages` | Anthropic Messages |
| `glm-*`، `kimi-*`، `minimax-*`، `deepseek-*`، `big-pickle`، `*free` (بیشتر) | `/zen/v1/chat/completions` | OpenAI Chat |
| `gemini-*` | `/zen/v1/models/{model}:generateContent` | Gemini |

فرستادن درخواست به اندپوینتِ اشتباه برای یک مدل شکست می‌خورد؛ برای همین این worker پس از یک تبدیل واحد و استاندارد (canonical)، هر درخواستی را به لهجه‌ی بومیِ درست مسیریابی می‌کند:

```
inbound format ──parse──▶ canonical request ──build──▶ zen native dialect
                                                       (auto-routed per model)
inbound format ◀─emit─── canonical events/resp ◀─parse── zen SSE / JSON
```

</details>

<details>
<summary><b>هویت CLI (اینکه چرا مدل‌های رایگان اصلاً کار می‌کنند)</b></summary>

پلن رایگان zen فقط به کلاینت‌هایی سرویس می‌دهد که شبیه opencode CLI باشند — به‌صورت تجربی ثابت شده: بدون `User-Agent` مخصوص CLI، مدل‌های رایگان `429 FreeUsageLimitError` برمی‌گردانند. این worker دقیقاً همان چیزی را می‌فرستد که CLI واقعی می‌فرستد (منبع: `packages/opencode/src/session/llm/request.ts` در `anomalyco/opencode`):

```
User-Agent: opencode/<version>
Authorization: Bearer <your-key | "public">
x-opencode-client: cli
x-opencode-session / x-opencode-request / x-opencode-project: <ids>
```

نسخه به‌صورت **زنده** از رجیستری npm (`opencode-ai/latest`) گرفته می‌شود با پشتیبانِ GitHub Releases و یک ساعت در لبه (edge) کش می‌شود — یعنی بدون هیچ نگهداری‌ای همگام با آخرین انتشار CLI می‌ماند. اگر لازم شد با متغیر `FALLBACK_VERSION` ثابتش کنید.

</details>

<details>
<summary><b>پلن رایگان و محدودیت‌ها</b></summary>

پلن رایگان ناشناس (بدون کلید) از یک استخر سهمیه‌ی مشترک استفاده می‌کند و zen سختگیرانه محدودسازی می‌کند — **به‌خصوص از IPهای دیتاسنتری مثل بازه‌های خروجی Cloudflare Workers**. در عمل، دسترسی ناشناس از طریق worker مستقرشده قابل‌اعتماد نیست (بیشتر اوقات `429 FreeUsageLimitError`)؛ از IP مسکونی تا خالی‌شدن استخر محلی کار می‌کند. **کلید شخصی (BYOK) را حالت اصلی استفاده بدانید.**

worker خودش هم محدودیت‌های باقی‌مانده را کاهش می‌دهد:

- **تلاش مجدد خودکار** با backoff نمایی روی خطاهای 429/502/503 بالادستی — فقط تا قبل از رسیدن اولین بایت به کلاینت شما، تا استریم درست باقی بماند.
- **خطاهای قابل‌فهم**: وقتی استخر خالی شده، پیام خطا همین را می‌گوید و پیشنهاد می‌دهد کلید خودتان را بفرستید.
- **نشست‌های پایدار**: `x-session-id` درخواست‌های شما را زیر یک نشست zen گروه می‌کند، نه یک شناسه‌ی نشست تازه برای هر درخواست.

مدل‌های رایگان با کلید هم کار می‌کنند — BYOK فقط قرعه‌کشیِ استخر مشترک را حذف می‌کند.

</details>

<details>
<summary><b>جدول پشتیبانی چندرسانه‌ای</b></summary>

| بخش ورودی | ترجمه می‌شود به |
|---|---|
| `image_url` / `input_image` / `image` آنتروپیک | تصویر بومی برای لهجه‌ی مقصد (base64 یا URL) |
| `input_audio` (wav/mp3/mp4) | `input_audio` برای لهجه‌های openai؛ صدای درون‌خطی برای gemini؛ یادداشت متنی برای مدل‌های فقط-آنتروپیک |
| `input_file` (ویدیو) | `input_file` به‌صورت data-URI در لهجه‌ی responses، داده‌ی درون‌خطی در gemini |
| `input_file` / `document` (pdf) | `document` آنتروپیک، `input_file` در responses، درون‌خطی در gemini |

اگر مدل مقصد رسانه‌ای را نپذیرد (مرجعِ نهایی zen است)، درخواست همان‌طور که هست عبور می‌کند و خطای خود zen در قالب درخواست شما برگردانده می‌شود.

</details>

<details>
<summary><b>اصلاحات سازگاری کلاینت‌ها</b></summary>

کلاینت‌های ایجنت payloadهایی می‌فرستند که upstreamهای zen به‌کل رد می‌کنند. مبدل این‌ها را شفاف نرمال‌سازی می‌کند:

- **نام‌های طولانی ابزار** — سقف نام توابع در upstreamها ۶۴ کاراکتر است (`^[a-zA-Z0-9_-]{1,64}$`)، اما نام‌های MCP-مانند مثل `zcode__mcp__filesystem__read_file_contents_with_line_numbers_and_ranges` (۷۱ کاراکتر) رایج‌اند. این نام‌ها در مسیر خروجی به نام‌های مستعارِ کوتاه و قطعی (`t_<hash>`) بازنویسی می‌شوند — به‌صورت یکدست در تعریف ابزارها، تاریخچه‌ی گفتگو و `tool_choice` اجباری — و در هر پاسخ و رویداد استریم به نام اصلی شما نگاشت می‌شوند. کلاینت شما هرگز مستعار را نمی‌بیند.
- **پارامترهای ناشناخته** — پارامترهایی که مبدل صریحاً نگاشت نمی‌کند (`logprobs`، `n`، `store` و…) به‌جای ارسال، حذف می‌شوند؛ zen روی فیلدهای ناشناخته 400 می‌دهد.
- **محدودیت‌های هر خانواده** — وقتی upstream یک پارامتر نگاشت‌شده را رد کند (مثلاً مدل‌های muse متا فقط `tool_choice: "auto"` را می‌پذیرند)، درخواست یک‌بار بدون آن بازسازی و خودکار دوباره تلاش می‌شود، به‌جای شکست.
- **بازیابی پاسخ خالی** — مدل‌های رده‌ی muse گاهی تمام پاسخ را به‌عنوان *استدلال* استریم می‌کنند و با پیام خالی تمام می‌شود؛ کلاینت‌هایی که استدلال را پنهان می‌کنند هیچ‌چیز برای نمایش ندارند. مبدل متنی را که upstreamها فقط در رویدادهای `done`/`completed` تحویل می‌دهند هم می‌گیرد (و از دلتاهای معمول می‌گذرد)، و اگر پاسخی با استدلال ولی بدون متنِ قابل‌مشاهده و بدون فراخوانی ابزار برسد، محتوای استدلال به یک پاسخ متنی معمولی ارتقا می‌یابد.

</details>

<details>
<summary><b>بیشترین استدلال، همیشه</b></summary>

هر درخواست، مدل را در **بالاترین سطح استدلالی که پشتیبانی می‌کند** اجرا می‌کند و فقط در صورت رد شدن از سوی upstream پله‌پله پایین می‌آید:

```
max → xhigh → high → medium → low → minimal → none → (no reasoning params)
```

نقطه‌ی شروع از یک جدول داخلی گرفته می‌شود که هر مدل zen چه سطحی را اعلام می‌کند (`gpt-5.6-*` و `claude-opus-5` به `max`، `muse-spark-*` به `xhigh`، `gemini-*` به `high` و غیره). مدل‌های بدون پشتیبانی استدلال اصلاً پارامتر استدلال نمی‌گیرند. برای مدلی که در جدول نیست، مبدل از `max` شروع می‌کند و به‌ازای هر ردشدن یک پله پایین می‌آید؛ یعنی مدلِ جدید فقط هزینه‌ی یک رفت‌وبرگشت اضافه دارد، نه یک درخواست شکست‌خورده. هر لهجه تنظیم را در شکل مخصوص خودش می‌گیرد: `reasoning_effort` برای chat، `reasoning.effort` برای Responses، `thinking.budget_tokens` برای آنتروپیک (زیر `max_tokens` محدود می‌شود و وقتی جایی نیست کلاً حذف می‌شود) و `thinkingConfig.thinkingBudget` برای gemini.

برای رعایت درخواستِ خودِ کلاینت، `FORCE_MAX_REASONING=0` را تنظیم کنید.

</details>

<details>
<summary><b>پاسخ‌های خالی، استریم‌های خودترمیم و تضمین‌های پایداری</b></summary>

مدل‌های پراستدلال مرتباً کل بودجه‌ی توکنشان را صرف فکرِ داخلی می‌کنند و پاسخ خالی برمی‌گردانند، یا دقیقه‌ها قبل از اولین بایت ساکت می‌مانند. این‌ها «قابل تلاش مجدد» در نظر گرفته می‌شوند، نه «شکست»:

| وضعیت | رفتار |
|---|---|
| هنوز هدر پاسخ نرسیده | تا **۱۲۰ ثانیه** انتظار (`UPSTREAM_HEADER_TIMEOUT_MS`)، سپس اتصال مجدد |
| اتصال برقرار است، ولی داده‌ای نمی‌آید | تا **۳۰۰ ثانیه** انتظار (`UPSTREAM_STALL_TIMEOUT_MS`)، سپس شروع مجدد تلاش |
| پاسخ می‌رسد بدون متن، فراخوانی ابزار یا استدلال | شروع مجدد تلاش |
| بودجه‌ی شروع مجدد | **۳۰ تلاش** (`UPSTREAM_EMPTY_RETRIES`) |

هر شروع مجدد بودجه‌ی توکن را دوبرابر می‌کند (از ۲٬۰۴۸ تا ۲۰۰٬۰۰۰)؛ چون علتِ رایج این است که استدلال همه‌چیز را قبل از شروع پاسخِ قابل‌مشاهده مصرف می‌کند. شروع مجدد فقط وقتی رخ می‌دهد که کلاینت شما هنوز چیزی دریافت نکرده باشد، پس خروجی هرگز تکرار نمی‌شود؛ درخواست‌های موفقی که به شروع مجدد نیاز داشتند، تعدادش را در `x-opencode-empty-retries` گزارش می‌کنند.

**استریم‌ها خودشان را ترمیم هم می‌کنند.** اگر اتصال *قبل از رسیدن هر بایتی به کلاینت شما* قطع شود — حتی وسط SSE — درخواست به‌صورت شفاف دوباره باز و از صفر شروع می‌شود (emitter و محافظ استدلال ریست می‌شوند، پس چیزی دوبار پخش نمی‌شود). وقتی بایت‌ها به کلاینت رسیده باشند، شروع مجدد خروجی را تکرار می‌کرد؛ به‌جایش یک رویداد خطای واضح می‌گیرید که توضیح می‌دهد پاسخِ ناتمام همه‌ی چیزی بود که رسید.

درخواست‌های غیراستریم هم موقع خواندن بدنه‌ی پاسخ به همین شکل دوباره وصل می‌شوند. درخواست‌های موفقی که به اتصال مجدد نیاز داشتند تعدادش را در `x-opencode-reconnects` گزارش می‌کنند (پاسخ‌های استریم نمی‌توانند، چون هدرهای SSE اول فرستاده می‌شوند). فهرست مدل‌ها و نسخه‌ی CLI هم هنگام قطعی به مقادیر کش‌شده برمی‌گردند، پس شبکه‌ی قطع هرگز به معلق‌ماندن تبدیل نمی‌شود.

سایر رفتارهای دفاعی:

- **استریم‌هایی که بدون نقطه‌ی پایان تمام می‌شوند** یک توقف سنتزشده می‌گیرند (از مسیر محافظ پاسخ خالی می‌گذرد، پس پاسخِ فقط-استدلالی هم متن تحویل می‌دهد).
- **خطاهای بالادستی وسط استریم** به‌صورت یک رویداد خطای درست قبل از بسته‌شدن استریم ارسال می‌شوند، نه اینکه زیر رویداد «completed» دفن شوند.
- **درخواست‌های غیراستریمی که با SSE پاسخ می‌گیرند** (و برعکس) به شکل درست تبدیل می‌شوند به‌جای شکست در پارس.
- **فراخوانی‌های ابزارِ نیمه‌کاره در آرگومان‌ها** با آرگومان‌های جزئی‌شان نمایش داده می‌شوند به‌جای ناپدید شدن.
- **فهرست مدل کهنه یا پشتیبان هرگز مدلی را رد نمی‌کند**: شناسه‌های ناشناخته به zen ارسال می‌شوند که مرجع نهایی است.

</details>

<details>
<summary><b>نکات و محدودیت‌ها</b></summary>

- استریم Responses به سقف CPU سخاوتمندی نیاز دارد (`[limits] cpu_ms` در `wrangler.toml` **فقط برای پلن پولی** است — استقرار Free با تنظیمِ آن و خطای 100328 شکست می‌خورد). منتظرماندن برای upstream هیچ CPUای نمی‌گیرد؛ تبدیل هر رویداد می‌گیرد (~۱۲ میکروثانیه بر رویداد)، پس استریم‌های خیلی طولانی ممکن است به بودجه‌ی ۱۰ میلی‌ثانیه‌ای پلن Free نزدیک شوند. در پلن پولی، بلاک `[limits]` را برگردانید.
- فهرست زنده‌ی مدل‌ها ۵ دقیقه کش می‌شود؛ یک فهرست پشتیبانِ ثابت، `/v1/models` و مسیریابی را حتی هنگام اختلال در اندپوینت فهرست zen زنده نگه می‌دارد.
- مقدار `cost` برگشتی از zen عیناً عبور داده می‌شود (فیلد `cost` در chat completions، `usage.cost` در responses).

</details>

<details>
<summary><b>ساختار مخزن و توسعه</b></summary>

```
src/index.ts          router, CORS, auth extraction, /v1/models
src/pipeline.ts       completion pipeline (parse → route → call → convert)
src/canonical.ts      canonical request/response/event model
src/parse/requests.ts inbound: chat-completions / messages / responses → canonical
src/parse/streams.ts  upstream SSE (4 dialects) → canonical events
src/build/zen.ts      canonical → zen native bodies (4 dialects)
src/build/streams.ts  canonical events → 3 public SSE formats
src/build/responses.ts upstream JSON → canonical → 3 public formats
src/zen.ts            zen client: headers/identity, endpoint routing, model list
src/version.ts        auto-updating CLI version (npm → github → fallback)
test/convert.test.ts  unit tests (vitest)
```

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run dev         # wrangler dev
```

</details>

</div>
