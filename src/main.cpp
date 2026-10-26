#include <Arduino.h>
#include <Wire.h>
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <ESP8266mDNS.h>
#include <WiFiUdp.h>
#include <WebSocketsServer.h>
#include <EEPROM.h>
extern "C" {
#include "lwip/etharp.h"
#include "lwip/netif.h"
}
#include <math.h>
#include "GloveMath.h"
#include "GloveCal.h"
#include "GloveRec.h"
#include "viewer_page.h" // generated from web/viewer.html by tools/embed_web.py
const char PAGE[] PROGMEM = R"GLOVEHTML(<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Glove sensor bench</title><style>
:root{font-family:Segoe UI,Arial,sans-serif;color:#20344a;background:#edf2f7;color-scheme:light}*{box-sizing:border-box}body{margin:0}main{max-width:1200px;margin:auto;padding:28px}header{display:flex;justify-content:space-between;gap:16px;align-items:center}h1{font-size:30px;margin:0 0 6px}h2{font-size:20px;margin:0 0 14px}p{line-height:1.5;margin:8px 0}.sub{color:#53677c;font-size:14px}.toolbar{display:flex;flex-wrap:wrap;gap:10px;margin:22px 0}button{font:inherit;background:#fff;color:#20344a;border:1px solid #99acbf;border-radius:6px;padding:10px 15px;cursor:pointer}button:hover{background:#dceaf7}button:focus-visible{outline:3px solid #2270ad;outline-offset:3px}.panel{background:#fff;border:1px solid #d0dbe5;border-radius:10px;padding:20px;margin-bottom:20px}.devices{display:flex;flex-wrap:wrap;gap:10px}.chip{padding:8px 12px;border-radius:6px;background:#eef2f6}.ok{color:#176545}.warn{color:#875400}.bad{color:#a32c35}.sensors{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.sensor{border-top:4px solid var(--accent);background:#fff;padding:18px;border-radius:6px;margin-bottom:4px}.sensor h2{display:flex;justify-content:space-between;align-items:center}.value{font-size:30px;font-variant-numeric:tabular-nums}.unit{font-size:14px;color:#53677c}.track{background:#e8eef4;height:10px;border-radius:6px;margin:12px 0;overflow:hidden}.fill{height:100%;background:var(--accent);width:0}.status{font-size:14px;min-height:40px;margin-top:10px}.trace{display:block;width:100%;height:70px}.motion-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:20px}.motion canvas{width:100%;height:120px;display:block}.readings{font-size:14px;font-variant-numeric:tabular-nums;margin:8px 0}.legend span{margin-right:18px}.x{color:#a84d20}.y{color:#176545}.z{color:#235bb5}#connection{font-weight:600}#message{min-height:22px}#calstate{min-height:22px;font-weight:600;margin-top:6px}#warnings p{margin:4px 0}.offline .value{opacity:.5}footer{font-size:13px;color:#53677c;margin-top:22px;line-height:1.6}@media(max-width:850px){.sensors{grid-template-columns:repeat(2,minmax(0,1fr))}.motion-grid{grid-template-columns:1fr}header{display:block}#connection{margin-top:12px}}@media(max-width:480px){main{padding:16px}.sensors{grid-template-columns:1fr}h1{font-size:25px}}
</style></head><body><main><header><div><h1>Glove sensor bench</h1><div class="sub">Five fingers, force and motion. Live electrical readings. <a href="/">3D hand view</a></div></div><div id="connection" role="status">Connecting...</div></header>
<div class="toolbar"><button id="calibrate">Calibrate at rest (5 s)</button><button id="reset">Reset response tests</button><button id="scan">Scan I²C again</button></div><div id="message" role="status"></div><div id="calstate" role="status"></div><div id="warnings" role="alert"></div>
<section class="panel"><h2>Hardware on the bus</h2><div class="devices" id="devices"></div><p class="sub" id="inventory">Waiting for scan...</p><p class="sub">Expected: 0x48 for thumb–ring; 0x49 for little + force; MPU at 0x68 or 0x69. An ACK confirms an address responds, not the exact chip model.</p></section>
<div class="sensors" id="sensors"></div>
<p class="sub">Bars and traces show voltage (0–3.3 V), not calibrated bend angle or force. With this divider, bending usually lowers flex voltage; pressing raises force voltage. Traces show the last 30 seconds.</p>
<div class="motion-grid" id="motion"></div>
<footer>Detection test: calibrate with the glove at rest (or reset), then bend each finger and press the force sensor separately. “Response observed” records a voltage change since reset; it cannot prove a sensor remains connected. A force sensor at rest and an open wire can both read near 0 V. Check wiring if several channels move together unexpectedly.<br>All supplies and I²C pull-ups must use 3.3 V. ADS1115 input range is set to ±4.096 V, but physical inputs must stay within GND–3.3 V. Motion plots include gravity and show sensor axes, not calibrated hand orientation.</footer></main>
<script>
const $=id=>document.getElementById(id), names=['Thumb','Index','Middle','Ring','Little','Force'], colors=['#2766ad','#53733e','#8e5b94','#2a7984','#9b6436','#ad4f5a'];
const histories=Array.from({length:6},()=>[]), mh=Array.from({length:2},()=>({a:[],g:[]}));
let lastUptime=null;
names.forEach((name,i)=>{const el=document.createElement('section');el.className='sensor';el.style.setProperty('--accent',colors[i]);el.innerHTML=`<h2>${name}<span class="unit">${i===5?'Pressure response':'Flex sensor'}</span></h2><div class="sub" id="map${i}"></div><div class="value"><span id="v${i}">—</span> <span class="unit">V</span></div><div class="track"><div class="fill" id="bar${i}"></div></div><canvas class="trace" id="plot${i}" role="img" aria-label="${name} voltage history, 0 to 3.3 volts"></canvas><div class="sub" id="raw${i}">Waiting for sample</div><div class="sub" id="rest${i}"></div><div class="status" id="s${i}">Checking...</div>`;$('sensors').appendChild(el)});
for(let i=0;i<2;i++){const el=document.createElement('section');el.className='panel motion';el.innerHTML=`<h2 id="mt${i}">Motion at 0x${(0x68+i).toString(16)}</h2><p id="ms${i}">Checking...</p><div class="legend"><span class="x">X</span><span class="y">Y</span><span class="z">Z</span></div><p class="sub">Acceleration · ±160 m/s²</p><canvas id="ma${i}" role="img" aria-label="Three axis acceleration history"></canvas><div class="readings" id="av${i}">—</div><p class="sub">Rotation rate · ±2000 °/s</p><canvas id="mg${i}" role="img" aria-label="Three axis gyroscope history"></canvas><div class="readings" id="gv${i}">—</div><p class="sub" id="temp${i}">Temperature unavailable</p><p class="sub" id="mr${i}"></p>`;$('motion').appendChild(el)}
function push(h,v){const t=Date.now();h.push({t,v});while(h.length&&h[0].t<t-30000)h.shift()}
function plot(id,h,min,max,cs){const c=$(id),r=c.getBoundingClientRect(),d=window.devicePixelRatio||1;c.width=Math.max(1,r.width*d);c.height=Math.max(1,r.height*d);const x=c.getContext('2d');x.scale(d,d);const w=r.width,hh=r.height;x.strokeStyle='#dce5ed';x.lineWidth=1;for(let k=0;k<3;k++){const y=4+(hh-8)*k/2;x.beginPath();x.moveTo(0,y);x.lineTo(w,y);x.stroke()}const now=Date.now();cs.forEach((color,k)=>{x.strokeStyle=color;x.lineWidth=2;x.beginPath();let pen=false;h.forEach(p=>{const v=Array.isArray(p.v)?p.v[k]:p.v;if(v==null||!Number.isFinite(v)){pen=false;return}const px=w*(1-(now-p.t)/30000),py=hh-4-(hh-8)*(Math.max(min,Math.min(max,v))-min)/(max-min);if(pen)x.lineTo(px,py);else x.moveTo(px,py);pen=true});x.stroke()})}
function clearHistory(){histories.forEach(h=>h.length=0);mh.forEach(h=>{h.a.length=0;h.g.length=0})}
function render(data){document.body.classList.remove('offline');$('connection').textContent='Live · ESP8266 connected';$('connection').className='ok';if(lastUptime!==null&&data.uptime<lastUptime)clearHistory();lastUptime=data.uptime;
 $('devices').replaceChildren();data.ads.forEach(a=>{const el=document.createElement('div');el.className='chip '+(a.ok?'ok':'warn');el.textContent=`${a.address}: ${a.ok?'ADS-compatible response':a.ack?'ACK; read failed':'no response'} · ${a.errors} errors`;$('devices').appendChild(el)});
 $('inventory').textContent=`I²C addresses: ${data.i2c.join(', ')||'none'} | scan age ${(data.scanAge/1000).toFixed(1)} s. Addresses 0x4A/0x4B are inventoried but not mapped to fingers.`;renderCal(data);
 data.sensors.forEach((s,i)=>{$('map'+i).textContent=`${s.address} / A${s.channel}`;$('v'+i).textContent=s.valid?s.voltage.toFixed(3):'—';$('bar'+i).style.width=s.valid?Math.max(0,Math.min(100,s.voltage/3.3*100))+'%':'0%';$('raw'+i).textContent=s.valid?`Raw ${s.raw} · ${s.resistance===null?'Resistance unavailable':(s.resistance/1000).toFixed(1)+' kΩ'}`:'No fresh reading';$('rest'+i).textContent=s.calOk?`Rest ${s.rest.toFixed(3)} V ± ${s.noise.toFixed(3)}`+(s.valid?` · now ${s.delta>=0?'+':''}${s.delta.toFixed(3)} V · peaks ${s.lo.toFixed(3)} / +${s.hi.toFixed(3)}`:''):s.calNote;$('s'+i).textContent=s.status;$('s'+i).className='status '+(!s.valid?'bad':(s.responded||s.status.startsWith('At rest'))?'ok':'warn');push(histories[i],s.valid?s.voltage:null);plot('plot'+i,histories[i],0,3.3,[colors[i]])});
 data.motion.forEach((m,i)=>{$('mt'+i).textContent=`${m.model} at ${m.address}`;$('ms'+i).textContent=m.valid?`Reading · WHO_AM_I ${m.id} · ${m.errors} read errors`:`Unavailable / unsupported · WHO_AM_I ${m.id} · ${m.errors} errors`;$('ms'+i).className=m.valid?'ok':'warn';$('av'+i).textContent=m.valid?m.accel.map((v,k)=>'XYZ'[k]+': '+v.toFixed(2)).join(' / ')+' m/s²':'—';$('gv'+i).textContent=m.valid?m.gyro.map((v,k)=>'XYZ'[k]+': '+v.toFixed(2)).join(' / ')+' °/s':'—';$('temp'+i).textContent=m.valid?`Chip temperature ${m.temperature.toFixed(1)} °C`:'Temperature unavailable';$('mr'+i).textContent=m.calOk?`Rest: accel ${m.restAccel.map(v=>v.toFixed(2)).join(' / ')} m/s² · gyro bias ${m.gyroBias.map(v=>v.toFixed(2)).join(' / ')} °/s (subtracted from the gyro plot)`:'';push(mh[i].a,m.valid?m.accel:null);push(mh[i].g,m.valid?m.gyro:null);plot('ma'+i,mh[i].a,-160,160,['#a84d20','#176545','#235bb5']);plot('mg'+i,mh[i].g,-2000,2000,['#a84d20','#176545','#235bb5'])});
}
function renderCal(d){const c=d.cal;$('calibrate').disabled=c.running;
 $('calstate').textContent=c.running?`Calibrating: hold the glove still in its normal position (${Math.ceil(c.remaining/1000)} s left)`:c.done?`Calibrated ${Math.round(c.age/1000)} s ago. Now bend and press to test.`:'Not calibrated. Rest the glove in its normal position, then press Calibrate.';
 $('warnings').replaceChildren();d.warnings.forEach(w=>{const p=document.createElement('p');p.className='warn';p.textContent='⚠ '+w;$('warnings').appendChild(p)})}
function offline(){document.body.classList.add('offline');$('connection').textContent='Connection lost · retrying';$('connection').className='bad';$('inventory').textContent='Bus inventory unavailable while disconnected';$('devices').replaceChildren();names.forEach((_,i)=>{$('v'+i).textContent='—';$('raw'+i).textContent='No fresh reading';$('bar'+i).style.width='0%';$('s'+i).textContent='Dashboard disconnected';$('s'+i).className='status bad';push(histories[i],null);plot('plot'+i,histories[i],0,3.3,[colors[i]])});for(let i=0;i<2;i++){$('ms'+i).textContent='No fresh motion data';$('ms'+i).className='bad';$('av'+i).textContent=$('gv'+i).textContent='—';$('temp'+i).textContent='Temperature unavailable';push(mh[i].a,null);push(mh[i].g,null);plot('ma'+i,mh[i].a,-160,160,['#a84d20','#176545','#235bb5']);plot('mg'+i,mh[i].g,-2000,2000,['#a84d20','#176545','#235bb5'])}}
async function request(path,method='GET'){const c=new AbortController(),timer=setTimeout(()=>c.abort(),3000);try{const r=await fetch(path,{method,cache:'no-store',signal:c.signal});if(!r.ok)throw Error('HTTP '+r.status);return method==='GET'?await r.json():await r.text()}finally{clearTimeout(timer)}}
async function update(){try{render(await request('/data'))}catch(e){offline()}finally{setTimeout(update,250)}}
for(const action of ['calibrate','reset','scan'])$(action).onclick=async()=>{$(action).disabled=true;try{$('message').textContent=await request('/'+action,'POST');if(action==='reset')clearHistory()}catch(e){$('message').textContent='Request failed. Check the glove connection.'}finally{$(action).disabled=false}};
update();
</script></body></html>
)GLOVEHTML";

