import { expect, test } from "bun:test";
import { reversalsOf, ShakeDetector, SWING } from "./web/shake.ts";

const run = (det: ShakeDetector, pts: [number, number][], dtMs = 40) => {
  let hit = false;
  pts.forEach(([x, y], i) => {
    if (det.push(i * dtMs, x, y)) hit = true;
  });
  return hit;
};

test("向きの反転を数える(小さな揺れは無視)", () => {
  expect(reversalsOf([0, 20, 0, 20, 0], 6)).toBe(3);
  expect(reversalsOf([0, 2, 0, 2, 0], 6)).toBe(0);
  expect(reversalsOf([0, 10, 20, 30, 40], 6)).toBe(0);
});

test("短い距離を素早く往復すると、振る操作が成立する", () => {
  const det = new ShakeDetector(SWING);
  const pts: [number, number][] = [[100, 100], [125, 100], [100, 100], [125, 100], [100, 100], [125, 100]];
  expect(run(det, pts)).toBe(true);
});

test("まっすぐ動かすだけでは成立しない", () => {
  const det = new ShakeDetector(SWING);
  const pts: [number, number][] = Array.from({ length: 20 }, (_, i) => [100 + i * 15, 100]);
  expect(run(det, pts)).toBe(false);
});

test("大きく往復する移動は、振る操作ではなく移動とみなす", () => {
  const det = new ShakeDetector(SWING);
  const pts: [number, number][] = [[0, 100], [300, 100], [0, 100], [300, 100], [0, 100], [300, 100]];
  expect(run(det, pts)).toBe(false);
});

test("前後(縦)の往復だけを見るモードでは、横の往復は成立しない", () => {
  const det = new ShakeDetector(SWING, "vertical");
  const horizontal: [number, number][] = [[100, 100], [125, 100], [100, 100], [125, 100], [100, 100], [125, 100]];
  expect(run(det, horizontal)).toBe(false);
  const vertical: [number, number][] = [[100, 100], [100, 125], [100, 100], [100, 125], [100, 100], [100, 125]];
  expect(run(new ShakeDetector(SWING, "vertical"), vertical)).toBe(true);
});

test("成立後は一定時間、再判定しない", () => {
  const det = new ShakeDetector(SWING);
  const pts: [number, number][] = [[100, 100], [125, 100], [100, 100], [125, 100], [100, 100], [125, 100]];
  expect(run(det, pts)).toBe(true);
  // 直後の同じ操作は待ち時間中なので成立しない(時刻は続きから)
  let again = false;
  pts.forEach(([x, y], i) => {
    if (det.push(300 + i * 40, x, y)) again = true;
  });
  expect(again).toBe(false);
});
