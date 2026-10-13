import { describe, expect, test } from "vitest";
import {
  LIGHTING_PROFILES,
  MIN_AMBIENT_INTENSITY,
  MIN_HEMISPHERE_INTENSITY,
  lightingProfile,
} from "../src/app.js";

const MOODS = ["dawn", "day", "dusk", "night", "indoor"] as const;

describe("lighting profiles", () => {
  test("no generated game can be pitch black: every mood has a light floor", () => {
    for (const mood of MOODS) {
      const profile = LIGHTING_PROFILES[mood];
      expect(profile.ambient).toBeGreaterThanOrEqual(MIN_AMBIENT_INTENSITY);
      expect(profile.hemisphere).toBeGreaterThanOrEqual(MIN_HEMISPHERE_INTENSITY);
      expect(profile.directional).toBeGreaterThan(0);
      expect(profile.background).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test("night/indoor stay dimmer than day but keep a readable directional fill", () => {
    const day = LIGHTING_PROFILES.day;
    for (const mood of ["night", "indoor"] as const) {
      expect(LIGHTING_PROFILES[mood].directional).toBeLessThan(day.directional);
      expect(LIGHTING_PROFILES[mood].directional).toBeGreaterThanOrEqual(1);
      expect(LIGHTING_PROFILES[mood].hemisphere).toBeGreaterThan(0);
    }
  });

  test("defaults to day and maps explicit moods unchanged", () => {
    expect(lightingProfile(undefined)).toEqual(LIGHTING_PROFILES.day);
    for (const mood of MOODS) {
      expect(lightingProfile(mood)).toEqual(LIGHTING_PROFILES[mood]);
    }
  });
});