// NodeMCU 1.0 (ESP-12E Module), ESP8266 Arduino core 3.x.
// Register-level ADS reads check every transaction and have a conversion deadline.
#if __has_include("secrets.h")
#include "secrets.h" // WIFI_SSID, WIFI_PASSWORD (git-ignored)
#else
#error "Missing include/secrets.h: copy include/secrets.example.h to include/secrets.h and fill in your WiFi."
#endif
const uint8_t SENSOR_ADS[6] = {0x48,0x48,0x48,0x48,0x49,0x49};
const uint8_t SENSOR_CHANNEL[6] = {0,1,2,3,0,1};
const char* NAMES[6] = {"Thumb","Index","Middle","Ring","Little","Force"};
MapData fingerMap; // finger -> ADC channel, saved on the glove (set from the viewer's Identify fingers)
// Name of the finger wired to ADC channel ch, so messages follow the real wiring rather than the channel order.
const char* chName(uint8_t ch) {
  for (uint8_t f=0;f<5;f++) if (fingerMap.ch[f]==ch && ch<5) return NAMES[f];
  return NAMES[ch];
}
// Flex dividers sit around 0.2 V, so those channels use the +/-1.024 V range (31 uV/LSB); the palm sensor keeps +/-4.096 V
// (its divider can reach nearly 3.3 V on a hard press, which is still inside that range).
// Config word = OS | PGA | single-shot (below) + data rate + comparator off + MUX; see adcConfig().
const uint16_t SENSOR_PGA[6] = {0x8700,0x8700,0x8700,0x8700,0x8700,0x8300};
const float SENSOR_LSB_V[6] = {3.125e-5f,3.125e-5f,3.125e-5f,3.125e-5f,3.125e-5f,1.25e-4f};
const float VCC = 3.3f, RFIXED = 10000.0f;
ESP8266WebServer server(80);
bool bus[128] = {};
bool adcOK[4] = {};
uint32_t adcErrors[4] = {};
uint32_t lastScan = 0;
bool rescan = false, scanned = false;
uint8_t adcFails[4] = {};
const uint16_t FAST_SCAN_MS = 1000, SLOW_SCAN_MS = 5000; // fast while an expected device is missing
const uint8_t EXPECTED_ADDR[] = {0x48,0x49,0x68};
const char* warnings[8] = {};
uint8_t warningCount = 0;

struct Sensor {
  int16_t raw = 0;
  float v = 0, history[3] = {}, baseline = 0, lo = 0, hi = 0; // lo/hi: peak change from baseline
  uint8_t count = 0, pos = 0, moved = 0;
  bool valid = false, responded = false;
  uint32_t at = 0, atUs = 0;
};
Sensor sensor[6];
struct Motion {
  uint8_t address = 0, id = 0;
  bool initialized = false, valid = false;
  bool wasUp = false;          // has been initialised at least once: only such a chip is worth retrying
  uint32_t lastGoodMs = 0;     // last time a sample was read from its FIFO
  float a[3] = {}, g[3] = {}, temp = 0;
  uint32_t at = 0, errors = 0;
};
Motion motion[2];

// Rest calibration. Kept apart from Sensor so an ADC dropout does not erase it.
const uint32_t CAL_MS = 5000;
const uint16_t CAL_MIN_SAMPLES = 20;
const float CAL_MAX_RANGE = 0.10f; // V; a wider spread means the glove moved
struct Cal {
  bool ok = false;
  float mean = 0, m2 = 0, sd = 0, lo = 0, hi = 0;
  uint16_t n = 0;
  const char* note = "Not calibrated";
};
struct MotionCal { bool ok = false; float a[3] = {}, g[3] = {}; uint16_t n = 0; };
Cal cal[6];
MotionCal mcal[2];
bool calRunning = false, calDone = false;
uint32_t calStart = 0, calEnd = 0;
float restThreshold(uint8_t i) { float floor=i==5 ? 0.05f : 0.01f; return cal[i].ok ? fmaxf(floor, 6*cal[i].sd) : floor; } // flex swings are tens of mV
void statAdd(Cal &c, float v) { // Welford running mean/variance plus range
  if (c.n==0) c.lo=c.hi=v;
  c.n++; float d=v-c.mean; c.mean+=d/c.n; c.m2+=d*(v-c.mean);
  if (v<c.lo) c.lo=v;
  if (v>c.hi) c.hi=v;
}

// ---- Hand pose: flex -> curl, MPU -> orientation, guided pose calibration, WebSocket stream to the 3D viewer ----
const char* const FW_VERSION = "glove-rec-1";
// MPU6050 at +/-16 g and +/-2000 deg/s so a smash does not clip; 200 Hz output (1 kHz / (1+4)), DLPF 94 Hz accel / 98 Hz gyro.
// The same ranges are stored with the calibration (GloveCal.h), which is rejected if they differ.
const float ACC_LSB_PER_G = 2048.0f, GYRO_LSB_PER_DPS = 16.4f;
const uint32_t IMU_NOMINAL_PERIOD_US = 5000, IMU_POLL_US = 4000; // the FIFO is drained, so every sample is read once; the interval only sets latency
const uint8_t MPU_FIFO_SAMPLE_BYTES = 12;                        // accel xyz + gyro xyz
// FIFO size depends on the chip: 1024 bytes on the MPU6050, 512 on the MPU6500/9250. Near full it has wrapped and may be misaligned.
uint16_t fifoOverflowBytes(uint8_t whoAmI) { return whoAmI==0x68 ? 1000 : 500; }
uint32_t i2cHz = 400000;
const uint16_t ADC_SPS[4] = {128,250,475,860};
const uint32_t ADC_CONV_US[4] = {7813,4000,2105,1163};
const uint8_t ADC_DR_BITS[4] = {4,5,6,7};
uint8_t adcDr = 3;                                               // index into the tables above: 860 SPS (chosen from the measured noise table)
uint16_t adcConfig(uint8_t i) { return SENSOR_PGA[i] | (uint16_t(ADC_DR_BITS[adcDr])<<5) | 0x0003 | (uint16_t(4+SENSOR_CHANNEL[i])<<12); }
const uint16_t POSE_PERIOD_MS = 33, STATUS_PERIOD_MS = 500, WS_PORT = 81;
const uint16_t CAPTURE_MS = 3000, CAPTURE_MIN_IMU = 100;
const float FORCE_FULL_SCALE_V = 1.0f, FORCE_DEADBAND_V = 0.02f; // palm sensor: volts above rest read as 0% / 100%
const float FLEX_STEADY_ABS_V = 0.012f, FLEX_STEADY_REL = 0.15f, FLEX_MIN_FRACTION = 0.02f, FLEX_MIN_SNR = 8.0f; // allowed spread = abs + rel*mean while holding a pose; a flexed value must differ from open by 2% of R and by 8x the capture's noise
const float CURL_HYSTERESIS = 0.015f; // curl must move this far before the output follows: hides sensor noise
const float CAPTURE_MAX_GYRO_RANGE = 4.0f, CAPTURE_MAX_ACCEL_RANGE = 0.08f; // deg/s, g: peak-to-peak spread allowed on a rest surface
const float HELD_MAX_GYRO_RANGE = 25.0f, HELD_MAX_ACCEL_RANGE = 0.20f;     // same, for a pose held in the air (tremor); the 3 s mean still averages it out
// WebSockets::write() loops until the whole frame is accepted or WEBSOCKETS_TCP_TIMEOUT (5 s) passes, so one slow client
// would freeze sampling and leave a truncated frame. Every send is therefore gated on free TCP send space.
class RecServer : public WebSocketsServer {
 public:
  using WebSocketsServer::WebSocketsServer;
  bool canSend(uint8_t num, size_t bytes) {
    if (num >= WEBSOCKETS_SERVER_CLIENT_MAX) return false;
    WSclient_t &c = _clients[num];
    return c.status == WSC_CONNECTED && c.tcp && c.tcp->connected() && size_t(c.tcp->availableForWrite()) >= bytes;
  }
  IPAddress clientIP(uint8_t num) { return (num < WEBSOCKETS_SERVER_CLIENT_MAX && _clients[num].tcp) ? _clients[num].tcp->remoteIP() : IPAddress(); }
  bool isConnected(uint8_t num) { return num < WEBSOCKETS_SERVER_CLIENT_MAX && _clients[num].status == WSC_CONNECTED; }
};
RecServer ws(WS_PORT);
CalData calData;
ImuFusion fusion;
OneEuro curlFilter[6]; // 0-4 flex curl, 5 palm pressure; both 0..1
float curl[6] = {};
uint32_t imuSamples = 0, adcSamples = 0;
uint16_t imuHz = 0, adcHz = 0; // per second, adc per channel
bool fusionStale = true;       // re-seed the filter from gravity after the MPU (re)starts

// ---- Record stream (binary WebSocket, off until a client sends "rec:start") and diagnostics ----
// The WebSocket path needs the ring to ride out TCP stalls; the UDP path only needs enough to absorb loop jitter.
rec::ByteRing<5120> recRing; // UDP: ~1000 byte datagrams, so room for several
bool recActive = false, recUdpMode = false; int16_t recClient = -1;
WiFiUDP recUdp; IPAddress recUdpIp; uint16_t recUdpPort = 0; uint32_t udpSent = 0, udpFail = 0, udpRetried = 0;
size_t udpPendingLen = 0; uint32_t udpPendingAt = 0; // a datagram the network stack refused, kept in recPacket for exactly one retry
uint32_t recBootId = 0, recPacketSeq = 0, recDropped = 0, recBlocked = 0, recLastFlush = 0, textSkipped = 0;
uint32_t imuSeq[2] = {}, adcSeq = 0;
SampleClock imuClock[2];
uint8_t recPacket[WEBSOCKETS_MAX_HEADER_SIZE+1000]; // the library writes the frame header into the first 14 bytes (headerToPayload)
struct AdcChip { int8_t pending = -1; uint8_t next = 0; uint16_t expected = 0; uint32_t startUs = 0, pollUs = 0; };
AdcChip adcChip[2];
uint8_t chipSensors[2][6] = {}, chipCount[2] = {}; // which of the six sensors sit on 0x48 / 0x49
struct Diag {
  uint32_t imuRecoveries = 0, imuRecoveryFails = 0, imuSilentResets = 0;
  uint32_t imuReads = 0, imuSamples = 0, imuOverflows = 0, imuLostEst = 0, imuReadErrors = 0, imuMaxReadGapUs = 0, imuMaxBatch = 0, imuLastReadUs = 0;
  uint32_t adcCount[6] = {}, adcMaxGapUs[6] = {}, adcLastUs[6] = {};
  uint32_t loops = 0, loopMaxUs = 0, scans = 0, startMs = 0, minHeap = 0xFFFFFFFF;
  int32_t peakAcc = 0, peakGyro = 0; // largest |raw count| seen on any axis
  int32_t rssiSum = 0, rssiN = 0; int8_t rssiMin = 0; // dBm, sampled twice a second
} diag;
// Resting-noise measurement: steps through the four ADC data rates and records the spread of raw counts.
struct NoiseStat { uint32_t n = 0; float mean = 0, m2 = 0; int16_t lo = 0, hi = 0; };
struct NoiseRun { bool active = false, done = false; uint8_t step = 0, savedDr = 3; uint32_t startMs = 0, durMs = 3000; NoiseStat st[4][6]; } noise;
const uint32_t NOISE_SETTLE_MS = 200;
// micros() as a 64-bit time: counts wraps (every 71.6 min), so it must be called at least once in between.
uint64_t now64Us() {
  static uint32_t last = 0, epoch = 0;
  uint32_t t = micros(); if (t < last) epoch++;
  last = t; return (uint64_t(epoch) << 32) | t;
}
void recPush(const void *r, size_t n) {
  if (recUdpMode) rec::pushDropOldest(recRing, r, n, recDropped);
  else if (!recRing.push(r, n)) recDropped++;
}
void noiseAdd(uint8_t i, int16_t raw) {
  if (!noise.active || millis()-noise.startMs < NOISE_SETTLE_MS) return;
  NoiseStat &t = noise.st[noise.step][i];
  if (!t.n) t.lo = t.hi = raw;
  t.n++; float d = raw-t.mean; t.mean += d/t.n; t.m2 += d*(raw-t.mean);
  if (raw < t.lo) t.lo = raw;
  if (raw > t.hi) t.hi = raw;
}
void tickNoise() {
  if (!noise.active || millis()-noise.startMs < noise.durMs) return;
  if (++noise.step >= 4) { noise.active = false; noise.done = true; adcDr = noise.savedDr; return; }
  adcDr = noise.step; noise.startMs = millis();
}

