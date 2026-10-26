#pragma once
// Pure math for the glove: no Arduino dependencies, so it can be unit-tested on a host.
//
// Frames (right-handed, REP-103 style):
//   World W: X forward (set by "reset heading"), Y left, Z up.
//   Sensor S: the MPU axes as soldered.
//   Hand H: X toward the fingertips, Y toward the thumb side when palm-down, Z out of the back of the hand.
//   At the flat calibration pose, H == W.
// Quaternions are Hamilton, unit length, and q_AB rotates vectors from frame B into frame A.
#include <math.h>
#include <stdint.h>

const float DEG2RAD = 0.017453292f, RAD2DEG = 57.295780f;

struct Vec3 { float x = 0, y = 0, z = 0; };
struct Quat { float w = 1, x = 0, y = 0, z = 0; };

inline float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
inline float dot(const Vec3 &a, const Vec3 &b) { return a.x*b.x + a.y*b.y + a.z*b.z; }
inline Vec3 cross(const Vec3 &a, const Vec3 &b) { return {a.y*b.z - a.z*b.y, a.z*b.x - a.x*b.z, a.x*b.y - a.y*b.x}; }
inline float norm(const Vec3 &a) { return sqrtf(dot(a, a)); }
inline Vec3 scaled(const Vec3 &a, float s) { return {a.x*s, a.y*s, a.z*s}; }
inline Vec3 unit(const Vec3 &a) { float n = norm(a); return n > 1e-6f ? scaled(a, 1/n) : Vec3(); }

inline Quat qMul(const Quat &a, const Quat &b) {
  return {a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z,
          a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,
          a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
          a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w};
}
inline Quat qConj(const Quat &q) { return {q.w, -q.x, -q.y, -q.z}; }
inline Quat qNormalized(Quat q) {
  float n = sqrtf(q.w*q.w + q.x*q.x + q.y*q.y + q.z*q.z);
  if (n < 1e-9f) return Quat();
  float s = 1/n; return {q.w*s, q.x*s, q.y*s, q.z*s};
}
// Rotate a vector by q (v_A = q_AB v_B).
inline Vec3 qRotate(const Quat &q, const Vec3 &v) {
  Quat r = qMul(qMul(q, Quat{0, v.x, v.y, v.z}), qConj(q));
  return {r.x, r.y, r.z};
}
inline Quat qFromAxisAngle(const Vec3 &axis, float angle) {
  float s = sinf(angle/2); return {cosf(angle/2), axis.x*s, axis.y*s, axis.z*s};
}
// Shortest rotation taking unit vector a onto unit vector b.
inline Quat qBetween(const Vec3 &a, const Vec3 &b) {
  float d = dot(a, b);
  if (d < -0.9999f) { // opposite: any axis perpendicular to a will do
    Vec3 axis = unit(cross(a, fabsf(a.x) < 0.9f ? Vec3{1,0,0} : Vec3{0,1,0}));
    return {0, axis.x, axis.y, axis.z};
  }
  Vec3 c = cross(a, b);
  return qNormalized({1 + d, c.x, c.y, c.z});
}
// Rotation whose columns are the given orthonormal basis vectors (the new frame's axes in the old frame).
inline Quat qFromBasis(const Vec3 &xs, const Vec3 &ys, const Vec3 &zs) {
  float m00=xs.x, m01=ys.x, m02=zs.x, m10=xs.y, m11=ys.y, m12=zs.y, m20=xs.z, m21=ys.z, m22=zs.z;
  float tr = m00 + m11 + m22; Quat q;
  if (tr > 0) { float s = sqrtf(tr + 1)*2; q = {0.25f*s, (m21-m12)/s, (m02-m20)/s, (m10-m01)/s}; }
  else if (m00 > m11 && m00 > m22) { float s = sqrtf(1 + m00 - m11 - m22)*2; q = {(m21-m12)/s, 0.25f*s, (m01+m10)/s, (m02+m20)/s}; }
  else if (m11 > m22) { float s = sqrtf(1 + m11 - m00 - m22)*2; q = {(m02-m20)/s, (m01+m10)/s, 0.25f*s, (m12+m21)/s}; }
  else { float s = sqrtf(1 + m22 - m00 - m11)*2; q = {(m10-m01)/s, (m02+m20)/s, (m12+m21)/s, 0.25f*s}; }
  return qNormalized(q);
}
inline float qYaw(const Quat &q) { return atan2f(2*(q.w*q.z + q.x*q.y), 1 - 2*(q.y*q.y + q.z*q.z)); }

