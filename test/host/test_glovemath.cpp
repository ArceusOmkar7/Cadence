// Host-side checks for lib/GloveMath (no hardware, no Arduino). Build and run with any C++17 compiler:
//   g++ -std=c++17 -I lib/GloveMath test/host/test_glovemath.cpp -o test_glovemath && ./test_glovemath
// (or: python -m ziglang c++ ...). Exits non-zero on the first failed group.
#include <cstdio>
#include <cstdlib>
#include <random>
#include "GloveMath.h"

static int failures = 0;
#define CHECK(cond, ...) do { if (!(cond)) { failures++; printf("FAIL %s:%d  ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

static Vec3 rotate(const Quat &q, const Vec3 &v) {
  Quat r = qMul(qMul(q, Quat{0, v.x, v.y, v.z}), Quat{q.w, -q.x, -q.y, -q.z});
  return {r.x, r.y, r.z};
}
static Quat conj(const Quat &q) { return {q.w, -q.x, -q.y, -q.z}; }
static float angleBetween(const Vec3 &a, const Vec3 &b) { return acosf(clampf(dot(unit(a), unit(b)), -1, 1))*RAD2DEG; }
static float quatAngle(const Quat &a, const Quat &b) { // rotation angle between two orientations, degrees
  Quat d = qMul(conj(a), b); return 2*acosf(clampf(fabsf(d.w), 0, 1))*RAD2DEG;
}
static Quat expMap(const Vec3 &w, float dt) { // rotation by w*dt (rad)
  float ang = norm(w)*dt; if (ang < 1e-9f) return Quat();
  return qFromAxisAngle(unit(w), ang);
}

static void testQuaternions() {
  Quat q = qFromAxisAngle(unit({1,2,3}), 1.1f);
  Vec3 v = rotate(q, {0.3f,-0.5f,0.8f}), back = rotate(conj(q), v);
  CHECK(fabsf(back.x - 0.3f) < 1e-5f && fabsf(back.y + 0.5f) < 1e-5f && fabsf(back.z - 0.8f) < 1e-5f, "rotate/conj round trip");
  Vec3 a = unit({0.2f,-0.7f,0.4f}), b = unit({-0.5f,0.1f,0.9f});
  Vec3 ab = rotate(qBetween(a, b), a);
  CHECK(angleBetween(ab, b) < 0.01f, "qBetween maps a onto b (err %.4f deg)", angleBetween(ab, b));
  Vec3 opp = rotate(qBetween({0,0,1}, {0,0,-1}), {0,0,1});
  CHECK(angleBetween(opp, {0,0,-1}) < 0.01f, "qBetween handles opposite vectors");
  // a basis built from a rotation reproduces that rotation, in all four branches of the matrix conversion
  const Vec3 axes[4] = {unit({0.1f,0.2f,0.3f}), {1,0,0}, {0,1,0}, {0,0,1}};
  const float angles[4] = {0.5f, 3.0f, 3.0f, 3.0f};
  for (int i = 0; i < 4; i++) {
    Quat r = qFromAxisAngle(axes[i], angles[i]);
    Quat s = qFromBasis(rotate(r, {1,0,0}), rotate(r, {0,1,0}), rotate(r, {0,0,1}));
    CHECK(quatAngle(r, s) < 0.01f, "qFromBasis branch %d (err %.4f deg)", i, quatAngle(r, s));
  }
}

// Flat pose gives the dorsal normal, fingers-up pose the finger direction; together they must recover q_SH
// for any way the MPU is stuck on the hand, and the heading offset must not matter.
static void testMountCalibration() {
  std::mt19937 rng(7); std::uniform_real_distribution<float> U(-1, 1);
  for (int trial = 0; trial < 200; trial++) {
    Quat qSH = qNormalized({U(rng) + 0.01f, U(rng), U(rng), U(rng)});
    Quat yaw1 = qFromAxisAngle({0,0,1}, U(rng)*3.14f), yaw2 = qFromAxisAngle({0,0,1}, U(rng)*3.14f);
    Quat hFlat = yaw1, hUp = qMul(yaw2, qFromAxisAngle({0,1,0}, -1.5707963f)); // fingers (x) -> world up (z)
    Vec3 u = rotate(conj(qMul(hFlat, conj(qSH))), {0,0,1});  // accelerometer = world up in S
    Vec3 f = rotate(conj(qMul(hUp, conj(qSH))), {0,0,1});
    Vec3 x = unit({f.x - u.x*dot(f,u), f.y - u.y*dot(f,u), f.z - u.z*dot(f,u)});
    Quat got = qFromBasis(x, cross(u, x), u);
    CHECK(quatAngle(got, qSH) < 0.2f, "mount recovery trial %d err %.4f deg", trial, quatAngle(got, qSH));
    if (failures) return;
  }
}

