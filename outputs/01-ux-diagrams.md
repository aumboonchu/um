# SmartCart PWA — UX Diagrams ลำดับ 1

## 1. ภาพรวม User Flow

```mermaid
flowchart LR
    HOME["Home"] --> SCAN["Scan Barcode"]
    SCAN --> LOOKUP["Product Lookup"]
    LOOKUP --> PURCHASE["Add Purchase"]
    PURCHASE --> SAVE{"บันทึกสำเร็จ?"}
    SAVE -->|"สำเร็จ"| RECEIPT["Receipt Detail"]
    SAVE -->|"ไม่สำเร็จ"| RETRY["แสดง Error และเก็บข้อมูลในฟอร์ม"]
    RETRY --> PURCHASE
    RECEIPT --> HISTORY["History"]
    HISTORY --> RECEIPT
    HOME --> HISTORY
    HOME --> PRODUCTS["Products"]
    PRODUCTS --> PRODUCT_DETAIL["Product Detail"]
    PRODUCT_DETAIL --> PURCHASE
```

## 2. การค้นหาสินค้าด้วย UPC

```mermaid
flowchart TD
    START(["สแกนหรือกรอก UPC"])
    VALID{"รูปแบบ UPC ถูกต้อง?"}
    INVALID["แจ้ง UPC ไม่ถูกต้อง"]
    DB["ค้นหา UPC ในฐานข้อมูล SmartCart"]
    FOUND_DB{"พบสินค้า?"}
    USE_DB["ใช้ข้อมูลจาก SmartCart ทันที"]
    ONLINE{"Online?"}
    BIGC_SEARCH["ค้นหา Big C ด้วย /search?q={UPC}"]
    SEARCH_RESULT{"พบผลลัพธ์ UPC ตรงกัน?"}
    DETAIL["เปิดหน้ารายละเอียดสินค้า"]
    JSONLD["อ่าน Product JSON-LD"]
    DOM["เติมข้อมูลที่ขาดจาก DOM"]
    NORMALIZE["Normalize ข้อมูลสินค้า"]
    STORE["บันทึกลงฐานข้อมูล SmartCart"]
    MANUAL["เปิด Add Product แบบกรอกเอง"]
    ADD_PURCHASE["เปิด Add Purchase"]

    START --> VALID
    VALID -->|"ไม่ถูกต้อง"| INVALID
    INVALID --> START
    VALID -->|"ถูกต้อง"| DB
    DB --> FOUND_DB
    FOUND_DB -->|"พบ"| USE_DB
    USE_DB --> ADD_PURCHASE
    FOUND_DB -->|"ไม่พบ"| ONLINE
    ONLINE -->|"Offline"| MANUAL
    ONLINE -->|"Online"| BIGC_SEARCH
    BIGC_SEARCH --> SEARCH_RESULT
    SEARCH_RESULT -->|"ไม่พบ / Error / Timeout"| MANUAL
    SEARCH_RESULT -->|"พบ"| DETAIL
    DETAIL --> JSONLD
    JSONLD --> DOM
    DOM --> NORMALIZE
    NORMALIZE --> STORE
    STORE --> ADD_PURCHASE
    MANUAL --> STORE
```

## 3. แหล่งข้อมูลและลำดับความน่าเชื่อถือ

```mermaid
flowchart TB
    USER["1. ข้อมูลที่ผู้ใช้ยืนยันหรือแก้ไข"]
    SMARTCART["2. ข้อมูลในฐานข้อมูล SmartCart"]
    JSONLD["3. JSON-LD จาก Big C Product Detail"]
    DOM["4. DOM จาก Big C Product Detail"]
    SEARCH["5. Big C Search Result"]
    FINAL["ข้อมูลสินค้าที่แสดงใน SmartCart"]

    SEARCH --> DOM
    DOM --> JSONLD
    JSONLD --> SMARTCART
    SMARTCART --> USER
    USER --> FINAL
```

> ข้อมูลที่ผู้ใช้แก้ไขต้องไม่ถูกการ refresh จาก Big C เขียนทับโดยอัตโนมัติ

## 4. Product Lookup State