enum CapStage : uint8_t { CAP_NONE, CAP_FLAT, CAP_UP, CAP_FIST, CAP_ACCEL, CAP_PRESS, CAP_FINGER };
const char* const CAP_NAMES[] = {"none","flat","up","fist","accel","press","finger"};
const char* const FACE_NAMES[6] = {"+X","-X","+Y","-Y","+Z","-Z"};
struct Capture {
  CapStage stage = CAP_NONE; uint8_t face = 0;
  uint32_t start = 0; uint16_t n = 0;
  float aSum[3] = {}, gSum[3] = {}, aLo[3] = {}, aHi[3] = {}, gLo[3] = {}, gHi[3] = {};
  Cal flex[6]; // volts per channel while the pose is held
};
struct CapResult { uint32_t seq = 0; bool ok = false; char msg[160] = ""; };
Capture capture;
CapResult capResult;
Vec3 flatUp; bool flatUpValid = false; // dorsal normal in the sensor frame, from the flat pose
float accFace[6] = {}; uint8_t faceMask = 0;

void applyCal() {
  const CalData &c = calData;
  fusion.gyroBias = c.flags & CAL_GYRO ? Vec3{c.gyroBias[0],c.gyroBias[1],c.gyroBias[2]} : Vec3();
  fusion.trackRange = c.flags & CAL_GYRO ? 3.0f : 20.0f; // MPU6050 zero-rate offset can reach +/-20 deg/s
  fusion.accOff = c.flags & CAL_ACCEL ? Vec3{c.accOff[0],c.accOff[1],c.accOff[2]} : Vec3();
  fusion.accScale = c.flags & CAL_ACCEL ? Vec3{c.accScale[0],c.accScale[1],c.accScale[2]} : Vec3{1,1,1};
  fusion.hasMount = c.flags & CAL_MOUNT;
  fusion.mount = fusion.hasMount ? Quat{c.mount[0],c.mount[1],c.mount[2],c.mount[3]} : Quat();
}
// Index of the MPU that drives the hand orientation: the first one that initialised, or -1.
int handImu();
// Flex voltage (median-filtered) to 0..1 curl, then One Euro smoothing. Palm sensor: volts above rest to 0..1 pressure.
float provOpen[5] = {}, provDev[5] = {}; // provisional scale, used until open hand and fist are both saved
void resetProvisional() { memset(provOpen,0,sizeof(provOpen)); memset(provDev,0,sizeof(provDev)); }
void updateCurl(uint8_t i, float volts, bool continuing, float dt) {
  float raw = 0;
  if (i<5) {
    float r = flexResistance(volts,VCC,RFIXED);
    if ((calData.flags & calOpenBit(i)) && (calData.flags & calFlexBit(i))) raw = bendFraction(r, calData.openR[i], calData.fistR[i]);
    else { // rest = saved open hand, else the first reading; 100% = the largest change seen so far (at least 25% of rest)
      if (calData.flags & calOpenBit(i)) provOpen[i] = calData.openR[i]; else if (provOpen[i]<=0) provOpen[i] = r;
      float dev = fabsf(r-provOpen[i]); provDev[i] = fmaxf(provDev[i], dev);
      raw = clampf(dev/fmaxf(provDev[i],0.25f*provOpen[i]), 0, 1);
    }
  } else raw = clampf((volts-calData.forceRest-FORCE_DEADBAND_V)/((calData.flags & CAL_FORCE) ? calData.forceFull : FORCE_FULL_SCALE_V), 0, 1);
  static float held[6];
  if (!continuing) curlFilter[i].reset();
  float f = curlFilter[i].filter(raw, dt);
  if (!continuing) held[i] = f;
  else if (f > held[i]+CURL_HYSTERESIS) held[i] = f-CURL_HYSTERESIS;
  else if (f < held[i]-CURL_HYSTERESIS) held[i] = f+CURL_HYSTERESIS;
  curl[i] = f>=0.999f ? 1 : (f<=0.001f ? 0 : held[i]); // keep the endpoints reachable
}
void captureImu(const Vec3 &a, const Vec3 &g) {
  Capture &c = capture; const float av[3] = {a.x,a.y,a.z}, gv[3] = {g.x,g.y,g.z};
  for (uint8_t k=0;k<3;k++) {
    if (c.n==0) { c.aLo[k]=c.aHi[k]=av[k]; c.gLo[k]=c.gHi[k]=gv[k]; }
    c.aSum[k]+=av[k]; c.gSum[k]+=gv[k];
    c.aLo[k]=fminf(c.aLo[k],av[k]); c.aHi[k]=fmaxf(c.aHi[k],av[k]);
    c.gLo[k]=fminf(c.gLo[k],gv[k]); c.gHi[k]=fmaxf(c.gHi[k],gv[k]);
  }
  c.n++;
}