struct Sim { // a rigid sensor with a true q_WS, spun by a body-rate profile
  Quat q; std::mt19937 rng{3}; std::normal_distribution<float> N{0, 1};
  Vec3 gyroBias = {1.7f, -2.4f, 0.9f}; float gyroNoise = 0.15f, accNoise = 0.004f;
  Vec3 trueRate;
  Vec3 accel() { Vec3 a = rotate(conj(q), {0,0,1}); return {a.x + accNoise*N(rng), a.y + accNoise*N(rng), a.z + accNoise*N(rng)}; }
  Vec3 gyro() { return {trueRate.x + gyroBias.x + gyroNoise*N(rng), trueRate.y + gyroBias.y + gyroNoise*N(rng), trueRate.z + gyroBias.z + gyroNoise*N(rng)}; }
  void step(const Vec3 &rateDps, float dt) { trueRate = rateDps; q = qNormalized(qMul(q, expMap(scaled(rateDps, DEG2RAD), dt))); }
};

static void testFusion(bool biasCalibrated) {
  Sim sim; sim.q = qFromAxisAngle(unit({1,1,0}), 0.7f); // starts tilted, filter has to find gravity
  ImuFusion fx; if (biasCalibrated) fx.gyroBias = sim.gyroBias;
  const float dt = 0.01f; float worstTilt = 0, worstTiltLate = 0;
  for (int k = 0; k < 4000; k++) { // 20 s of motion, then 20 s still
    float t = k*dt;
    Vec3 rate = k < 2000 ? Vec3{100*sinf(0.7f*t), 80*cosf(0.5f*t), 40*sinf(0.3f*t)} : Vec3{0,0,0};
    sim.step(rate, dt);
    fx.update(sim.accel(), sim.gyro(), dt);
    float tilt = angleBetween(rotate(conj(fx.filter.q), {0,0,1}), rotate(conj(sim.q), {0,0,1}));
    if (k > 300) worstTilt = fmaxf(worstTilt, tilt);   // after the initial lock-on
    if (k > 2200) worstTiltLate = fmaxf(worstTiltLate, tilt);
  }
  CHECK(worstTilt < 6.0f, "tilt error while moving (bias %s) worst %.2f deg", biasCalibrated ? "cal" : "uncal", worstTilt);
  CHECK(worstTiltLate < 1.0f, "tilt error at rest (bias %s) %.2f deg", biasCalibrated ? "cal" : "uncal", worstTiltLate);
  float yawErr = fabsf(qYaw(fx.filter.q) - qYaw(sim.q))*RAD2DEG; if (yawErr > 180) yawErr = 360 - yawErr;
  printf("  fusion (bias %s): worst tilt %.2f deg moving, %.2f at rest, final yaw error %.2f deg, learned bias %.2f %.2f %.2f\n",
         biasCalibrated ? "calibrated" : "unknown   ", worstTilt, worstTiltLate, yawErr, fx.gyroBias.x, fx.gyroBias.y, fx.gyroBias.z);
  if (biasCalibrated) CHECK(yawErr < 5.0f, "yaw drift with calibrated bias %.2f deg over 40 s", yawErr);
  else CHECK(fabsf(fx.gyroBias.x - sim.gyroBias.x) < 0.3f && fabsf(fx.gyroBias.y - sim.gyroBias.y) < 0.3f && fabsf(fx.gyroBias.z - sim.gyroBias.z) < 0.3f,
             "zero-rate tracking learned %.2f %.2f %.2f, true %.2f %.2f %.2f", fx.gyroBias.x, fx.gyroBias.y, fx.gyroBias.z, sim.gyroBias.x, sim.gyroBias.y, sim.gyroBias.z);
}

// Hand acceleration must not drag the tilt estimate: a violent shake with |a| far from 1 g is ignored.
static void testShakeRejection() {
  Sim sim; sim.q = Quat(); ImuFusion fx; fx.gyroBias = sim.gyroBias;
  std::mt19937 rng(11); std::uniform_real_distribution<float> U(-1, 1);
  for (int k = 0; k < 500; k++) { sim.step({0,0,0}, 0.01f); fx.update(sim.accel(), sim.gyro(), 0.01f); }
  float worst = 0;
  for (int k = 0; k < 200; k++) { // 2 s of 1.5 g bursts on the accelerometer only
    sim.step({0,0,0}, 0.01f);
    Vec3 a = sim.accel(); a = {a.x + 1.5f*U(rng), a.y + 1.5f*U(rng), a.z + 1.5f*U(rng)};
    fx.update(a, sim.gyro(), 0.01f);
    worst = fmaxf(worst, angleBetween(rotate(conj(fx.filter.q), {0,0,1}), {0,0,1}));
  }
  CHECK(worst < 8.0f, "tilt error during shake %.2f deg", worst);
  printf("  shake: worst tilt error %.2f deg\n", worst);
}

