# แก้การเตรียม JPEG และข้อความบันทึกรูปไม่สำเร็จ

## เปลี่ยนอะไร

รูปที่ครอปใหม่จะตัด EXIF/XMP, Photoshop metadata และ comment segments ก่อนคำนวณ SHA-256 และก่อนเก็บคำขอที่ยืนยันแล้ว คงเนื้อรูป JFIF resolution, ICC color profile และ color-transform segments ไว้ ไม่วาดหรือบีบอัดซ้ำในขั้นตอนนี้

ฝั่ง API ยังคงตรวจโครงสร้าง JPEG ขนาด 16–640 px, ขนาดไฟล์ไม่เกิน 128 KiB และ hash รวมทั้งยังปฏิเสธข้อมูลเสริมส่วนที่ไม่อนุญาต ไม่ใช่การเปิดให้ทุกไฟล์ผ่าน

ข้อความเดิม “รูปยังไม่ถูกต้อง กรุณาครอปใหม่” ถูกแทนด้วยเหตุผลเกี่ยวกับไฟล์ เช่น metadata, ขนาด, ข้อมูลส่งไม่ครบ, hash ไม่ตรง หรือโครงสร้าง JPEG พร้อมรหัสที่ปลอดภัย ไม่แสดงภาพ ชื่อไฟล์หรือข้อความจาก provider ในรายละเอียด error

## เหตุผล

ไม่ควรถือว่า JPEG จาก canvas ไม่มี metadata เสมอ มาตรฐานระบุเรื่อง resolution metadata และ color profile ตามรูปแบบที่รองรับ: [WHATWG bitmap serialization](https://html.spec.whatwg.org/multipage/canvas.html#serialising-bitmaps-to-a-file) และ WebKit อธิบายการฝัง color profile ใน JPEG ที่ serialize จาก canvas: [WebKit Canvas serialization](https://webkit.org/blog/12058/wide-gamut-2d-graphics-using-html-canvas/)

พบช่องโหว่ความเข้ากันได้ในโค้ดเดิมและสร้างการทดสอบซ้ำได้ แต่ไม่มีไฟล์ JPEG ที่โทรศัพท์ผู้ใช้ส่งแล้วถูกปฏิเสธให้ตรวจ จึงยังไม่ยืนยันว่า metadata เป็นสาเหตุเฉพาะของภาพแจ้งปัญหานั้น และไม่อ้างว่าได้ทดสอบ iPhone จริง

## วิธีลองหลังอัปเดต

รีเฟรช SmartCart → เข้า admin → เปิดสินค้าเดิม → เลือกภาพเดิมอีกครั้ง → ครอป → ใช้รูปที่ครอป

ต้องสร้าง crop ใหม่เพื่อผ่านขั้นตอนเตรียมไฟล์รุ่นใหม่ ไม่ต้องสร้าง SKU ใหม่หรือกรอกรายละเอียดสินค้าซ้ำ หากยังมีคำขอรอยืนยันให้ตรวจด้วย UUID เดิมก่อน ไม่ล้างข้อมูลเว็บหรือส่งแทนด้วย UUID ใหม่เอง

## ไม่เปลี่ยนข้อมูลเดิม

- ไม่เปลี่ยนข้อมูลสินค้าหรือรูปที่บันทึกแล้ว ไม่ย้ายหรือลบฐานข้อมูล
- ไม่แก้ payload/hash ของ UUID ที่ส่งแล้วหรือรอผล คำขอเก่ายังคงตรวจด้วยข้อมูลเดิม
- ผลที่ยังไม่แน่นอน เช่น auth/network/คำตอบผิดรูปแบบ ไม่ถูกถือว่าเป็นความล้มเหลวแน่นอนและไม่ทิ้ง UUID
- เหตุผลจาก server ผ่าน whitelist เท่านั้น ไม่ใช้ข้อความ arbitrary จาก response
- ไม่มี schema migration, บริการเสียเงินใหม่ หรือการเปลี่ยน Google/admin credentials

## ทดสอบ

ใช้ JPEG สีพื้น 32×32 ที่เข้ารหัสจริงในเครื่อง ไม่ใช่ภาพผู้ใช้ เพิ่ม metadata จำลองให้พิสูจน์ว่า API เดิมปฏิเสธ → ตัด metadata ก่อน hash → API ยอมรับ และ bytes ส่วนภาพกลับมาตรงต้นฉบับทุกไบต์

ทดสอบ JFIF/ICC preservation, metadata ระหว่าง scans, stuffing/restart markers, malformed lengths, hash/dimensions, ข้อความ error, strict status/reason pairs, UUID recovery และระบบเดิมทั้งหมด