bool readBytes(uint8_t address, uint8_t reg, uint8_t* out, uint8_t len) {
  Wire.beginTransmission(address); Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(address, len) != len) {
    while (Wire.available()) Wire.read();
    return false;
  }
  for (uint8_t i=0;i<len;i++) out[i] = Wire.read();
  return true;
}
bool write8(uint8_t address, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(address); Wire.write(reg); Wire.write(value);
  return Wire.endTransmission() == 0;
}
bool write16(uint8_t address, uint8_t reg, uint16_t value) {
  Wire.beginTransmission(address); Wire.write(reg);
  Wire.write(uint8_t(value >> 8)); Wire.write(uint8_t(value));
  return Wire.endTransmission() == 0;
}
bool read16(uint8_t address, uint8_t reg, uint16_t &value) {
  uint8_t bytes[2];
  if (!readBytes(address,reg,bytes,2)) return false;
  value = (uint16_t(bytes[0]) << 8) | bytes[1]; return true;
}
const char* model(uint8_t id) {
  switch (id) {
    case 0x68: return "MPU6050";
    case 0x70: return "MPU6500";
    case 0x71: return "MPU9250";
    case 0x73: return "MPU9255";
    default: return "Unknown identity";
  }
}
bool initMotion(uint8_t n) {
  Motion &m = motion[n]; m.valid = false;
  if (!readBytes(m.address,0x75,&m.id,1)) return false;
  if (m.id!=0x68 && m.id!=0x70 && m.id!=0x71 && m.id!=0x73) return false;
  // Wake (PLL clock), all axes enabled, DLPF 94/98 Hz, 200Hz sample rate, +/-16g, +/-2000deg/s,
  // and accel + gyro xyz into the FIFO (0x23), so every sample can be read exactly once.
  if (!write8(m.address,0x6B,0x01)) return false;
  delay(50); // Only during discovery/recovery; yields to ESP8266 networking.
  const uint8_t regs[] = {0x6C,0x1A,0x19,0x1C,0x1B,0x23};
  const uint8_t vals[] = {0,2,4,0x18,0x18,0x78};
  for (uint8_t i=0;i<6;i++) {
    uint8_t got;
    if (!write8(m.address,regs[i],vals[i]) ||
        !readBytes(m.address,regs[i],&got,1) || got!=vals[i]) return false;
  }
  // FIFO: reset while disabled, then enable. FIFO_RESET clears itself, so only the enable bit is read back.
  uint8_t got;
  // MPU6500/9250 filter the accelerometer separately (ACCEL_CONFIG2): 99 Hz, to match the gyro filter.
  if (m.id!=0x68 && (!write8(m.address,0x1D,0x02) || !readBytes(m.address,0x1D,&got,1) || got!=0x02)) return false;
  if (!write8(m.address,0x6A,0x04) || !write8(m.address,0x6A,0x40) || !readBytes(m.address,0x6A,&got,1) || got!=0x40) return false;
  imuClock[n]=SampleClock(IMU_NOMINAL_PERIOD_US); fusionStale=true;
  if (m.wasUp && m.lastGoodMs) { // it was down: skip the sequence numbers it missed so the gap shows in the recording
    uint32_t lost=(millis()-m.lastGoodMs)*1000u/IMU_NOMINAL_PERIOD_US; imuSeq[n]+=lost; diag.imuLostEst+=lost;
  }
  m.wasUp=true; m.lastGoodMs=millis();
  return true;
}
// A slave stuck holding SDA low (e.g. after a reset mid-transfer) blocks the bus.
// Clock SCL up to 9 times so it releases, then send a STOP.
void busRecover() {
  pinMode(D2,INPUT_PULLUP); pinMode(D1,INPUT_PULLUP); delay(2);
  if (digitalRead(D2)==HIGH) return;
  Serial.println("SDA held low at boot; clocking SCL to free the bus.");
  for (uint8_t i=0;i<9 && digitalRead(D2)==LOW;i++) {
    pinMode(D1,OUTPUT); digitalWrite(D1,LOW); delayMicroseconds(5);
    pinMode(D1,INPUT_PULLUP); delayMicroseconds(5);
  }
  pinMode(D2,OUTPUT); digitalWrite(D2,LOW); delayMicroseconds(5);
  pinMode(D1,INPUT_PULLUP); delayMicroseconds(5);
  pinMode(D2,INPUT_PULLUP); delayMicroseconds(5);
  Serial.println(digitalRead(D2)==HIGH ? "SDA released." : "SDA still low: check for a short to GND or a stuck chip.");
}
bool expectedMissing() {
  for (uint8_t i=0;i<sizeof(EXPECTED_ADDR);i++) if (!bus[EXPECTED_ADDR[i]]) return true;
  return false;
}
void addWarning(const char* w) { if (warningCount<8) warnings[warningCount++]=w; }
// Plain-language causes for what the scan found. Printed only when the set changes.
void buildWarnings() {
  const char* previous[8]; uint8_t previousCount=warningCount;
  memcpy(previous,warnings,sizeof(previous));
  warningCount=0;
  bool any=false; for (uint8_t a=1;a<127;a++) any|=bus[a];
  if (digitalRead(D2)==LOW) addWarning("SDA is held low: short to GND, or a chip is holding the bus");
  if (digitalRead(D1)==LOW) addWarning("SCL is held low: short to GND, or a chip is holding the bus");
  if (!any) addWarning("No I2C device answered: check 3V3 and GND at the hand box, SDA/SCL wiring and pull-ups");
  else {
    if (!bus[0x48]) addWarning("0x48 (ADS1115 #1, thumb to ring) not answering: check its VDD, GND, SDA, SCL and ADDR to GND");
    if (!bus[0x49]) addWarning("0x49 (ADS1115 #2, little and force) not answering: check its VDD, GND, SDA, SCL and ADDR to 3V3");
    if (!bus[0x68] && !bus[0x69]) addWarning("No motion sensor at 0x68 or 0x69: check its VCC, GND, SDA, SCL and AD0");
    if (bus[0x4A]) addWarning("A device answers at 0x4A, which is an ADS1115 with ADDR on SDA: check the ADDR joints (floating or loose)");
    if (bus[0x4B]) addWarning("A device answers at 0x4B, which is an ADS1115 with ADDR on SCL: check the ADDR joints (floating or loose)");
    for (uint8_t n=0;n<2;n++)
      if (bus[motion[n].address] && !motion[n].initialized) addWarning("Motion chip answers but did not initialise: unexpected WHO_AM_I or register readback failed");
  }
  bool changed = warningCount!=previousCount;
  for (uint8_t i=0;i<warningCount && !changed;i++) changed = warnings[i]!=previous[i];
  if (!changed) return;
  if (!warningCount) Serial.println("Bus OK: all expected devices answer.");
  for (uint8_t i=0;i<warningCount;i++) Serial.printf("WARNING: %s\n",warnings[i]);
}
void scanBus() {
  bool previous[128]; memcpy(previous,bus,sizeof(bus));
  for (uint8_t a=1;a<127;a++) {
    Wire.beginTransmission(a); bus[a] = Wire.endTransmission()==0;
    yield();
  }
  if (!scanned || memcmp(previous,bus,sizeof(bus))!=0) { // only print when something changed
    Serial.println("I2C inventory (ACK is not proof of chip identity):");
    bool none=true;
    for (uint8_t a=1;a<127;a++) if (bus[a]) { Serial.printf("  0x%02X\n",a); none=false; }
    if (none) Serial.println("  (nothing answered)");
  }
  scanned=true;
  // ADS1115 has no unique chip-ID register. These are compatible candidates.
  // Channel conversions additionally verify config readback and readiness.
  for (uint8_t n=0;n<4;n++) {
    uint16_t cfg;
    adcOK[n] = bus[0x48+n] && read16(0x48+n,1,cfg);
  }
  for (uint8_t n=0;n<2;n++) {
    Motion &m=motion[n];
    if (!bus[m.address]) { m.initialized=false; m.valid=false; m.id=0; }
    else if (!m.initialized) m.initialized=initMotion(n);
  }
  buildWarnings();
  lastScan=millis(); rescan=false;
}
// One failed transaction counts an error; three in a row drop the ADC and request a rescan.
void failADC(uint8_t address) {
  uint8_t n=address-0x48; adcErrors[n]++;
  if (n<2) adcChip[n].pending=-1;
  if (++adcFails[n]<3) return;
  adcOK[n]=false; adcFails[n]=0; rescan=true;
  for (uint8_t i=0;i<6;i++) if (SENSOR_ADS[i]==address) sensor[i]=Sensor();
}
void acceptSample(uint8_t i, int16_t raw, uint32_t tUs) {
  Sensor &s=sensor[i];
  float volts=raw * SENSOR_LSB_V[i]; // per-channel range, see SENSOR_CONFIG
  if (calRunning) statAdd(cal[i],volts); // unfiltered samples
  if (capture.stage==CAP_FLAT || capture.stage==CAP_FIST || capture.stage==CAP_PRESS || capture.stage==CAP_FINGER) statAdd(capture.flex[i],volts);
  adcSamples++;
  noiseAdd(i,raw);
  diag.adcCount[i]++;
  if (diag.adcLastUs[i]) { uint32_t gap=tUs-diag.adcLastUs[i]; if (gap>diag.adcMaxGapUs[i]) diag.adcMaxGapUs[i]=gap; }
  diag.adcLastUs[i]=tUs;
  if (recActive) { rec::AdcRecord r={rec::REC_ADC,tUs,adcSeq,i,raw}; recPush(&r,sizeof r); }
  adcSeq++;
  s.raw=raw; s.history[s.pos]=volts;
  s.pos=(s.pos+1)%3; if (s.count<3) s.count++;
  float sorted[3]; for (uint8_t k=0;k<s.count;k++) sorted[k]=s.history[k];
  for (uint8_t k=1;k<s.count;k++) for (uint8_t j=k;j>0 && sorted[j]<sorted[j-1];j--) {
    float t=sorted[j]; sorted[j]=sorted[j-1]; sorted[j-1]=t;
  }
  float v=sorted[s.count/2];
  updateCurl(i,v,s.valid,s.valid ? (tUs-s.atUs)*1e-6f : 0); // median only: the EMA below is for the bench plots
  if (!s.valid) { s.v=v; s.baseline=cal[i].ok ? cal[i].mean : v; }
  else s.v += (i==5 ? 0.4f:0.25f)*(v-s.v); // Always update; no deadband freeze.
  s.valid=true; s.at=millis(); s.atUs=tUs;
  float delta=s.v-s.baseline;
  if (cal[i].ok) { if (delta<s.lo) s.lo=delta; if (delta>s.hi) s.hi=delta; }
  // Three successive filtered samples away from baseline reduce spike triggers.
  // No response tracking while calibrating: the rest value is still being measured.
  if (!calRunning && s.count==3 && fabsf(delta)>restThreshold(i)) {
    if (s.moved<3) s.moved++;
    if (s.moved>=3) s.responded=true;
  } else s.moved=0;
}
void startCalibration() {
  for (uint8_t i=0;i<6;i++) {
    cal[i]=Cal();
    Sensor &s=sensor[i]; s.responded=false; s.moved=0; s.lo=s.hi=0;
  }
  for (uint8_t n=0;n<2;n++) mcal[n]=MotionCal();
  calRunning=true; calDone=false; calStart=millis();
  Serial.println("Calibration started: hold the glove still in its normal position.");
}
void finishCalibration() {
  calRunning=false; calDone=true; calEnd=millis();
  for (uint8_t i=0;i<6;i++) {
    Cal &c=cal[i]; Sensor &s=sensor[i];
    c.sd = c.n>1 ? sqrtf(c.m2/(c.n-1)) : 0;
    if (c.n<CAL_MIN_SAMPLES) c.note="Too few samples: ADC not answering during calibration";
    else if (c.hi-c.lo>CAL_MAX_RANGE) c.note="Moved during calibration: hold still and retry";
    else if (c.mean>VCC-0.05f) c.note="Near 3.3V at rest: inspect divider";
    else if (c.mean<0.015f && i!=5) c.note="Near 0V at rest: inspect sensor / wiring";
    else { c.ok=true; c.note="Calibrated"; s.baseline=c.mean; }
    s.responded=false; s.moved=0; s.lo=s.hi=0;
    if (c.ok) Serial.printf("Cal %s: rest %.4fV, sd %.4fV, range %.4fV, %u samples\n",chName(i),c.mean,c.sd,c.hi-c.lo,c.n);
    else Serial.printf("Cal %s FAILED: %s (%u samples)\n",chName(i),c.note,c.n);
  }
  for (uint8_t n=0;n<2;n++) {
    MotionCal &c=mcal[n];
    if (c.n<CAL_MIN_SAMPLES) { c=MotionCal(); continue; }
    for (uint8_t k=0;k<3;k++) { c.a[k]/=c.n; c.g[k]/=c.n; }
    c.ok=true;
    Serial.printf("Cal MPU 0x%02X: gyro bias %.2f %.2f %.2f deg/s\n",motion[n].address,c.g[0],c.g[1],c.g[2]);
  }
}
// Both ADS1115 chips convert at once: while one converts, the loop serves the other chip and the MPU. Each chip steps
// through its own channels (0x48 carries four of the six). A sample is stamped with the middle of its conversion window.
bool scanDue(uint32_t now) {
  if (rescan && now-lastScan>=250) return true;     // after an error
  if (recActive) return false;                       // no periodic scans while recording: each one stalls sampling
  return now-lastScan >= (expectedMissing() ? FAST_SCAN_MS : SLOW_SCAN_MS);
}
void tickADC() {
  uint32_t now=millis(); bool due=scanDue(now);
  if (due && adcChip[0].pending<0 && adcChip[1].pending<0) { diag.scans++; scanBus(); return; }
  for (uint8_t c=0;c<2;c++) {
    AdcChip &a=adcChip[c]; uint8_t address=0x48+c;
    if (a.pending>=0) {
      uint32_t nowUs=micros(), elapsed=nowUs-a.startUs;
      if (elapsed>40000) { failADC(address); continue; }
      if (elapsed<ADC_CONV_US[adcDr] || nowUs-a.pollUs<150) continue; // not ready yet; do not hammer the bus
      a.pollUs=nowUs; uint16_t cfg, result;
      if (!read16(address,1,cfg) || (cfg & 0x7FFF)!=(a.expected & 0x7FFF)) { failADC(address); continue; }
      if (!(cfg & 0x8000)) continue;
      uint8_t i=uint8_t(a.pending); a.pending=-1;
      if (!read16(address,0,result)) failADC(address);
      else { adcFails[c]=0; acceptSample(i,int16_t(result),a.startUs+ADC_CONV_US[adcDr]/2); }
    }
    if (a.pending>=0 || due || !adcOK[c] || !chipCount[c]) continue;
    // OS=start, MUX=single-ended A0..A3, PGA per SENSOR_PGA, single-shot, data rate per adcDr, comparator disabled.
    // Input must remain within 0..VDD.
    uint8_t i=chipSensors[c][a.next]; a.next=(a.next+1)%chipCount[c];
    a.expected=adcConfig(i);
    if (!write16(address,1,a.expected)) { failADC(address); continue; }
    a.startUs=a.pollUs=micros(); a.pending=int8_t(i);
  }
}
int handImu() {
  for (uint8_t n=0;n<2;n++) if (motion[n].initialized) return n;
  return -1;
}
void emitImuRecord(uint32_t seq, uint32_t tUs, const int16_t *x) {
  Quat q=fusion.orientation(); Vec3 ah=fusion.dynAccelHand(), gh=fusion.gyroHand();
  rec::ImuRecord r; memset(&r,0,sizeof r);
  r.type=rec::REC_IMU; r.tUs=tUs; r.seq=seq; memcpy(r.raw,x,sizeof r.raw);
  r.q[0]=q.w; r.q[1]=q.x; r.q[2]=q.y; r.q[3]=q.z;
  r.accH[0]=ah.x; r.accH[1]=ah.y; r.accH[2]=ah.z; r.gyroH[0]=gh.x; r.gyroH[1]=gh.y; r.gyroH[2]=gh.z;
  for (uint8_t f=0;f<5;f++) r.curl[f]=curl[fingerMap.ch[f]]; // finger order: thumb..little
  r.pressure=curl[5]*100.0f;
  recPush(&r,sizeof r);
}
void processImuSample(uint8_t n, bool hand, uint32_t seq, uint32_t tUs, const int16_t *x) {
  Motion &m=motion[n];
  for (uint8_t k=0;k<3;k++) { m.a[k]=x[k]*9.80665f/ACC_LSB_PER_G; m.g[k]=x[k+3]/GYRO_LSB_PER_DPS; }
  m.valid=true; m.at=millis();
  if (calRunning) {
    for (uint8_t k=0;k<3;k++) { mcal[n].a[k]+=m.a[k]; mcal[n].g[k]+=m.g[k]; }
    mcal[n].n++;
  }
  if (!hand) return;
  for (uint8_t k=0;k<6;k++) { int32_t v=abs(int32_t(x[k])); int32_t &peak=k<3 ? diag.peakAcc : diag.peakGyro; if (v>peak) peak=v; }
  // raw counts to g and deg/s; calibration is applied inside the fusion
  Vec3 a={x[0]/ACC_LSB_PER_G,x[1]/ACC_LSB_PER_G,x[2]/ACC_LSB_PER_G}, g={m.g[0],m.g[1],m.g[2]};
  if (fusionStale) { fusion.restart(); fusionStale=false; }
  fusion.update(a,g,imuClock[n].periodUs()*1e-6f); imuSamples++; diag.imuSamples++;
  if (capture.stage!=CAP_NONE) captureImu(a,g);
  if (recActive) emitImuRecord(seq,tUs,x);
}
void imuFail(uint8_t n, int hand) {
  Motion &m=motion[n];
  m.valid=false; m.initialized=false; m.errors++; diag.imuReadErrors++; rescan=true; if ((int)n==hand) fusionStale=true;
}
// Drains each MPU's FIFO. Every sample is read exactly once (a poll loop at the chip's own rate reads some twice and
// misses others), and is stamped from the ESP's clock via SampleClock. A FIFO overflow resets it and is counted.
void tickMotion() {
  static uint32_t previous=0, lastTemp=0;
  uint32_t nowUs=micros();
  if (nowUs-previous<IMU_POLL_US) return;
  previous=nowUs;
  int hand=handImu();
  // A chip that was working and is not any more is retried here every 400 ms, also while streaming (periodic bus scans are
  // off then, and a single failed re-initialisation used to leave the chip dead until the stream was stopped).
  static uint32_t lastRecover=0; uint32_t nowMs=millis();
  if (nowMs-lastRecover>=400) {
    for (uint8_t n=0;n<2;n++) {
      Motion &m=motion[n]; if (!m.wasUp || m.initialized) continue;
      lastRecover=nowMs;
      if (digitalRead(D2)==LOW) { busRecover(); Wire.begin(D2,D1); Wire.setClock(i2cHz); Wire.setClockStretchLimit(1500); }
      if (initMotion(n)) { m.initialized=true; diag.imuRecoveries++; } else diag.imuRecoveryFails++;
    }
  }
  for (uint8_t n=0;n<2;n++) {
    Motion &m=motion[n]; if (!m.initialized) continue;
    uint8_t cb[2];
    if (!readBytes(m.address,0x72,cb,2)) { imuFail(n,hand); continue; }
    uint64_t readUs=now64Us(); uint32_t read32=uint32_t(readUs);
    diag.imuReads++;
    if ((int)n==hand) {
      if (diag.imuLastReadUs) { uint32_t gap=read32-diag.imuLastReadUs; if (gap>diag.imuMaxReadGapUs) diag.imuMaxReadGapUs=gap; }
      diag.imuLastReadUs=read32;
    }
    uint16_t count=(uint16_t(cb[0])<<8)|cb[1];
    if (count>=fifoOverflowBytes(m.id)) { // wrapped: contents may be misaligned, so drop them and count the gap
      diag.imuOverflows++;
      int64_t sinceUs=readUs-imuClock[n].timeOf(imuSeq[n]);
      uint32_t lost=sinceUs>0 ? uint32_t(sinceUs/int64_t(imuClock[n].periodUs())) : 0;
      imuSeq[n]+=lost; diag.imuLostEst+=lost;
      write8(m.address,0x6A,0x04); write8(m.address,0x6A,0x40);
      continue;
    }
    uint8_t left=count/MPU_FIFO_SAMPLE_BYTES;
    if (!left) { // reads succeed but nothing arrives: the chip lost its configuration (reset or brown-out), so set it up again
      if (m.wasUp && millis()-m.lastGoodMs>500) { imuFail(n,hand); diag.imuSilentResets++; }
      continue;
    }
    m.lastGoodMs=millis();
    if (left>diag.imuMaxBatch) diag.imuMaxBatch=left;
    imuClock[n].onRead(imuSeq[n]+left,int64_t(readUs));
    while (left) {
      uint8_t k=left>8 ? 8 : left, b[8*MPU_FIFO_SAMPLE_BYTES];
      if (!readBytes(m.address,0x74,b,k*MPU_FIFO_SAMPLE_BYTES)) { imuFail(n,hand); break; }
      for (uint8_t j=0;j<k;j++) {
        int16_t x[6]; const uint8_t *q=b+j*MPU_FIFO_SAMPLE_BYTES;
        for (uint8_t c=0;c<6;c++) x[c]=int16_t((uint16_t(q[2*c])<<8)|q[2*c+1]);
        uint32_t seq=++imuSeq[n], tUs=uint32_t(imuClock[n].stamp(seq));
        processImuSample(n,(int)n==hand,seq,tUs,x);
      }
      left-=k;
    }
  }
  if (millis()-lastTemp>=500) { // the FIFO carries no temperature; read it now and then
    lastTemp=millis();
    for (uint8_t n=0;n<2;n++) {
      Motion &m=motion[n]; uint8_t tb[2]; if (!m.initialized || !readBytes(m.address,0x41,tb,2)) continue;
      int16_t t=int16_t((uint16_t(tb[0])<<8)|tb[1]);
      m.temp=m.id==0x68 ? t/340.0f+36.53f : t/333.87f+21.0f;
    }
  }
}
bool freshSensor(uint8_t i) {
  return sensor[i].valid && adcOK[SENSOR_ADS[i]-0x48] && millis()-sensor[i].at<1000;
}
const char* sensorStatus(uint8_t i) {
  Sensor &s=sensor[i];
  if (!adcOK[SENSOR_ADS[i]-0x48]) return "ADC missing / read error";
  if (!freshSensor(i)) return "Waiting for fresh sample";
  if (calRunning) return "Calibrating: hold still";
  float latest=s.raw*SENSOR_LSB_V[i];
  if (i<5 && s.raw>=32000) return "Above 1 V: input over range, check the divider";
  if (latest>VCC+0.05f || latest< -0.02f) return "Voltage outside supply range";
  if (latest>VCC-0.05f) return "Near 3.3V: inspect divider";
  if (s.v<0.015f) return i==5 ? "Idle / open: press to test" : "Near 0V: inspect sensor / wiring";
  if (cal[i].ok) {
    float d=s.v-cal[i].mean;
    if (fabsf(d)>restThreshold(i)) return d<0 ? "Below rest value" : "Above rest value";
    return s.responded ? "Back at rest: response observed" : "At rest (calibrated)";
  }
  return s.responded ? "Response observed since reset" : (i==5 ? "Signal present: press to test" : "Signal present: bend to test");
}
String hexAddress(uint8_t a) { char b[5]; snprintf(b,sizeof(b),"0x%02X",a); return String(b); }
void number(String &s,float v,uint8_t digits=3) { if (isfinite(v)) s+=String(v,digits); else s+="null"; }
void handleData() {
  String j; j.reserve(8000);
  j="{\"uptime\":"+String(millis())+",\"scanAge\":"+String(millis()-lastScan)+",\"i2c\":[";
  bool comma=false;
  for (uint8_t a=1;a<127;a++) if (bus[a]) { if(comma) j+=','; j+='"'; j+=hexAddress(a); j+='"'; comma=true; }
  j+="],\"ads\":[";
  for (uint8_t n=0;n<4;n++) {
    if(n) j+=',';
    j+="{\"address\":\""+hexAddress(0x48+n)+"\",\"ack\":"+(bus[0x48+n]?String("true"):String("false"));
    j+=",\"ok\":"; j+=adcOK[n]?"true":"false";
    j+=",\"errors\":"+String(adcErrors[n])+"}";
  }
  j+="],\"sensors\":[";
  for (uint8_t i=0;i<6;i++) {
    Sensor &s=sensor[i]; bool good=freshSensor(i);
    if(i) j+=',';
    j+="{\"name\":\""+String(chName(i))+"\",\"address\":\""+hexAddress(SENSOR_ADS[i])+"\",\"channel\":"+String(SENSOR_CHANNEL[i]);
    j+=",\"valid\":"; j+=good?"true":"false";
    j+=",\"raw\":"; j+=good?String(s.raw):String("null");
    j+=",\"voltage\":"; number(j,good?s.v:NAN,4);
    j+=",\"resistance\":"; number(j,good && s.v>=0.01f && s.v<=VCC ? RFIXED*(VCC/s.v-1):NAN,0);
    j+=",\"status\":\""+String(sensorStatus(i))+"\",\"responded\":";
    j+=good && s.responded?"true":"false";
    Cal &c=cal[i];
    j+=",\"calOk\":"; j+=c.ok?"true":"false";
    j+=",\"calNote\":\""+String(c.note)+"\",\"rest\":"; number(j,c.mean,4);
    j+=",\"noise\":"; number(j,c.sd,4);
    j+=",\"delta\":"; number(j,good && c.ok ? s.v-c.mean : NAN,4);
    j+=",\"lo\":"; number(j,s.lo,4);
    j+=",\"hi\":"; number(j,s.hi,4); j+='}';
  }
  j+="],\"motion\":[";
  for (uint8_t n=0;n<2;n++) {
    Motion &m=motion[n]; bool good=m.valid && millis()-m.at<1000;
    if(n) j+=',';
    j+="{\"address\":\""+hexAddress(m.address)+"\",\"id\":\""+hexAddress(m.id)+"\",\"model\":\""+String(model(m.id))+"\",\"valid\":";
    j+=good?"true":"false"; j+=",\"errors\":"+String(m.errors)+",\"accel\":[";
    for(uint8_t k=0;k<3;k++) { if(k)j+=','; number(j,good?m.a[k]:NAN); }
    j+="],\"gyro\":[";
    for(uint8_t k=0;k<3;k++) { if(k)j+=','; number(j,good?m.g[k]-(mcal[n].ok?mcal[n].g[k]:0):NAN); } // gyro bias removed once calibrated
    j+="],\"temperature\":"; number(j,good?m.temp:NAN,1);
    j+=",\"calOk\":"; j+=mcal[n].ok?"true":"false"; j+=",\"restAccel\":[";
    for(uint8_t k=0;k<3;k++) { if(k)j+=','; number(j,mcal[n].a[k],2); }
    j+="],\"gyroBias\":[";
    for(uint8_t k=0;k<3;k++) { if(k)j+=','; number(j,mcal[n].g[k],2); }
    j+="]}";
  }
  uint32_t elapsed=millis()-calStart, remaining=calRunning && elapsed<CAL_MS ? CAL_MS-elapsed : 0;
  j+="],\"cal\":{\"running\":"; j+=calRunning?"true":"false";
  j+=",\"done\":"; j+=calDone?"true":"false";
  j+=",\"duration\":"+String(CAL_MS)+",\"remaining\":"+String(remaining);
  j+=",\"age\":"+String(calDone?millis()-calEnd:0)+"},\"warnings\":[";
  for(uint8_t w=0;w<warningCount;w++) { if(w)j+=','; j+='"'; j+=warnings[w]; j+='"'; }
  j+="]}"; server.sendHeader("Cache-Control","no-store"); server.send(200,"application/json",j);
}
// ---- Pose calibration steps. Each holds a pose for CAPTURE_MS, then validates and saves. ----
void captureResult(bool ok, const String &msg) {
  capResult.seq++; capResult.ok=ok;
  strlcpy(capResult.msg,msg.c_str(),sizeof(capResult.msg));
  Serial.printf("Pose calibration %s: %s\n",ok?"ok":"FAILED",capResult.msg);
}
// Why the hand did not hold still, or nullptr if it did.
const char* captureMotionProblem(float maxGyro=CAPTURE_MAX_GYRO_RANGE, float maxAccel=CAPTURE_MAX_ACCEL_RANGE) {
  const Capture &c=capture;
  if (c.n<CAPTURE_MIN_IMU) return "motion sensor not streaming";
  for (uint8_t k=0;k<3;k++)
    if (c.gHi[k]-c.gLo[k]>maxGyro || c.aHi[k]-c.aLo[k]>maxAccel) return "hand moved too much, hold steadier and retry";
  return nullptr;
}
Vec3 captureMean(const float *sum) { return {sum[0]/capture.n, sum[1]/capture.n, sum[2]/capture.n}; }
bool flexCaptureOk(uint8_t i) { const Cal &f=capture.flex[i]; return f.n>=15 && f.hi-f.lo<=FLEX_STEADY_ABS_V+FLEX_STEADY_REL*f.mean; }
// A flexed value is accepted when it differs from the open value by at least FLEX_MIN_FRACTION of the resistance and by
// FLEX_MIN_SNR times the noise measured during this capture, so a sensor with a small swing still calibrates if it is quiet.
struct FlexJudge { bool ok; float sep, dV, noiseV; };
FlexJudge judgeFlex(uint8_t ch) {
  FlexJudge j={false,0,0,0}; const Cal &f=capture.flex[ch];
  if (!flexCaptureOk(ch) || calData.openR[ch]<=0) return j;
  float r=flexResistance(f.mean,VCC,RFIXED), ro=calData.openR[ch], vo=VCC*RFIXED/(ro+RFIXED);
  j.sep=fabsf(r-ro)/ro; j.dV=fabsf(f.mean-vo); j.noiseV=fmaxf(f.n>1 ? sqrtf(f.m2/(f.n-1)) : 0, 0.0003f);
  j.ok=j.sep>=FLEX_MIN_FRACTION && j.dV>=FLEX_MIN_SNR*j.noiseV;
  return j;
}
void updateAggregateFlags() {
  if ((calData.flags & CAL_ALL_OPEN)==CAL_ALL_OPEN) calData.flags|=CAL_OPEN; else calData.flags&=~CAL_OPEN;
  if ((calData.flags & CAL_ALL_FLEX)==CAL_ALL_FLEX) calData.flags|=CAL_FIST; else calData.flags&=~CAL_FIST;
}
void finishCapture() {
  CapStage stage=capture.stage; capture.stage=CAP_NONE;
  const Capture &c=capture; String bad; const char* why=nullptr;
  if (stage==CAP_FLAT) { // gyro bias, gravity direction, open-hand flex, palm sensor rest
    why=captureMotionProblem();
    for (uint8_t i=0;i<6;i++) if (!flexCaptureOk(i)) { if (bad.length()) bad+=", "; bad+=chName(i); }
    if (!why) {
      Vec3 a=fusion.correctAccel(captureMean(c.aSum)), g=captureMean(c.gSum); float an=norm(a);
      if (an<0.9f || an>1.1f) why="gravity reading is off, check the motion sensor";
      else {
        calData.gyroBias[0]=g.x; calData.gyroBias[1]=g.y; calData.gyroBias[2]=g.z; calData.flags|=CAL_GYRO;
        fusion.gyroBias=g; fusion.trackRange=3.0f; flatUp=unit(a); flatUpValid=true;
      }
    }
    for (uint8_t i=0;i<5;i++) if (flexCaptureOk(i)) { calData.openR[i]=flexResistance(c.flex[i].mean,VCC,RFIXED); calData.flags|=calOpenBit(i); } // steady fingers are kept even if another was not
    if (flexCaptureOk(5)) calData.forceRest=c.flex[5].mean;
    updateAggregateFlags(); resetProvisional();
    saveCal(calData);
    if (!why && !bad.length()) captureResult(true,"Flat pose saved: gyro bias, gravity and open-hand fingers");
    else captureResult(false,String("Flat pose: ")+(why?String("motion sensor ")+why:String("motion ok"))+(bad.length()?"; unstable "+bad:""));
  } else if (stage==CAP_UP) { // fingers-up pose fixes the sensor-to-hand mounting
    why=captureMotionProblem(HELD_MAX_GYRO_RANGE,HELD_MAX_ACCEL_RANGE);
    if (!why && !flatUpValid) why="do the flat pose first";
    if (!why) {
      Vec3 a=fusion.correctAccel(captureMean(c.aSum)); float an=norm(a);
      Vec3 f=unit(a), z=flatUp;
      if (an<0.9f || an>1.1f) why="gravity reading is off, check the motion sensor";
      else if (fabsf(dot(f,z))>0.7f) why="hand not raised enough: point the fingers straight up";
      else {
        Vec3 x=unit({f.x-z.x*dot(f,z), f.y-z.y*dot(f,z), f.z-z.z*dot(f,z)});
        fusion.mount=qFromBasis(x,cross(z,x),z); fusion.hasMount=true;
        calData.mount[0]=fusion.mount.w; calData.mount[1]=fusion.mount.x; calData.mount[2]=fusion.mount.y; calData.mount[3]=fusion.mount.z;
        calData.flags|=CAL_MOUNT; saveCal(calData);
      }
    }
    if (why) captureResult(false,String("Raise pose: ")+why); else captureResult(true,"Raise pose saved: sensor mounting");
  } else if (stage==CAP_FIST) { // closed-hand flex
    float minSep=1e9f; uint8_t weakest=0, saved=0;
    for (uint8_t i=0;i<5;i++) {
      if (!(calData.flags&calOpenBit(i))) { if (bad.length()) bad+=", "; bad+=chName(i); continue; } // no open value yet
      FlexJudge j=judgeFlex(i);
      if (j.sep<minSep) { minSep=j.sep; weakest=i; }
      if (j.ok) { calData.fistR[i]=flexResistance(c.flex[i].mean,VCC,RFIXED); calData.flags|=calFlexBit(i); saved++; }
      else { if (bad.length()) bad+=", "; bad+=chName(i); }
    }
    updateAggregateFlags(); if (saved) saveCal(calData);
    if (!(calData.flags&CAL_ALL_OPEN) && !saved) captureResult(false,"Fist: do the flat pose first");
    else if (bad.length()) captureResult(false,String("Fist: saved ")+saved+" of 5. Too little change: "+bad+". Calibrate those fingers one by one (open, then flexed).");
    else captureResult(true,String("Fist saved. Smallest range: ")+chName(weakest)+", "+int(minSep*100+0.5f)+"% change");
  } else if (stage==CAP_FINGER) { // one finger, open or flexed, the others left alone
    uint8_t f=c.face>>1, ch=fingerMap.ch[f]; bool flex=c.face&1; const char* nm=NAMES[f];
    if (!flexCaptureOk(ch)) captureResult(false,String(nm)+": the reading was not steady. Hold that finger still for the whole 3 s.");
    else if (!flex) {
      calData.openR[ch]=flexResistance(c.flex[ch].mean,VCC,RFIXED); calData.flags|=calOpenBit(ch); calData.flags&=~calFlexBit(ch); // a new open value needs a new flexed one
      updateAggregateFlags(); saveCal(calData); resetProvisional();
      captureResult(true,String(nm)+" open saved. Now bend it fully and capture the flexed value.");
    } else if (!(calData.flags&calOpenBit(ch))) captureResult(false,String(nm)+": capture its open value first.");
    else {
      FlexJudge j=judgeFlex(ch);
      if (!j.ok) captureResult(false,String(nm)+" flexed: only "+String(j.sep*100,1)+"% change ("+String(j.dV*1000,1)+" mV against "+String(j.noiseV*1000,2)+" mV noise). Bend it further, or check the sensor.");
      else {
        calData.fistR[ch]=flexResistance(c.flex[ch].mean,VCC,RFIXED); calData.flags|=calFlexBit(ch);
        updateAggregateFlags(); saveCal(calData);
        captureResult(true,String(nm)+" flexed saved: "+String(j.sep*100,1)+"% change, "+String(j.dV/j.noiseV,0)+"x the noise.");
      }
    }
  } else if (stage==CAP_PRESS) { // palm sensor: the firm press becomes 100%
    const Cal &f=c.flex[5]; float over=f.mean-calData.forceRest;
    if (!(calData.flags&CAL_OPEN)) captureResult(false,"Palm press: do the flat pose first");
    else if (f.n<15 || over<0.05f) captureResult(false,"Palm press: no pressure seen, press firmly on the palm sensor for the whole 3 s (or check its wiring)");
    else if (f.hi-f.lo>0.6f*over+0.05f) captureResult(false,"Palm press: pressure was not steady, hold a constant firm press");
    else { calData.forceFull=over; calData.flags|=CAL_FORCE; saveCal(calData); captureResult(true,"Palm press saved: this pressure now reads 100%"); }
  } else if (stage==CAP_ACCEL) { // one of six faces; the sixth computes offset and scale per axis
    uint8_t f=c.face, axis=f/2; float sign=(f&1) ? -1.0f : 1.0f;
    why=captureMotionProblem();
    if (!why) {
      float m[3]={c.aSum[0]/c.n,c.aSum[1]/c.n,c.aSum[2]/c.n};
      bool ok=m[axis]*sign>0.8f; for (uint8_t k=0;k<3;k++) if (k!=axis && fabsf(m[k])>0.35f) ok=false;
      if (ok) { accFace[f]=m[axis]; faceMask|=1<<f; } else why="wrong orientation for this face";
    }
    if (why) captureResult(false,String("Accel ")+FACE_NAMES[f]+": "+why);
    else if (faceMask!=0x3F) captureResult(true,String("Accel ")+FACE_NAMES[f]+" captured, "+__builtin_popcount(faceMask)+" of 6");
    else {
      float off[3], scale[3]; bool ok=true;
      for (uint8_t k=0;k<3;k++) {
        float span=accFace[2*k]-accFace[2*k+1];
        if (span<1.6f || span>2.4f) ok=false; else { off[k]=(accFace[2*k]+accFace[2*k+1])/2; scale[k]=2/span; }
      }
      faceMask=0;
      if (!ok) captureResult(false,"Accel: faces disagree, start the six faces again");
      else {
        for (uint8_t k=0;k<3;k++) { calData.accOff[k]=off[k]; calData.accScale[k]=scale[k]; }
        calData.flags|=CAL_ACCEL; saveCal(calData); applyCal(); flatUpValid=false;
        captureResult(true,"Accelerometer saved. Redo the flat and raise poses.");
      }
    }
  }
}
const char* startCapture(CapStage stage, uint8_t face=0) { // nullptr when started, else the reason not
  if (calRunning || capture.stage!=CAP_NONE) return "Another calibration is running";
  if (stage!=CAP_FIST && stage!=CAP_PRESS && stage!=CAP_FINGER && handImu()<0) return "Motion sensor not available";
  capture=Capture(); capture.stage=stage; capture.face=face; capture.start=millis();
  Serial.printf("Pose calibration '%s' started: hold the pose still for %u s.\n",CAP_NAMES[stage],CAPTURE_MS/1000);
  return nullptr;
}
void sendStatus(int16_t only=-1);
void replyCapture(CapStage stage, uint8_t face=0) {
  const char* err=startCapture(stage,face);
  server.send(err ? 409 : 202,"text/plain",err ? err : "Capture started");
  if (!err) sendStatus();
}

