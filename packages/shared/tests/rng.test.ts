import { SeededRng } from "../src/rng.js";
test("rng deterministic", () => {
  const a = new SeededRng(42), b = new SeededRng(42);
  const va = [a.next(), a.next(), a.next()], vb = [b.next(), b.next(), b.next()];
  expect(va).toEqual(vb);
});
