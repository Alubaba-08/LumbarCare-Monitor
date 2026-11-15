# ErgoCushion – คู่มือติดตั้งและทดสอบ

โปรเจกต์นี้ต่อยอดจากโปรเจกต์เดิมของคุณ โดยยังใช้ **Node.js + Express + SerialPort + WebSocket + SQLite** และเก็บฐานข้อมูลเดิม `cushion_data.db` ไว้ ไม่ย้ายไป PostgreSQL

## โครงสร้างไฟล์

- `index.html` – Dashboard แสดง FSR 4 จุด, เปรียบเทียบแรงกดซ้าย/ขวา, กราฟสด และประวัติ
- `server.js` – อ่าน Serial จาก ESP32, ส่งข้อมูลผ่าน WebSocket และบันทึก SQLite
- `cushion_data.db` – ฐานข้อมูลเดิมพร้อมประวัติที่มีอยู่
- `esp32/Seat_Cushion.ino` – Firmware สำหรับ ESP32
- `package.json`, `package-lock.json` – Dependencies เดิมของโปรเจกต์

## 1) เปิดโปรเจกต์

แตก ZIP แล้วเปิด Terminal ในโฟลเดอร์เดียวกับ `server.js` จากนั้นรัน:

```powershell
npm install
npm start
```

เปิด `http://localhost:3000`

ถ้า `node_modules` เดิมยังอยู่และใช้ได้ อาจไม่ต้อง `npm install` ใหม่

## 2) ตั้งค่า COM Port

ค่าเริ่มต้นใน `server.js` คือ `COM4` หาก ESP32 เป็นพอร์ตอื่น ให้แก้บรรทัด:

```js
const SERIAL_PORT_NAME = process.env.SERIAL_PORT || 'COM4';
```

หรือกำหนดก่อนเริ่ม server ใน PowerShell เช่น:

```powershell
$env:SERIAL_PORT="COM5"
npm start
```

ปิด Arduino IDE Serial Monitor/Serial Plotter ก่อนเปิด server เพราะพอร์ต Serial ใช้พร้อมกันสองโปรแกรมไม่ได้

ตรวจพอร์ตที่ระบบมองเห็นได้ที่ `http://localhost:3000/api/serial-ports`

## 3) อัปโหลด Firmware

เปิดไฟล์ `esp32/Seat_Cushion.ino` ใน Arduino IDE เลือกบอร์ด ESP32 และ COM Port ให้ถูกต้อง แล้ว Upload

**สำคัญ:** เมื่อ `TARE_ON_BOOT = true` ต้องไม่มีแรงกดบน FSR ทั้ง 4 จุดในช่วงเริ่มเปิดเครื่อง เพราะระบบใช้ช่วงนี้เก็บ baseline ของเบาะว่าง หลัง Upload แล้วเปิด Serial Monitor เพื่อดูข้อมูลได้ แต่ต้องปิด Serial Monitor ก่อนสตาร์ต `npm start`

Pin mapping ที่ใช้ในโค้ด:

| Sensor | ESP32 GPIO | ตำแหน่ง |
|---|---:|---|
| FSR1 | 32 | ก้นซ้าย |
| FSR2 | 33 | ก้นขวา |
| FSR3 | 34 | หลังล่างซ้าย |
| FSR4 | 35 | หลังล่างขวา |
| AD8232 OUTPUT | 36 | ค่า Analog ดิบ |
| Buzzer | 14 | แจ้งเตือนจาก ESP32 |

## 4) เปิดดู SQLite ใน DBeaver

เลือก **New Database Connection → SQLite** แล้วเลือกไฟล์ `cushion_data.db` ที่อยู่ในโฟลเดอร์โปรเจกต์นี้ จากนั้นเปิด SQL Editor และใช้:

```sql
SELECT *
FROM sensor_logs
ORDER BY id DESC
LIMIT 100;
```