```mermaid
stateDiagram-v2
    [*] --> CameraPermission
    CameraPermission --> CameraReady: "อนุญาต"
    CameraPermission --> PermissionDenied: "ปฏิเสธ"
    PermissionDenied --> ManualEntry: "กรอก UPC เอง"
    CameraReady --> Scanning
    Scanning --> InvalidBarcode: "UPC ไม่ถูกต้อง"
    InvalidBarcode --> Scanning: "ลองใหม่"
    Scanning --> LookupSmartCart: "อ่านสำเร็จ"
    ManualEntry --> LookupSmartCart: "ยืนยัน UPC"
    LookupSmartCart --> ProductFound: "พบใน SmartCart"
    LookupSmartCart --> LookupBigC: "ยังไม่มีสินค้า"
    LookupBigC --> ProductImported: "พบใน Big C"
    LookupBigC --> ManualProduct: "ไม่พบ / Error / Offline"
    ProductImported --> ProductFound
    ManualProduct --> ProductFound: "บันทึกสินค้า"
    ProductFound --> AddPurchase
    AddPurchase --> [*]
```

## 5. Add Purchase Flow

```mermaid
flowchart TD
    PRODUCT["รับข้อมูลสินค้า"] --> PREFILL["กรอกข้อมูลสินค้าอัตโนมัติ"]
    PREFILL --> SOURCE{"แหล่งข้อมูล"}
    SOURCE -->|"SmartCart"| LABEL_DB["แสดง: พบในฐานข้อมูล SmartCart"]
    SOURCE -->|"Big C"| LABEL_BIGC["แสดง: นำเข้าข้อมูลจาก Big C"]
    SOURCE -->|"ผู้ใช้กรอก"| LABEL_USER["แสดง: ข้อมูลที่ผู้ใช้เพิ่ม"]

    LABEL_DB --> FORM
    LABEL_BIGC --> FORM
    LABEL_USER --> FORM

    FORM["ผู้ใช้ยืนยันราคา จำนวน ร้านค้า วันที่ และหมายเหตุ"]
    FORM --> CALCULATE["คำนวณยอดรวมทันที"]
    CALCULATE --> VALIDATE{"ข้อมูลผ่าน Validation?"}
    VALIDATE -->|"ไม่ผ่าน"| ERRORS["แสดง Error ราย Field และ Disable ปุ่มบันทึก"]
    ERRORS --> FORM
    VALIDATE -->|"ผ่าน"| ENABLE["Enable ปุ่มบันทึก"]
    ENABLE --> SUBMIT["Loading และป้องกันการกดซ้ำ"]
    SUBMIT --> RESULT{"ผลการบันทึก"}
    RESULT -->|"สำเร็จ"| SUCCESS["เปิด Receipt Detail หรือ History"]
    RESULT -->|"ไม่สำเร็จ"| SAVE_ERROR["เก็บข้อมูลในฟอร์มและให้ลองใหม่"]
    SAVE_ERROR --> SUBMIT
```

## 6. Add Purchase Field Mapping

```mermaid
flowchart LR
    subgraph AUTO["กรอกอัตโนมัติ"]
        IMAGE["รูปสินค้า"]
        NAME["ชื่อสินค้า"]
        BRAND["แบรนด์"]
        SIZE["ขนาดบรรจุ / หน่วยขาย"]
        CATEGORY["หมวดหมู่"]
        UPC["UPC"]
        REF_PRICE["ราคาอ้างอิง Big C"]
        SOURCE_DATE["แหล่งข้อมูล / วันที่อัปเดต"]
    end

    subgraph USER["ผู้ใช้ยืนยันหรือกรอก"]
        ACTUAL_PRICE["ราคาที่ซื้อจริง"]
        QUANTITY["จำนวน"]
        STORE["ร้านค้า"]
        DATE["วันที่และเวลา"]
        NOTE["หมายเหตุ"]
    end

    AUTO --> FORM["Add Purchase"]
    USER --> FORM
    ACTUAL_PRICE --> TOTAL["ยอดรวม = ราคาจริง × จำนวน"]
    QUANTITY --> TOTAL
    TOTAL --> FORM
```

## 7. Screen Navigation

```mermaid
flowchart TD
    NAV["Bottom Navigation"]
    NAV --> HOME["Home"]
    NAV --> HISTORY["History"]
    NAV --> PRODUCTS["Products"]

    HOME --> SCAN["Scan Barcode"]
    HOME --> RECENT["รายการซื้อล่าสุด"]
    RECENT --> RECEIPT["Receipt Detail"]

    SCAN --> ADD["Add Purchase"]
    ADD --> RECEIPT

    HISTORY --> SEARCH_HISTORY["Search / Filter"]
    HISTORY --> RECEIPT
    RECEIPT --> EDIT["Edit Purchase"]
    EDIT --> RECEIPT
    RECEIPT --> DELETE{"ยืนยันการลบ?"}
    DELETE -->|"ลบ"| HISTORY
    DELETE -->|"ยกเลิก"| RECEIPT

    PRODUCTS --> SEARCH_PRODUCT["ค้นหาชื่อหรือ UPC"]
    PRODUCTS --> PRODUCT_DETAIL["Product Detail"]
    PRODUCT_DETAIL --> REFRESH["Refresh จาก Big C"]
    PRODUCT_DETAIL --> ADD
```

