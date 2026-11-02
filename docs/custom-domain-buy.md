# SmartCart — https://aumboonchu.com/buy/

## สถาปัตยกรรม

- `/buy/` ใช้ Worker `smartcart-buy` เสิร์ฟชุดไฟล์ Vite จาก ASSETS binding ไม่ proxy HTML หรือข้อมูลส่วนตัวของ Area
- Route `aumboonchu.com/buy*` ครอบคลุม `/buy?query` ด้วย แต่ handler ยอมรับเฉพาะ `/buy` และ `/buy/…`; `/buyer` และ `/buy-other` ส่งต่อไป origin เดิมโดยไม่เปลี่ยนคำขอ/คำตอบ
- `/buy` และ `/buy/index.html` redirect แบบ 308 ไป `/buy/` โดยคง query; unknown assets ตอบ 404 ไม่ fallback เป็นเว็บ Area หรือหน้า login
- API และ D1 เดิม รองรับ exact frontend URL สองรายการ: `https://aumboonchu.github.io/um/` และ `https://aumboonchu.com/buy/` ไม่มี wildcard origin/path
- Google OAuth callback คงเดิม `https://smartcart-api-staging.jib-inventory.workers.dev/auth/google/callback`; transaction เก็บ return URL ที่ผ่าน allowlist และ PKCE/state/nonce/one-time handoff คงเดิม

## DNS และการรักษา Area

Domain owner อนุญาตให้ปรับการเชื่อมต่อโดเมนหลักโดยคงเว็บ Area และสิทธิ์เดิม พร้อมย้อนคืนหากตรวจไม่ผ่าน

สถานะก่อนเปลี่ยน: zone `39d064d3b940534bdd382f9d72042a49`, account `eeec93d3b1a9ffc9d1f08bcfe3083e4b`; apex A สองรายการ `162.159.143.30` และ `172.66.3.26`, DNS only; ไม่มี Worker routes; verification TXT สองรายการต้องคงไว้

การแยก Worker route จาก Sites SaaS origin ต้องใช้ proxied CNAME ไป `custom-domains.chatgpt.site` (O2O) ไม่ใช่เปิด proxy บน A ที่ชี้ Cloudflare IP ซึ่งเสี่ยง Error 1000

หลังเปลี่ยนต้องตรวจ Area root ยังคง HTTP 401 `Log in to access`, เส้นทาง ChatGPT sign-in และ public sign-in CSS/image ยังตอบ 200; `/buyer` ต้องยังเป็น Area; `/buy/` ต้องตอบ SmartCart HTML และไฟล์ JS/CSS/fonts/manifest/SW ต้องโหลดได้ หากตรวจไม่ผ่านให้คืน CNAME เป็น apex A สองค่าเดิมแบบ DNS only โดยไม่แก้ TXT หรือสิทธิ์ของ Sites

ไม่แก้ source, audience, database, ownership หรือ authentication ของ Area และไม่สร้าง Worker custom domain สำหรับทั้ง apex (ใช้เพียง path route)

## ข้อมูลและออฟไลน์

URL เดิมยังทำงาน ไม่ auto-redirect และไม่ล้าง IndexedDB/เซสชัน/คำขอค้างของ origin เดิม ผู้ใช้ต้องซิงก์ข้อมูลค้างจาก URL เดิมก่อน; โดเมนใหม่ต้อง login และอนุญาตกล้องใหม่ครั้งแรก อาจต้องติดตั้ง PWA ใหม่ด้วย

Service worker ใช้ scope `/buy/` และไม่ intercept/cache คำขอของ Area ที่อยู่นอก scope; manifest ใช้ relative start_url/scope และ `display: standalone`

ทุก path บน `aumboonchu.com` ยังแชร์ browser origin storage กัน `/buy/` ไม่ใช่ขอบเขตความปลอดภัย จึงต้องเชื่อถือ code ของแอปอื่นบน origin เดียวกัน ห้ามเพิ่ม third-party code ที่ไม่เชื่อถือหรือเก็บข้อมูลลับไว้ใน URL เพื่อย้ายข้าม origin

## Build และ deploy

```text
npm run types:buy
npm run typecheck
npm test
npm run build:buy
npm run check:buy
npm run deploy:buy
```

`build:buy` สร้าง `apps/web/dist-buy` แยกจาก `dist` ของ GitHub Pages โดยตรึง API origin เดิมและ base `/buy/` ส่วน `deploy:buy` สร้างชุดใหม่ก่อนอัปโหลดเสมอ

CI ตรวจ build/package เพิ่ม แต่ GitHub Pages ยังเผยแพร่ `/um/` ตามเดิม การอัปเดต `/buy/` ใช้ CLI ด้านบน หรือ workflow `Deploy custom domain frontend` แบบสั่งรันเมื่อมี `CLOUDFLARE_API_TOKEN` ที่เหมาะสมใน GitHub Secrets; ไม่ได้สร้าง/อ่าน/คัดลอก token ให้อัตโนมัติ

Generated `deploy/buy/worker-configuration.d.ts` และ build artifacts ไม่เก็บใน source; สร้าง binding types จาก Wrangler ก่อน typecheck เสมอ

## ทดสอบ

ทดสอบ mount/canonical redirect/query/method/HEAD/cache/MIME/preview recursion/passthrough/SW scope และ API allowlist/CORS/mandatory Origin/OAuth success+cancel+failure ที่กลับ frontend ต้นทาง พร้อมชุดเดิมทั้งหมด ไม่มีการแก้สินค้าหรือสร้างรายการซื้อจริงเพื่อ QA

ตรวจ live แบบไม่อ่านบัญชี/ประวัติจริงได้ด้วย `node work/verify-buy-live.mjs`; ก่อนเปลี่ยน DNS ใช้ `--baseline`

อ้างอิง: [Cloudflare O2O](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/how-it-works/), [Workers compatibility](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/product-compatibility/), [Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/), [ASSETS binding](https://developers.cloudflare.com/workers/static-assets/binding/), [Error 1000](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1000/)