// ---- WebSocket stream: a pose frame at ~30 Hz, a status frame at 2 Hz and on connect ----
bool imuFresh() { int h=handImu(); return h>=0 && motion[h].valid && millis()-motion[h].at<500; }
// Text to every client that can take it right now (see RecServer): a stalled client is skipped, never waited for.
void broadcastText(const char *text) {
  size_t need=strlen(text)+8;
  for (uint8_t num=0;num<WEBSOCKETS_SERVER_CLIENT_MAX;num++) {
    if (!ws.canSend(num,need)) { if (ws.isConnected(num)) textSkipped++; continue; }
    ws.sendTXT(num,text);
  }
}
void sendStatus(int16_t only) {
  if (!ws.connectedClients()) return;
  uint32_t elapsed=millis()-capture.start, left=capture.stage!=CAP_NONE && elapsed<CAPTURE_MS ? CAPTURE_MS-elapsed : 0;
  int h=handImu(); char buf[640];
  snprintf(buf,sizeof(buf),"{\"t\":\"s\",\"imu\":%u,\"addr\":%u,\"flags\":%u,\"faces\":%u,\"hz\":[%u,%u],"
    "\"map\":[%u,%u,%u,%u,%u],\"rec\":{\"on\":%u,\"drop\":%lu,\"blk\":%lu},"
    "\"cap\":{\"stage\":\"%s\",\"face\":%u,\"left\":%lu,\"total\":%u},\"res\":{\"seq\":%lu,\"ok\":%u,\"msg\":\"%s\"}}",
    imuFresh(),h>=0?motion[h].address:0,calData.flags,faceMask,imuHz,adcHz,
    fingerMap.ch[0],fingerMap.ch[1],fingerMap.ch[2],fingerMap.ch[3],fingerMap.ch[4],
    recActive,(unsigned long)recDropped,(unsigned long)recBlocked,
    CAP_NAMES[capture.stage],capture.face,(unsigned long)left,CAPTURE_MS,(unsigned long)capResult.seq,capResult.ok,capResult.msg);
  if (only>=0) { if (ws.canSend(uint8_t(only),strlen(buf)+8)) ws.sendTXT(uint8_t(only),buf); } else broadcastText(buf);
}
void sendPose() {
  if (!ws.connectedClients()) return;
  Quat q=fusion.orientation(); if (q.w<0) q={-q.w,-q.x,-q.y,-q.z};
  uint8_t mask=imuFresh() ? 1 : 0; // bit 0 motion, bits 1-5 flex, bit 6 palm sensor
  for (uint8_t i=0;i<6;i++) if (freshSensor(i)) mask|=2<<i;
  char buf[300]; // r: filtered divider volts per channel, for the viewer's per-finger check
  snprintf(buf,sizeof(buf),"{\"t\":\"p\",\"ms\":%lu,\"q\":[%.4f,%.4f,%.4f,%.4f],\"c\":[%.3f,%.3f,%.3f,%.3f,%.3f],\"p\":%.3f,\"v\":%u,\"r\":[%.4f,%.4f,%.4f,%.4f,%.4f,%.4f]}",
    (unsigned long)millis(),q.w,q.x,q.y,q.z,curl[0],curl[1],curl[2],curl[3],curl[4],curl[5],mask,
    sensor[0].v,sensor[1].v,sensor[2].v,sensor[3].v,sensor[4].v,sensor[5].v);
  broadcastText(buf);
}
// Record stream control: a client sends the text "rec:start" or "rec:stop". One recorder at a time.
void recStop() { recActive=false; recUdpMode=false; recClient=-1; recRing.clear(); udpPendingLen=0; }
// lwIP lets a peer's ARP entry expire on a timer and, while it re-resolves, holds outgoing data. Through a WiFi AP that
// broadcast can take about a second (power-saving clients only hear broadcasts at the DTIM beacon), which stalled the
// record stream for ~1.2 s every 10 s. Asking again well before expiry refreshes the entry while the old one still works.
uint32_t arpRefreshes=0;
void refreshArp() {
  static uint32_t last=0; uint32_t t=millis();
  if (!recActive || t-last<2000) return;
  last=t; IPAddress ip=ws.clientIP(uint8_t(recClient)); if (!ip.isSet() || !netif_default) return;
  ip4_addr_t a; a.addr=uint32_t(ip); etharp_request(netif_default,&a); arpRefreshes++;
}
void recReply(uint8_t num, bool on, const char *err) {
  char buf[120];
  snprintf(buf,sizeof(buf),"{\"t\":\"rec\",\"on\":%u,\"boot\":%lu,\"v\":%u,\"err\":\"%s\"}",on,(unsigned long)recBootId,rec::VERSION,err);
  ws.sendTXT(num,buf);
}
void recStart(uint8_t num, uint16_t udpPort) { // udpPort 0: records go back over this WebSocket
  if (recActive && recClient!=num) { recReply(num,false,"another client is recording"); return; }
  if (noise.active) { recReply(num,false,"noise test running"); return; }
  recRing.clear(); recClient=num; recActive=true; recLastFlush=millis();
  recUdpMode=udpPort!=0; recUdpPort=udpPort; recUdpIp=ws.clientIP(num); // datagrams go to the controlling client's address
  recReply(num,true,"");
}
// Sends one packet when enough has collected (or 20 ms passed), but only if the client's TCP buffer can take it now.
// Records stay in the ring while blocked; the ring refuses new ones when full and recDropped counts them.
void recFlush() {
  if (!recActive) return;
  uint32_t t=millis();
  if (recUdpMode) { // one record packet per datagram, never waiting for the network
    auto sendNow = [&](size_t n) { return recUdp.beginPacket(recUdpIp,recUdpPort) && recUdp.write(recPacket,n)==n && recUdp.endPacket(); };
    if (udpPendingLen) { // the stack refused it: one more try after 10 ms, when its send queue has had time to drain
      if (t-udpPendingAt<10) return;
      if (sendNow(udpPendingLen)) udpSent++; else udpFail++; // a second failure is final: the sequence jump shows the loss
      udpPendingLen=0;
    }
    // Paced like the usual ESP8266 UDP streaming advice: one larger datagram per loop pass, never a burst, so the WiFi
    // stack gets to run between sends. About 1000 bytes (25 per second) instead of 60 small ones.
    if (recRing.used>=950 || (recRing.used && t-recLastFlush>=40)) {
      size_t n=rec::buildPacket(recRing,recPacket,1000,recPacketSeq,recBootId,recDropped,now64Us());
      if (!n) return;
      recPacketSeq++; recLastFlush=t;
      if (sendNow(n)) udpSent++;
      else { udpPendingLen=n; udpPendingAt=t; udpRetried++; }
    }
    return;
  }
  if (recRing.used<420 && t-recLastFlush<20) return;
  if (!recRing.used) { recLastFlush=t; return; }
  // The default lwIP build has a 536 byte TCP segment and a ~1072 byte send buffer, so a packet must be well under
  // that or canSend() could never be true. ~500 bytes = one segment, and two can be in flight.
  const size_t maxPacket=520;
  size_t want=recRing.used+sizeof(rec::PacketHeader); if (want>maxPacket) want=maxPacket;
  if (!ws.canSend(uint8_t(recClient),want+WEBSOCKETS_MAX_HEADER_SIZE)) { recBlocked++; recLastFlush=t; return; }
  size_t n=rec::buildPacket(recRing,recPacket+WEBSOCKETS_MAX_HEADER_SIZE,maxPacket,recPacketSeq,recBootId,recDropped,now64Us());
  if (!n) return;
  recPacketSeq++; recLastFlush=t;
  ws.sendBIN(uint8_t(recClient),recPacket,n,true); // with headerToPayload the pointer is the buffer start, payload begins 14 bytes in
}
void onWebSocket(uint8_t num, WStype_t type, uint8_t *payload, size_t length) {
  if (type==WStype_CONNECTED) sendStatus(num);
  else if (type==WStype_DISCONNECTED) { if (num==recClient) recStop(); }
  else if (type==WStype_TEXT) {
    if (length>=9 && !memcmp(payload,"rec:start",9)) { // "rec:start" or "rec:start:<udp port>"
      uint32_t port=0; if (length>10 && payload[9]==':') for (size_t i=10;i<length && payload[i]>='0' && payload[i]<='9';i++) port=port*10+(payload[i]-'0');
      recStart(num,port<65536 ? uint16_t(port) : 0);
    }
    else if (length==8 && !memcmp(payload,"rec:stop",8) && num==recClient) { recStop(); recReply(num,false,""); }
  }
}