## 8. Error และ Fallback Flow

```mermaid
flowchart TD
    ERROR{"เหตุการณ์ผิดพลาด"}
    ERROR -->|"UPC ไม่ถูกต้อง"| INVALID["แจ้งเตือนและสแกน/กรอกใหม่"]
    ERROR -->|"Big C ไม่พบสินค้า"| MANUAL["Add Product แบบกรอกเอง"]
    ERROR -->|"Big C Timeout หรือ Error"| RETRY["ลองใหม่ หรือกรอกเอง"]
    ERROR -->|"พบหลายรายการ"| SELECT["ให้ผู้ใช้เลือกสินค้าที่ตรง"]
    ERROR -->|"UPC จาก Big C ไม่ตรง"| REVIEW["ไม่บันทึกอัตโนมัติและให้ตรวจสอบ"]
    ERROR -->|"รูปโหลดไม่ได้"| PLACEHOLDER["ใช้ Product Placeholder"]
    ERROR -->|"บันทึก Purchase ไม่สำเร็จ"| KEEP_FORM["เก็บข้อมูลเดิมและให้ลองใหม่"]
    ERROR -->|"Offline"| LOCAL["ใช้ข้อมูลในเครื่องและเข้าคิว Sync"]
    ERROR -->|"ข้อมูล Big C เปลี่ยน"| PROTECT["เก็บเวลาและไม่เขียนทับ User Override"]
```

## 9. Local-first และ Sync

```mermaid
sequenceDiagram
    actor User as "ผู้ใช้"
    participant App as "SmartCart PWA"
    participant Local as "Local Database"
    participant Backend as "SmartCart Backend"
    participant BigC as "Big C"

    User->>App: "สแกน UPC"
    App->>Local: "ค้นหา UPC"

    alt "พบใน Local Database"
        Local-->>App: "ข้อมูลสินค้า"
    else "ไม่พบและ Online"
        App->>BigC: "ค้นหาด้วย UPC"
        BigC-->>App: "ข้อมูลสินค้า"
        App->>Local: "บันทึกสินค้า"
    else "ไม่พบและ Offline"
        App-->>User: "ให้กรอกข้อมูลสินค้าเอง"
        User->>App: "ข้อมูลสินค้า"
        App->>Local: "บันทึกสินค้า"
    end

    App-->>User: "แสดง Add Purchase"
    User->>App: "ยืนยันราคาจริงและจำนวน"
    App->>Local: "บันทึก Purchase"

    opt "มี Backend และกลับมา Online"
        Local->>Backend: "Sync รายการที่รออยู่"
        Backend-->>Local: "ยืนยัน Sync"
    end
```

## 10. Data Relationship

```mermaid
erDiagram
    PRODUCT ||--o{ PURCHASE : "ถูกซื้อใน"
    STORE ||--o{ PURCHASE : "เป็นสถานที่ซื้อ"
    PRODUCT ||--o{ PRODUCT_SOURCE_SNAPSHOT : "มีข้อมูลอ้างอิง"

    PRODUCT {
        string id PK
        string upc UK
        string name
        string brand
        string package_size
        string unit
        string category
        string image_url
        json user_overrides
        datetime created_at
        datetime updated_at
    }

    PRODUCT_SOURCE_SNAPSHOT {
        string id PK
        string product_id FK
        string source
        string source_product_id
        string source_url
        decimal source_price
        decimal source_regular_price
        string availability
        datetime promotion_ends_at
        datetime fetched_at
    }

    PURCHASE {
        string id PK
        string product_id FK
        string store_id FK
        decimal actual_unit_price
        decimal quantity
        decimal total
        datetime purchased_at
        string note
        datetime created_at
        datetime updated_at
    }

    STORE {
        string id PK
        string name
        datetime created_at
        datetime updated_at
    }
```

## 11. Definition of Done สำหรับลำดับ 1

```mermaid
flowchart LR
    A["กำหนดหน้าจอครบ"] --> B["กำหนด States ครบ"]
    B --> C["กำหนด SmartCart-first Lookup"]
    C --> D["กำหนด Big C Import"]
    D --> E["กำหนด Manual Fallback"]
    E --> F["กำหนด Validation"]
    F --> G["กำหนด Error / Offline"]
    G --> H["กำหนด Data Model"]
    H --> DONE(["พร้อมเข้าสู่ลำดับ 2: Figma Design System"])
```

