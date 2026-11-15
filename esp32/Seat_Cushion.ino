#include <Arduino.h>

// ErgoCushion | ESP32 + FSR x4 + SparkFun AD8232 output capture
// Pin map follows the supplied Seat_Cushion.ino file.
const int PIN_FSR_SEAT_L = 32; // FSR1: ก้นซ้าย
const int PIN_FSR_SEAT_R = 33; // FSR2: ก้นขวา
const int PIN_FSR_BACK_L = 34; // FSR3: หลังล่างซ้าย
const int PIN_FSR_BACK_R = 35; // FSR4: หลังล่างขวา
const int PIN_AD8232_OUT = 36; // AD8232 OUTPUT (ECG module raw analog output)
const int PIN_BUZZER = 14;

// เปิด TARE แล้วต้องไม่มีแรงกดบน FSR ทั้ง 4 จุดในช่วงเริ่มต้นเครื่อง
const bool TARE_ON_BOOT = true;
int baseSeatL = 0, baseSeatR = 0, baseBackL = 0, baseBackR = 0;

// ค่าตั้งต้นสำหรับต้นแบบ ต้องปรับหลังทดสอบและคาลิเบรต FSR แต่ละตัวจริง
const int SITTING_THRESHOLD = 60; // FSR1 + FSR2 หลังหัก baseline
const float IMBALANCE_PERCENT_THRESHOLD = 25.0; // ความต่างเชิงสัดส่วนของ FSR ก้นซ้าย/ขวา
const unsigned long IMBALANCE_ALERT_TIME = 15UL * 60UL * 1000UL;
const unsigned long PROLONGED_SIT_TIME = 30UL * 60UL * 1000UL;
const unsigned long BREAK_RESET_TIME = 60UL * 1000UL;
const unsigned long ALERT_COOLDOWN = 30UL * 1000UL;
const unsigned long SAMPLE_INTERVAL = 100UL; // ~10 Hz สำหรับ FSR และเก็บตัวอย่าง ADC ดิบ

unsigned long sitStartTime = 0;
unsigned long imbalanceStartTime = 0;
unsigned long lastStandMs = 0;
unsigned long lastImbalanceBeep = 0;
unsigned long lastSitBeep = 0;
bool isSitting = false;
bool isImbalanced = false;

int readAverage(int pin) {
  analogRead(pin); // discard first sample after switching ADC channel
  uint32_t total = 0;
  for (int i = 0; i < 8; i++) total += analogRead(pin);
  return static_cast<int>(total / 8);
}

bool canAlert(unsigned long now, unsigned long &lastAlert) {
  if (lastAlert == 0 || now - lastAlert >= ALERT_COOLDOWN) {
    lastAlert = now;
    return true;
  }
  return false;
}

void playBeep(int frequency, int durationMs) {
  tone(PIN_BUZZER, frequency, durationMs);
}

float imbalancePercent(int left, int right) {
  const int total = left + right;
  if (total <= 0) return 0.0;
  return 100.0f * abs(left - right) / total;
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  analogReadResolution(12); // 0–4095
  const int analogPins[] = { PIN_FSR_SEAT_L, PIN_FSR_SEAT_R, PIN_FSR_BACK_L, PIN_FSR_BACK_R, PIN_AD8232_OUT };
  for (int pin : analogPins) analogSetPinAttenuation(pin, ADC_11db);
  pinMode(PIN_BUZZER, OUTPUT);

  if (TARE_ON_BOOT) {
    Serial.println("# TARE: keep all four FSR sensors unloaded");
    delay(1500);
    uint32_t sl = 0, sr = 0, bl = 0, br = 0;
    const int sampleCount = 20;
    for (int i = 0; i < sampleCount; i++) {
      sl += readAverage(PIN_FSR_SEAT_L);
      sr += readAverage(PIN_FSR_SEAT_R);
      bl += readAverage(PIN_FSR_BACK_L);
      br += readAverage(PIN_FSR_BACK_R);
      delay(50);
    }
    baseSeatL = sl / sampleCount;
    baseSeatR = sr / sampleCount;
    baseBackL = bl / sampleCount;
    baseBackR = br / sampleCount;
  }

  Serial.printf("# BASELINE SL=%d SR=%d BL=%d BR=%d\n", baseSeatL, baseSeatR, baseBackL, baseBackR);
  Serial.println("timestamp_ms,fsr_seat_l,fsr_seat_r,fsr_back_l,fsr_back_r,ad8232_raw,status");
}

void loop() {
  const int fsrSeatL = max(0, readAverage(PIN_FSR_SEAT_L) - baseSeatL);
  const int fsrSeatR = max(0, readAverage(PIN_FSR_SEAT_R) - baseSeatR);
  const int fsrBackL = max(0, readAverage(PIN_FSR_BACK_L) - baseBackL);
  const int fsrBackR = max(0, readAverage(PIN_FSR_BACK_R) - baseBackR);
  const int ad8232Raw = readAverage(PIN_AD8232_OUT);

  const unsigned long now = millis();
  const char *status = "NORMAL";
  const bool sittingNow = (fsrSeatL + fsrSeatR) >= SITTING_THRESHOLD;

  if (sittingNow && !isSitting) {
    isSitting = true;
    imbalanceStartTime = now;
    if (lastStandMs == 0 || now - lastStandMs >= BREAK_RESET_TIME) sitStartTime = now;
  } else if (!sittingNow && isSitting) {
    isSitting = false;
    isImbalanced = false;
    lastStandMs = now;
    status = "STOOD_UP";
  }

  if (isSitting) {
    const float imbalance = imbalancePercent(fsrSeatL, fsrSeatR);
    if (imbalance > IMBALANCE_PERCENT_THRESHOLD) {
      if (!isImbalanced) {
        isImbalanced = true;
        imbalanceStartTime = now;
      } else if (now - imbalanceStartTime >= IMBALANCE_ALERT_TIME) {
        status = "ALERT_IMBALANCE";
        if (canAlert(now, lastImbalanceBeep)) playBeep(1200, 350);
      }
    } else {
      isImbalanced = false;
    }

    if (sitStartTime > 0 && now - sitStartTime >= PROLONGED_SIT_TIME) {
      status = "ALERT_PROLONGED_SITTING";
      if (canAlert(now, lastSitBeep)) playBeep(1800, 200);
    }
  }

  // AD8232 output is stored as raw ADC only. Do NOT infer back-muscle EMG tension from it.
  Serial.printf("%lu,%d,%d,%d,%d,%d,%s\n",
                now, fsrSeatL, fsrSeatR, fsrBackL, fsrBackR, ad8232Raw, status);
  delay(SAMPLE_INTERVAL);
}
