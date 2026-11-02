import { Icon } from './ui'

export function MissingProductGuide({ online, disabled, onImage, onManual }: { online: boolean; disabled: boolean; onImage: () => void; onManual: () => void }) {
  return <div className="missing-product-guide">
    <p className="muted">เพิ่มครั้งแรก ครั้งต่อไปสแกนได้เลย</p>
    <ol className="product-guide-steps">
      <li><div><h2>เตรียมข้อมูลสินค้า</h2><p>แคปหน้าสินค้า Big C / Makro Pro ให้เห็นชื่อ ขนาด และราคา หรือกรอกข้อมูลเอง</p><p className="small-text">ตัดข้อมูลส่วนตัวออกก่อนส่งรูป</p></div></li>
      <li><div><h2>ตรวจแล้วบันทึก</h2><p>เช็กชื่อ ขนาด และบาร์โค้ด ถ้าใส่รูปให้ครอปเฉพาะสินค้า</p><p className="small-text">รหัสร้านไม่ใช่ UPC / EAN</p></div></li>
      <li><div><h2>ใส่จำนวนและราคาจริง</h2><p>กด “เพิ่มเข้ารอบ” แล้วสแกนชิ้นต่อไป</p><p className="small-text">ราคาในภาพใช้อ้างอิง ยังไม่ใช่ยอดซื้อ</p></div></li>
    </ol>
    {!online ? <p role="status" className="pending-caption">อ่านวิธีใช้ได้ เชื่อมต่ออินเทอร์เน็ตก่อนเพิ่มสินค้า</p> : null}
    <div className="page-actions">
      <button type="button" className="primary-button" disabled={disabled || !online} onClick={onImage}>เพิ่มจากรูป</button>
      <button type="button" className="secondary-button" disabled={disabled} onClick={onManual}><Icon name="barcode" />กรอกข้อมูลเอง</button>
    </div>
  </div>
}