// One Euro filter (Casiez et al., CHI 2012): heavy smoothing while the signal is still, light while it moves.
struct OneEuro {
  float minCutoff, beta, dCutoff; // Hz, Hz per (unit/s), Hz
  float x = 0, dx = 0; bool primed = false;
  OneEuro(float minCutoffHz = 1.0f, float betaGain = 2.0f, float dCutoffHz = 1.0f)
    : minCutoff(minCutoffHz), beta(betaGain), dCutoff(dCutoffHz) {}
  static float alpha(float cutoff, float dt) { return 1/(1 + 1/(6.2831853f*cutoff*dt)); }
  void reset() { primed = false; }
  float filter(float v, float dt) {
    if (dt < 1e-3f) dt = 1e-3f;
    if (!primed) { x = v; dx = 0; primed = true; return x; }
    dx += alpha(dCutoff, dt)*((v - x)/dt - dx);
    x += alpha(minCutoff + beta*fabsf(dx), dt)*(v - x);
    return x;
  }
};

// Mahony complementary filter, accelerometer-only correction (no magnetometer, so yaw is gyro-integrated and drifts).
// q is q_WS. Accelerometer feedback fades out as |a| departs from 1 g, so hand acceleration does not tilt the model.
struct Mahony {
  Quat q; float kp = 1.5f; bool seeded = false;
  void seed(const Vec3 &acc) {
    float n = norm(acc); if (n < 0.5f) return;
    q = qBetween(scaled(acc, 1/n), {0,0,1}); seeded = true;
  }
  // gyro in rad/s, acc in g.
  void update(Vec3 gyro, const Vec3 &acc, float dt, float kpBoost = 1.0f) {
    if (!seeded) { seed(acc); if (!seeded) return; }
    float an = norm(acc), trust = clampf(1 - fabsf(an - 1)/0.2f, 0, 1);
    if (trust > 0) {
      Vec3 a = scaled(acc, 1/an);
      Vec3 v = {2*(q.x*q.z - q.w*q.y), 2*(q.w*q.x + q.y*q.z), q.w*q.w - q.x*q.x - q.y*q.y + q.z*q.z}; // world up in S
      Vec3 e = cross(a, v); float k = kp*kpBoost*trust;
      gyro.x += k*e.x; gyro.y += k*e.y; gyro.z += k*e.z;
    }
    Quat d = qMul(q, Quat{0, gyro.x, gyro.y, gyro.z});
    q = qNormalized({q.w + 0.5f*dt*d.w, q.x + 0.5f*dt*d.x, q.y + 0.5f*dt*d.y, q.z + 0.5f*dt*d.z});
  }
};

// Raw MPU samples in, hand orientation out. Applies accel offset/scale and gyro bias from calibration,
// tracks gyro bias slowly while the hand is still, and maps S -> H with the mounting quaternion.
// All time constants are in seconds, so the filter behaves the same at 100 Hz or 200 Hz.
struct ImuFusion {
  Mahony filter;
  Vec3 gyroBias, accOff, accScale = {1,1,1}; // deg/s, g, unitless
  Quat mount, yaw; bool hasMount = false;    // q_SH, and the world-Z heading offset
  Vec3 gLow, aLow, lastAcc, lastGyro;        // low-passes for stillness; last corrected sample (g, deg/s, sensor frame)
  float stillTime = 0, warmTime = 0;         // s
  float trackRange = 20.0f; // deg/s: how far zero-rate tracking may move the bias; tighten once the bias is calibrated