// ---- Read-only calibration snapshot and diagnostics (JSON over HTTP) ----
void numbers(String &j, const float *v, uint8_t n, uint8_t digits) {
  j+='['; for (uint8_t i=0;i<n;i++) { if (i) j+=','; j+=String(v[i],digits); } j+=']';
}
void handleCalibration() {
  String j; j.reserve(2400); const CalData &c=calData; int h=handImu();
  j="{\"fw\":\""+String(FW_VERSION)+"\",\"build\":\""+String(__DATE__)+" "+String(__TIME__)+"\",\"boot_id\":"+String(recBootId)+",\"uptime_ms\":"+String(millis());
  j+=",\"cal_version\":"+String(c.version)+",\"flags\":"+String(c.flags)+",\"calibrated\":{";
  j+="\"gyro\":"; j+=(c.flags&CAL_GYRO)?"true":"false"; j+=",\"accel\":"; j+=(c.flags&CAL_ACCEL)?"true":"false";
  j+=",\"mount\":"; j+=(c.flags&CAL_MOUNT)?"true":"false"; j+=",\"open\":"; j+=(c.flags&CAL_OPEN)?"true":"false";
  j+=",\"fist\":"; j+=(c.flags&CAL_FIST)?"true":"false"; j+=",\"force\":"; j+=(c.flags&CAL_FORCE)?"true":"false";
  j+="},\"cal_accel_range_g\":"+String(c.accelRangeG)+",\"cal_gyro_range_dps\":"+String(c.gyroRangeDps);
  j+=",\"mount_q_wxyz\":"; numbers(j,c.mount,4,6);
  j+=",\"gyro_bias_dps\":"; numbers(j,c.gyroBias,3,4);
  j+=",\"acc_offset_g\":"; numbers(j,c.accOff,3,5);
  j+=",\"acc_scale\":"; numbers(j,c.accScale,3,5);
  j+=",\"open_ohm_by_channel\":"; numbers(j,c.openR,5,0);
  j+=",\"fist_ohm_by_channel\":"; numbers(j,c.fistR,5,0);
  j+=",\"finger_open\":["; for (uint8_t f=0;f<5;f++) { if (f) j+=','; j+=(c.flags&calOpenBit(fingerMap.ch[f]))?"true":"false"; }
  j+="],\"finger_flex\":["; for (uint8_t f=0;f<5;f++) { if (f) j+=','; j+=(c.flags&calFlexBit(fingerMap.ch[f]))?"true":"false"; } j+=']';
  j+=",\"force_rest_v\":"+String(c.forceRest,4)+",\"force_full_v\":"+String(c.forceFull,4);
  j+=",\"finger_to_channel\":["+String(fingerMap.ch[0])+","+String(fingerMap.ch[1])+","+String(fingerMap.ch[2])+","+String(fingerMap.ch[3])+","+String(fingerMap.ch[4])+"]";
  j+=",\"imu\":{\"present\":"; j+=h>=0?"true":"false";
  j+=",\"address\":"+String(h>=0?motion[h].address:0)+",\"who_am_i\":"+String(h>=0?motion[h].id:0);
  j+=",\"accel_range_g\":"+String(MPU_ACCEL_RANGE_G)+",\"gyro_range_dps\":"+String(MPU_GYRO_RANGE_DPS);
  j+=",\"acc_lsb_per_g\":"+String(ACC_LSB_PER_G,1)+",\"gyro_lsb_per_dps\":"+String(GYRO_LSB_PER_DPS,2);
  j+=",\"nominal_rate_hz\":200,\"model\":\""+String(h>=0?model(motion[h].id):"none")+"\",\"dlpf_accel_hz\":"+String(h>=0 && motion[h].id!=0x68?99:94)+",\"dlpf_gyro_hz\":"+String(h>=0 && motion[h].id!=0x68?92:98)+",\"fifo_bytes\":"+String(h>=0 && motion[h].id!=0x68?512:1024);
  j+=",\"measured_period_us\":"+String(h>=0?imuClock[h].periodUs():0.0f,2)+"}";
  j+=",\"adc\":{\"sps\":"+String(ADC_SPS[adcDr])+",\"conv_us\":"+String(ADC_CONV_US[adcDr])+",\"vcc\":"+String(VCC,2)+",\"divider_ohm\":"+String(RFIXED,0)+",\"channels\":[";
  for (uint8_t i=0;i<6;i++) {
    if (i) j+=',';
    j+="{\"ch\":"+String(i)+",\"chip\":"+String(SENSOR_ADS[i])+",\"pin\":"+String(SENSOR_CHANNEL[i])+",\"full_scale_v\":"+String(i<5?1.024f:4.096f,3)+",\"lsb_v\":"+String(SENSOR_LSB_V[i]*1e6f,2)+"e-6}";
  }
  j+="]},\"i2c_hz\":"+String(i2cHz);
  j+=",\"record\":{\"version\":"+String(rec::VERSION)+",\"packet_header_bytes\":"+String(sizeof(rec::PacketHeader))+",\"imu_record_bytes\":"+String(sizeof(rec::ImuRecord))+",\"adc_record_bytes\":"+String(sizeof(rec::AdcRecord));
  j+=",\"curl_order\":\"thumb,index,middle,ring,little\",\"adc_channel_order\":\"hardware sensor index, see finger_to_channel\",\"derived_frame\":\"hand\"}}";
  server.sendHeader("Cache-Control","no-store"); server.send(200,"application/json",j);
}
void handleDiag() {
  String j; j.reserve(1900); float secs=(millis()-diag.startMs)/1000.0f; if (secs<0.001f) secs=0.001f; // fractional: whole seconds overstated every rate
  j="{\"since_reset_s\":"+String(secs,2)+",\"imu\":{\"samples\":"+String(diag.imuSamples)+",\"rate_hz\":"+String(float(diag.imuSamples)/secs,1)+",\"reads\":"+String(diag.imuReads);
  j+=",\"fifo_overflows\":"+String(diag.imuOverflows)+",\"lost_samples_est\":"+String(diag.imuLostEst)+",\"read_errors\":"+String(diag.imuReadErrors)+",\"recoveries\":"+String(diag.imuRecoveries)+",\"recovery_fails\":"+String(diag.imuRecoveryFails)+",\"silent_resets\":"+String(diag.imuSilentResets);
  j+=",\"max_gap_between_reads_us\":"+String(diag.imuMaxReadGapUs)+",\"max_samples_per_read\":"+String(diag.imuMaxBatch);
  j+=",\"peak_accel_counts\":"+String(diag.peakAcc)+",\"peak_gyro_counts\":"+String(diag.peakGyro);
  j+=",\"peak_accel_g\":"+String(diag.peakAcc/ACC_LSB_PER_G,2)+",\"peak_gyro_dps\":"+String(diag.peakGyro/GYRO_LSB_PER_DPS,0)+"},\"adc\":{\"channels\":[";
  for (uint8_t i=0;i<6;i++) {
    if (i) j+=',';
    j+="{\"ch\":"+String(i)+",\"samples\":"+String(diag.adcCount[i])+",\"rate_hz\":"+String(float(diag.adcCount[i])/secs,1)+",\"max_gap_us\":"+String(diag.adcMaxGapUs[i])+"}";
  }
  j+="],\"loops_per_s\":"+String(diag.loops/secs,0)+",\"chip_errors\":["+String(adcErrors[0])+","+String(adcErrors[1])+"]},\"loop_max_gap_us\":"+String(diag.loopMaxUs)+",\"bus_scans\":"+String(diag.scans);
  j+=",\"wifi\":{\"ssid\":\""+WiFi.SSID()+"\",\"channel\":"+String(WiFi.channel())+",\"rssi_dbm\":"+String(WiFi.RSSI())+",\"rssi_min_dbm\":"+String(diag.rssiN?diag.rssiMin:0)+",\"rssi_avg_dbm\":"+String(diag.rssiN?float(diag.rssiSum)/diag.rssiN:0.0f,1)+"}";
  j+=",\"i2c_hz\":"+String(i2cHz)+",\"free_heap\":"+String(ESP.getFreeHeap())+",\"min_free_heap\":"+String(diag.minHeap)+",\"max_free_block\":"+String(ESP.getMaxFreeBlockSize());
  j+=",\"record\":{\"active\":"; j+=recActive?"true":"false";
  j+=",\"packets\":"+String(recPacketSeq)+",\"dropped_records\":"+String(recDropped)+",\"blocked_flushes\":"+String(recBlocked)+",\"text_frames_skipped\":"+String(textSkipped);
  j+=",\"arp_refreshes\":"+String(arpRefreshes)+",\"ring_peak_bytes\":"+String(recRing.peak)+",\"ring_bytes\":"+String(sizeof(recRing.buf))+",\"transport\":\""+(recUdpMode?"udp":"websocket")+"\",\"udp_sent\":"+String(udpSent)+",\"udp_failed\":"+String(udpFail)+",\"udp_retried\":"+String(udpRetried)+"}}";
  server.sendHeader("Cache-Control","no-store"); server.send(200,"application/json",j);
}
void diagReset() {
  diag=Diag(); diag.startMs=millis(); diag.minHeap=ESP.getFreeHeap();
  recDropped=recBlocked=textSkipped=udpSent=udpFail=udpRetried=0; recRing.peak=0;
  for (uint8_t n=0;n<2;n++) adcErrors[n]=0, motion[n].errors=0;
}
void handleNoise() {
  String j; j.reserve(1800); uint8_t shown=noise.done ? 4 : noise.step;
  j=String("{\"running\":")+(noise.active?"true":"false")+",\"done\":"+(noise.done?"true":"false")+",\"step\":"+String(noise.step)+",\"results\":[";
  for (uint8_t d=0;d<shown;d++) {
    if (d) j+=',';
    float secs=(noise.durMs-NOISE_SETTLE_MS)/1000.0f;
    j+="{\"sps\":"+String(ADC_SPS[d])+",\"rate_hz\":[";
    for (uint8_t i=0;i<6;i++) { if (i) j+=','; j+=String(noise.st[d][i].n/secs,1); }
    j+="],\"mean_counts\":[";
    for (uint8_t i=0;i<6;i++) { if (i) j+=','; j+=String(noise.st[d][i].mean,1); }
    j+="],\"sd_counts\":[";
    for (uint8_t i=0;i<6;i++) { const NoiseStat &t=noise.st[d][i]; if (i) j+=','; j+=String(t.n>1 ? sqrtf(t.m2/(t.n-1)) : 0.0f,2); }
    j+="],\"range_counts\":[";
    for (uint8_t i=0;i<6;i++) { const NoiseStat &t=noise.st[d][i]; if (i) j+=','; j+=String(t.hi-t.lo); }
    j+="]}";
  }
  j+="]}";
  server.sendHeader("Cache-Control","no-store"); server.send(200,"application/json",j);
}
void setup() {
  Serial.begin(115200); delay(300); // let the hand-box supply and ADDR pins settle before the first scan
  busRecover();
  EEPROM.begin(MAP_OFFSET+sizeof(MapData));
  bool legacyMap=false;
  if (!loadMap(fingerMap,legacyMap)) { fingerMap=MapData(); Serial.println("No saved finger map: using channel order. Run Identify fingers in the 3D viewer."); }
  else if (legacyMap) { saveMap(fingerMap); Serial.println("Finger map moved to its new EEPROM slot."); }
  for (uint8_t i=0;i<6;i++) { uint8_t c=SENSOR_ADS[i]-0x48; chipSensors[c][chipCount[c]++]=i; }
  recBootId=RANDOM_REG32; diag.startMs=millis();
  if (loadCal(calData)) {
    if (calData.flags & CAL_OPEN) calData.flags|=CAL_ALL_OPEN; // saved before per-finger calibration: all five were done together
    if (calData.flags & CAL_FIST) calData.flags|=CAL_ALL_FLEX;
    Serial.printf("Loaded saved calibration (flags 0x%04X).\n",calData.flags);
  }
  else Serial.println("No saved calibration: run the pose calibration in the 3D viewer.");
  applyCal();
  curlFilter[5].minCutoff=0.8f; curlFilter[5].beta=1.0f; // pressure is steadier than finger motion
  Wire.begin(D2,D1); Wire.setClock(i2cHz); Wire.setClockStretchLimit(1500);
  motion[0].address=0x68; motion[1].address=0x69; scanBus();
  WiFi.persistent(false); WiFi.mode(WIFI_STA); WiFi.setAutoReconnect(true);
  WiFi.setSleepMode(WIFI_NONE_SLEEP); // modem sleep adds tens of ms of jitter to the pose stream
  WiFi.begin(WIFI_SSID,WIFI_PASSWORD);
  Serial.println("Connecting to WiFi; dashboard address will print when connected.");
  server.on("/",HTTP_GET,[](){server.send_P(200,"text/html",VIEWER_PAGE);});
  server.on("/bench",HTTP_GET,[](){server.send_P(200,"text/html",PAGE);});
  server.on("/data",HTTP_GET,handleData);
  server.on("/api/cal/flat",HTTP_POST,[](){replyCapture(CAP_FLAT);});
  server.on("/api/cal/up",HTTP_POST,[](){replyCapture(CAP_UP);});
  server.on("/api/cal/fist",HTTP_POST,[](){replyCapture(CAP_FIST);});
  server.on("/api/cal/press",HTTP_POST,[](){replyCapture(CAP_PRESS);});
  server.on("/api/cal/finger",HTTP_POST,[](){ // f=0..4 (thumb..little), pose=open|flex
    int f=server.arg("f").toInt(); String pose=server.arg("pose");
    if (!server.hasArg("f") || f<0 || f>4 || (pose!="open" && pose!="flex")) { server.send(400,"text/plain","f must be 0-4 and pose open or flex"); return; }
    replyCapture(CAP_FINGER,uint8_t(f*2+(pose=="flex" ? 1 : 0)));
  });
  server.on("/api/cal/accel",HTTP_POST,[](){
    int face=server.arg("face").toInt();
    if (!server.hasArg("face") || face<0 || face>5) { server.send(400,"text/plain","face must be 0-5"); return; }
    replyCapture(CAP_ACCEL,uint8_t(face));
  });
  server.on("/api/cal/clear",HTTP_POST,[](){
    if (capture.stage!=CAP_NONE) { server.send(409,"text/plain","Another calibration is running"); return; }
    calData=CalData(); saveCal(calData); applyCal();
    flatUpValid=false; faceMask=0; fusionStale=true; resetProvisional();
    server.send(200,"text/plain","Calibration cleared");
  });
  server.on("/api/map",HTTP_POST,[](){ // m=a,b,c,d,e: ADC channel for thumb..little
    String m=server.arg("m"); uint8_t ch[5]; int n=0, pos=0;
    while (n<5 && pos<=(int)m.length()) {
      int comma=m.indexOf(',',pos); if (comma<0) comma=m.length();
      String part=m.substring(pos,comma); if (part.length()!=1) break;
      ch[n++]=uint8_t(part.toInt()); pos=comma+1;
    }
    if (n!=5 || pos!=(int)m.length()+1 || !validMap(ch)) { server.send(400,"text/plain","m must list channels 0-4 once each, e.g. 0,1,2,3,4"); return; }
    memcpy(fingerMap.ch,ch,5); saveMap(fingerMap); sendStatus();
    server.send(200,"text/plain","Finger map saved");
  });
  server.on("/api/heading",HTTP_POST,[](){fusion.resetHeading(); server.send(200,"text/plain","Heading reset");});
  server.on("/api/calibration",HTTP_GET,handleCalibration);
  server.on("/api/diag",HTTP_GET,handleDiag);
  server.on("/api/diag/reset",HTTP_POST,[](){diagReset(); server.send(200,"text/plain","Diagnostics reset");});
  server.on("/api/diag/imu_drop",HTTP_POST,[](){ // test only: puts the hand MPU into the state the old firmware could not leave while streaming
    int h=handImu(); if (h>=0) { motion[h].initialized=false; motion[h].valid=false; }
    server.send(200,"text/plain","hand MPU marked down; it should come back by itself within about 1 s");
  });
  server.on("/api/diag/noise",HTTP_GET,handleNoise);
  server.on("/api/diag/noise",HTTP_POST,[](){ // resting noise at each ADC data rate: keep the glove still
    if (noise.active || recActive || capture.stage!=CAP_NONE) { server.send(409,"text/plain","Busy"); return; }
    uint32_t ms=server.hasArg("ms") ? server.arg("ms").toInt() : 3000; if (ms<1000 || ms>20000) ms=3000;
    noise=NoiseRun(); noise.active=true; noise.durMs=ms; noise.savedDr=adcDr; adcDr=0; noise.startMs=millis();
    server.send(202,"text/plain","Noise test started");
  });
  server.on("/api/diag/i2c",HTTP_POST,[](){ // hz=100000|400000
    uint32_t hz=server.arg("hz").toInt();
    if (hz!=100000 && hz!=400000) { server.send(400,"text/plain","hz must be 100000 or 400000"); return; }
    i2cHz=hz; Wire.setClock(hz); server.send(200,"text/plain","I2C clock set");
  });
  server.on("/api/diag/adc",HTTP_POST,[](){ // dr=0..3 -> 128/250/475/860 SPS
    int dr=server.arg("dr").toInt();
    if (!server.hasArg("dr") || dr<0 || dr>3 || noise.active) { server.send(400,"text/plain","dr must be 0-3 and no noise test running"); return; }
    adcDr=uint8_t(dr); server.send(200,"text/plain","ADC data rate set");
  });
  ws.begin(); ws.onEvent(onWebSocket); ws.enableHeartbeat(15000,3000,2);
  server.on("/reset",HTTP_POST,[](){
    for(uint8_t i=0;i<6;i++) sensor[i]=Sensor();
    server.send(200,"text/plain","Response tests reset");
  });
  server.on("/scan",HTTP_POST,[](){rescan=true;server.send(202,"text/plain","Scan requested");});
  server.on("/calibrate",HTTP_POST,[](){
    if (calRunning) { server.send(200,"text/plain","Calibration already running"); return; }
    startCalibration();
    server.send(200,"text/plain","Calibration started: hold the glove still for 5 s");
  });
  server.begin();
}
void loop() {
  static uint32_t prevLoopUs=0;
  uint32_t loopUs=micros();
  if (prevLoopUs && loopUs-prevLoopUs>diag.loopMaxUs) diag.loopMaxUs=loopUs-prevLoopUs;
  prevLoopUs=loopUs; diag.loops++;
  now64Us(); // keeps the wrap counter fed
  server.handleClient(); ws.loop(); MDNS.update(); tickADC(); tickMotion(); recFlush(); refreshArp(); tickNoise();
  uint32_t heap=ESP.getFreeHeap(); if (heap<diag.minHeap) diag.minHeap=heap;
  static uint32_t lastRssi=0;
  if (millis()-lastRssi>=500 && WiFi.status()==WL_CONNECTED) { lastRssi=millis(); int8_t r=WiFi.RSSI(); diag.rssiSum+=r; if (!diag.rssiN++ || r<diag.rssiMin) diag.rssiMin=r; }
  if (calRunning && millis()-calStart>=CAL_MS) finishCalibration();
  if (capture.stage!=CAP_NONE && millis()-capture.start>=CAPTURE_MS) finishCapture();
  static bool connected=false;
  bool current=WiFi.status()==WL_CONNECTED;
  if(current && !connected) {
    Serial.print("3D viewer: http://"); Serial.println(WiFi.localIP());
    MDNS.end(); if (MDNS.begin("glove")) { MDNS.addService("http","tcp",80); Serial.println("Also at http://glove.local/ (bench: /bench)"); }
  }
  connected=current;
  static uint32_t lastPose=0, lastStatus=0, lastRate=0, lastResultSent=0;
  uint32_t t=millis();
  if (t-lastPose>=POSE_PERIOD_MS) { lastPose=t; sendPose(); }
  if (t-lastStatus>=STATUS_PERIOD_MS || (capture.stage==CAP_NONE && capResult.seq!=lastResultSent)) { lastStatus=t; lastResultSent=capResult.seq; sendStatus(); }
  if (t-lastRate>=1000) { imuHz=imuSamples; adcHz=adcSamples/6; imuSamples=adcSamples=0; lastRate=t; }
  static uint32_t report=0;
  if(millis()-report>=2000 && !recActive) { // serial output can block for tens of ms, so it stays quiet while recording
    report=millis();
    if(!current) Serial.println("WiFi unavailable; retrying. Sensor acquisition continues.");
    for(uint8_t i=0;i<6;i++) {
      if(freshSensor(i)) Serial.printf("%s %.3fV: %s\n",chName(i),sensor[i].v,sensorStatus(i));
      else Serial.printf("%s: %s\n",chName(i),sensorStatus(i));
    }
    for(uint8_t n=0;n<2;n++) Serial.printf("MPU 0x%02X ID 0x%02X %s: %s\n",motion[n].address,motion[n].id,model(motion[n].id),motion[n].valid?"reading":"unavailable");
  }
  yield();
}