// Full chain: mount + heading reset. With the hand flat and heading reset the output is the identity; pitching
// the hand up 90 degrees about its own left axis gives exactly that rotation, whatever the MPU mounting.
static void testOrientationChain() {
  Quat qSH = qNormalized({0.8f, -0.3f, 0.45f, 0.2f});
  ImuFusion fx; fx.mount = qSH; fx.hasMount = true;
  Quat yawJunk = qFromAxisAngle({0,0,1}, 2.1f);
  fx.filter.q = qMul(yawJunk, conj(qSH)); fx.filter.seeded = true; // hand flat, pointing 2.1 rad off "forward"
  fx.resetHeading();
  CHECK(quatAngle(fx.orientation(), Quat()) < 0.01f, "flat + reset heading is identity (%.4f deg)", quatAngle(fx.orientation(), Quat()));
  Quat pitchUp = qFromAxisAngle({0,1,0}, -1.5707963f);               // fingers to the sky
  fx.filter.q = qMul(qMul(yawJunk, pitchUp), conj(qSH));
  CHECK(quatAngle(fx.orientation(), pitchUp) < 0.01f, "pitch up 90 deg after heading reset (%.4f deg)", quatAngle(fx.orientation(), pitchUp));
  Quat turnLeft = qFromAxisAngle({0,0,1}, 0.5f);
  fx.filter.q = qMul(qMul(qMul(turnLeft, yawJunk), Quat()), conj(qSH));
  CHECK(fabsf(qYaw(fx.orientation()) - 0.5f) < 1e-3f, "yaw follows a 0.5 rad left turn (%.4f)", qYaw(fx.orientation()));
}

static void testFilters() {
  std::mt19937 rng(5); std::normal_distribution<float> N(0, 1);
  OneEuro f(1.0f, 2.0f, 1.0f); const float dt = 0.04f, sigma = 0.02f; // 25 Hz
  float sumSq = 0; int n = 0;
  for (int k = 0; k < 500; k++) { float y = f.filter(0.5f + sigma*N(rng), dt); if (k > 50) { sumSq += (y - 0.5f)*(y - 0.5f); n++; } }
  float rms = sqrtf(sumSq/n);
  CHECK(rms < 0.5f*sigma, "OneEuro still-signal noise %.4f vs input %.4f", rms, sigma);
  float y = 0; int k = 0;
  for (; k < 100 && y < 0.9f; k++) y = f.filter(1.0f, dt);               // step input
  CHECK(k*dt < 0.5f, "OneEuro step response to 90%% took %.2f s", k*dt);
  printf("  one-euro: still noise %.4f (input %.4f), step to 90%% in %.2f s\n", rms, sigma, k*dt);
  // flex normalisation, either wiring direction
  const float vcc = 3.3f, rf = 10000;
  float rOpen = flexResistance(1.65f, vcc, rf), rFist = flexResistance(1.10f, vcc, rf);
  CHECK(fabsf(bendFraction(flexResistance(1.375f, vcc, rf), rOpen, rFist)) > 0.2f && bendFraction(rOpen, rOpen, rFist) == 0 && fabsf(bendFraction(rFist, rOpen, rFist) - 1) < 1e-6f, "bendFraction endpoints");
  CHECK(bendFraction(rFist*2, rOpen, rFist) == 1 && bendFraction(rOpen*0.5f, rOpen, rFist) == 0, "bendFraction clamps");
  CHECK(bendFraction(5, 100, 100) == 0, "bendFraction with no span is 0");
  float rO2 = flexResistance(1.10f, vcc, rf), rF2 = flexResistance(1.65f, vcc, rf);
  CHECK(fabsf(bendFraction(flexResistance(1.65f, vcc, rf), rO2, rF2) - 1) < 1e-6f, "bendFraction works when bending raises the voltage");
}

int main() {
  testQuaternions();
  testMountCalibration();
  testFusion(true);
  testFusion(false);
  testShakeRejection();
  testOrientationChain();
  testFilters();
  printf(failures ? "\n%d FAILED\n" : "\nall passed\n", failures);
  return failures ? 1 : 0;
}