  Vec3 correctAccel(const Vec3 &raw) const {
    return {(raw.x - accOff.x)*accScale.x, (raw.y - accOff.y)*accScale.y, (raw.z - accOff.z)*accScale.z};
  }
  void restart() { filter = Mahony(); warmTime = 0; stillTime = 0; }
  void update(const Vec3 &rawAccG, const Vec3 &rawGyroDps, float dt) {
    Vec3 a = correctAccel(rawAccG);
    Vec3 g = {rawGyroDps.x - gyroBias.x, rawGyroDps.y - gyroBias.y, rawGyroDps.z - gyroBias.z};
    // Zero-rate tracking: noise-only gyro, steady 1 g, and still near the current bias. The trackRange cap stops a
    // slow constant turn from being learned as bias.
    float lp = clampf(dt/0.2f, 0, 1); // 0.2 s low-pass
    gLow.x += lp*(rawGyroDps.x - gLow.x); gLow.y += lp*(rawGyroDps.y - gLow.y); gLow.z += lp*(rawGyroDps.z - gLow.z);
    Vec3 dev = {rawGyroDps.x - gLow.x, rawGyroDps.y - gLow.y, rawGyroDps.z - gLow.z};
    Vec3 da = {a.x - aLow.x, a.y - aLow.y, a.z - aLow.z}; // against a low-pass, so sensor noise alone does not break stillness
    aLow.x += lp*da.x; aLow.y += lp*da.y; aLow.z += lp*da.z;
    bool still = norm(dev) < 1.0f && norm(da) < 0.025f && fabsf(norm(a) - 1) < 0.03f &&
                 norm({gLow.x - gyroBias.x, gLow.y - gyroBias.y, gLow.z - gyroBias.z}) < trackRange;
    stillTime = still ? stillTime + dt : 0;
    if (stillTime >= 1.0f) { // after 1 s of stillness, ~5 s time constant
      float k = clampf(dt/5.0f, 0, 1);
      gyroBias.x += k*g.x; gyroBias.y += k*g.y; gyroBias.z += k*g.z;
    }
    // First 2 s: strong accelerometer pull so the tilt locks on quickly after power-up.
    filter.update(scaled(g, DEG2RAD), a, dt, warmTime < 2.0f ? 8.0f : 1.0f);
    warmTime += dt; lastAcc = a; lastGyro = g;
  }
  Quat handInWorld() const { return qMul(filter.q, mount); }
  Quat orientation() const { return qNormalized(qMul(yaw, handInWorld())); }
  void resetHeading() { yaw = qFromAxisAngle({0,0,1}, -qYaw(handInWorld())); }
  // Gravity direction in the sensor frame as the filter currently believes it (unit vector).
  Vec3 gravityS() const {
    const Quat &q = filter.q;
    return {2*(q.x*q.z - q.w*q.y), 2*(q.w*q.x + q.y*q.z), q.w*q.w - q.x*q.x - q.y*q.y + q.z*q.z};
  }
  // Last sample in the hand frame. Acceleration has the estimated gravity removed (g); rate is bias-corrected (deg/s).
  // Independent of heading, so it is safe as a classifier input.
  Vec3 dynAccelHand() const {
    Vec3 g = gravityS();
    return qRotate(qConj(mount), {lastAcc.x - g.x, lastAcc.y - g.y, lastAcc.z - g.z});
  }
  Vec3 gyroHand() const { return qRotate(qConj(mount), lastGyro); }
};

// Maps a free-running sample counter to a microsecond timeline when only the time of each *read* is known.
// A sample cannot be newer than the read that returned it, so the true start of the sample train is bounded above by
// every read; the estimate follows the lowest bound (rising slowly to track clock drift). The sample period is
// re-measured against the host crystal every 2 s, which also corrects the MPU's own clock error (it is only ~1% accurate).
struct SampleClock {
  int64_t anchorT = 0;           // us, time of sample anchorSeq
  uint32_t anchorSeq = 0, periodQ16, nominalQ16; // period in us, Q16.16
  bool primed = false;
  uint32_t winSeq = 0; int64_t winT = 0, lastStamp = 0;
  explicit SampleClock(uint32_t nominalUs = 5000) : periodQ16(nominalUs << 16), nominalQ16(nominalUs << 16) {}
  float periodUs() const { return periodQ16 / 65536.0f; }
  int64_t timeOf(uint32_t seq) const { return anchorT + ((int64_t(int32_t(seq - anchorSeq))*periodQ16) >> 16); }
  // Timestamp to emit for a sample: timeOf(), but never earlier than 1 us after the previous one (the estimate
  // can step back by a few hundred us when a read turns out to have had low latency).
  int64_t stamp(uint32_t seq) { int64_t t = timeOf(seq); if (t <= lastStamp) t = lastStamp + 1; return lastStamp = t; }
  // newestSeq: counter of the newest sample in this read; readUs: when the read happened.
  void onRead(uint32_t newestSeq, int64_t readUs) {
    if (!primed) { anchorSeq = winSeq = newestSeq; anchorT = winT = readUs; primed = true; return; }
    int64_t cand = readUs - ((int64_t(int32_t(newestSeq - anchorSeq))*periodQ16) >> 16);
    if (cand < anchorT) anchorT = cand; else anchorT += 2;
    if (readUs - winT >= 2000000 && int32_t(newestSeq - winSeq) > 0) {
      int64_t measured = ((readUs - winT) << 16)/int32_t(newestSeq - winSeq);
      if (measured > int64_t(nominalQ16)*97/100 && measured < int64_t(nominalQ16)*103/100) {
        anchorT = timeOf(newestSeq); anchorSeq = newestSeq;       // re-anchor so the new period starts from here
        periodQ16 = uint32_t(int64_t(periodQ16) + (measured - int64_t(periodQ16))/4);
      }
      winSeq = newestSeq; winT = readUs;
    }
  }
};

// Flex sensor in a divider: the voltage is across the fixed resistor, so the flex resistance is derived first.
// Bend is normalised in the resistance domain, where flex sensors are close to linear in angle.
inline float flexResistance(float volts, float vcc, float rFixed) {
  volts = clampf(volts, 0.02f, vcc - 0.02f);
  return rFixed*(vcc/volts - 1);
}
// 0 at the open-hand resistance, 1 at the fist resistance. Works whichever way the sensor is wired.
inline float bendFraction(float r, float rOpen, float rFist) {
  float span = rFist - rOpen;
  if (fabsf(span) < 1) return 0;
  return clampf((r - rOpen)/span, 0, 1);
}
