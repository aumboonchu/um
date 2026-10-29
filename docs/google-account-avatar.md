# รูปบัญชี Google

รูปโปรไฟล์ Google แสดงแทนไอคอนบัญชีมุมขวาบนในหน้าซื้อสินค้า รายงาน และสินค้า รวมถึงหน้าบัญชี โดยคงปุ่มวงกลมขนาดเดิมและชื่อสำหรับโปรแกรมอ่านหน้าจอ “บัญชี”

## การรับและเก็บข้อมูล

- ใช้ `picture` จาก Google ID token หลังตรวจลายเซ็น issuer, audience และ nonce ตามระบบเดิมแล้วเท่านั้น
- ใช้ scopes เดิม `openid email profile` ไม่เพิ่มสิทธิ์ และไม่ใช้รูปหรืออีเมลเป็นตัวระบุบัญชี
- เก็บเฉพาะ URL ที่เป็น HTTPS บน Google image CDN ใน `users.avatar_url` ไม่ดาวน์โหลดไฟล์ภาพมาเก็บใน D1 และไม่เพิ่ม Google access/refresh token storage
- `/auth/me` ส่ง `account.avatarUrl` สำหรับบัญชีที่ยืนยัน session แล้ว โดยยังใช้ `Cache-Control: no-store`
- URL รูปต้องไม่มี credentials, port ที่ไม่ใช่มาตรฐาน หรือ control characters และยาวไม่เกิน 2048 อักขระ
- เบราว์เซอร์โหลดรูปจาก Google CDN โดยตรงด้วย `referrerPolicy="no-referrer"` ไม่แนบ SmartCart bearer token ไปกับคำขอรูป
- ไม่มีรูป URL ไม่รองรับ หรือโหลดไม่สำเร็จ: แสดงไอคอนเดิม การเข้าสู่ระบบยังทำงานได้
- อัปเดตรูปเมื่อเข้าสู่ระบบ Google ครั้งถัดไป ไม่สร้างผู้ใช้ใหม่ และไม่เพิกถอน session เดิม

อ้างอิง: [Google OpenID Connect — picture claim](https://developers.google.com/identity/openid-connect/openid-connect#obtainuserinfo) เป็นข้อมูล optional และไม่รับประกันว่าจะมีทุกบัญชี

## บัญชีที่เข้าสู่ระบบไว้ก่อนอัปเดต

ยังไม่มี URL รูปเก็บไว้ เพราะรุ่นเดิมไม่ได้บันทึก `picture` จึงแสดงไอคอนไปก่อน ใช้ **บัญชี → การเข้าสู่ระบบ → อัปเดตรูป Google** หนึ่งครั้ง แล้วเลือกบัญชีเดิมเพื่อรับรูป ไม่ต้องกดออกจากระบบ ล้างข้อมูลเว็บ หรือกรอกรหัสผ่าน SmartCart ใหม่ ระบบจดจำเครื่องและข้อมูล offline ตามเดิม

## Migration และการทดสอบ

- `0008_google_avatar.sql` เพิ่ม nullable column เท่านั้น ไม่ลบหรือแก้ไขบัญชี/session/รายการซื้อเดิม
- ต้อง apply migration ก่อน deploy Worker ที่ SELECT column ใหม่ โค้ด Worker รุ่นก่อนหน้ายังคงทำงานกับ schema ที่เพิ่ม column ได้
- ทดสอบ callback ด้วย JWT ที่ลงลายเซ็นในเครื่อง การสร้างผู้ใช้ครั้งแรก การอัปเดตรูปบนบัญชีเดิม การปฏิเสธ audience ผิดและ callback replay และการไม่มี picture โดยไม่ทำให้ login ล้มเหลว
- ทดสอบ frontend แสดงรูป ขนาดปุ่มเดิม image-error fallback และการสลับบัญชีโดยไม่ค้างรูปเก่า
- ไม่มีการดึงรูปจริงหรือเผยแพร่ URL รูปส่วนตัวของผู้ใช้ใน repository/test fixtures