เมื่อเริ่ม server จะเพิ่มคอลัมน์ `ad8232_raw` หากยังไม่มี โดยไม่ลบประวัติเก่า และยังคง `emg` ไว้เพื่อความเข้ากันได้กับข้อมูลเก่า (แถวใหม่จะใส่ `ad8232_raw` และเว้น `emg` ว่าง)

## 5) ทดสอบการทำงาน

1. ปิด Arduino Serial Monitor
2. ตรวจสอบ COM Port และแก้ `SERIAL_PORT_NAME` ให้ถูกต้อง
3. รัน `npm start`
4. เปิด Dashboard แล้วดูสถานะ ESP32 ด้านขวาบน
5. กด/ปล่อย FSR ทีละจุดและตรวจว่า ADC ของจุดนั้นเปลี่ยนตาม
6. เปิดแท็บ Analytics แล้วดูแถวใหม่ในตาราง
7. เปิด DBeaver แล้ว Refresh ตาราง `sensor_logs`

API สำหรับตรวจสอบ:

- `/api/health` – สถานะ server/database
- `/api/status` – สถานะ Serial และข้อมูลล่าสุด
- `/api/serial-ports` – รายชื่อ Serial Port
- `/api/logs/latest` – ข้อมูลล่าสุด
- `/api/stats/daily` – สถิติวันนี้จาก SQLite
- `/api/logs/export.csv` – ดาวน์โหลด CSV จากข้อมูลจริงทั้งหมด

## 6) หมายเหตุการอ่านค่าและความปลอดภัย

- หน้าเว็บแสดงค่า FSR เป็น **ADC raw หลังหัก baseline** และสัดส่วนของแรงกดซ้าย/ขวาในแต่ละคู่ ไม่ใช่หน่วย Newton จนกว่าจะคาลิเบรตด้วยน้ำหนักอ้างอิง
- ค่า balance 100% หมายถึงค่าจาก FSR ซ้ายและขวาใกล้เคียงกันในเชิงตัวเลข ไม่ได้แปลว่าท่าทางถูกต้องทางการแพทย์
- SparkFun AD8232 เป็น ECG analog front-end ไม่ใช่โมดูล sEMG ที่ยืนยันการวัดกล้ามเนื้อหลังได้ หน้าเว็บจึงบันทึก `ad8232_raw` เป็นค่า ADC เฉลี่ยดิบประมาณ 10 Hz และไม่แปลงเป็นเปอร์เซ็นต์ความเกร็งหรือแสดงเป็นคลื่น ECG เพื่อการวินิจฉัย
- Firmware ฉบับนี้ไม่นำ AD8232 ไปตัดสินว่ากล้ามเนื้อหลังเกร็ง เพราะอาจทำให้แจ้งเตือนผิดพลาด
- **ห้ามติด Electrode กับร่างกายขณะบอร์ดเชื่อมต่อ USB/คอมพิวเตอร์หรือแหล่งจ่ายไฟที่ต่อกับไฟบ้าน** จนกว่าจะมีการออกแบบและตรวจสอบระบบแยกทางไฟฟ้าเพื่อความปลอดภัยโดยผู้เชี่ยวชาญ

## 7) สิ่งที่ต้องตรวจสอบจากฮาร์ดแวร์

ฐานข้อมูลเดิม 1,000 แถวล่าสุดพบว่า FSR2 (`fsr_seat_r`) เป็น 0 ทั้งหมด และ FSR3 (`fsr_back_l`) เคยอ่านได้ถึง 3833 จากช่วง ADC 0–4095 จึงควรทดสอบ FSR ทีละตัวและตรวจ wiring/pin mapping/วงจรแบ่งแรงดันก่อนใช้เปรียบเทียบสมดุลจริง ซอฟต์แวร์ไม่สามารถแก้การต่อสายหรือเซนเซอร์ที่อ่านค่าอิ่มตัวได้

ค่า `SITTING_THRESHOLD = 60` และ `IMBALANCE_PERCENT_THRESHOLD = 25` เป็นค่าตั้งต้นสำหรับต้นแบบ ต้องปรับด้วยผลการคาลิเบรตและการทดลองจริง ไม่ใช่เกณฑ์วินิจฉัยโรค
