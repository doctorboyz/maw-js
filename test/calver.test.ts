import { describe, it, expect } from "bun:test";
import {
  compareBases,
  computeVersion,
  dateBase,
  effectiveBase,
  extractBaseFromVersion,
  maxLetterInHour,
  maxLetterInHourFromPackageJson,
  parseSuffix,
  renderSuffix,
} from "../scripts/calver";

describe("calver dateBase", () => {
  it("yy.m.d with no zero-pad (semver safety)", () => {
    expect(dateBase(new Date(2026, 3, 18, 9, 37))).toBe("26.4.18");
    expect(dateBase(new Date(2026, 1, 5, 9, 5))).toBe("26.2.5");
    expect(dateBase(new Date(2027, 0, 1, 0, 5))).toBe("27.1.1");
  });
});

describe("calver parseSuffix (#858 hour-bucket + collision letter)", () => {
  it("plain hour with no letter → letterIndex 0", () => {
    expect(parseSuffix("0")).toEqual({ hour: 0, letterIndex: 0 });
    expect(parseSuffix("12")).toEqual({ hour: 12, letterIndex: 0 });
    expect(parseSuffix("23")).toEqual({ hour: 23, letterIndex: 0 });
  });

  it("letter b → letterIndex 1, ..., z → 25", () => {
    expect(parseSuffix("16b")).toEqual({ hour: 16, letterIndex: 1 });
    expect(parseSuffix("16c")).toEqual({ hour: 16, letterIndex: 2 });
    expect(parseSuffix("16z")).toEqual({ hour: 16, letterIndex: 25 });
  });

  it("rejects letter 'a' (reserved for plain hour)", () => {
    expect(parseSuffix("16a")).toBeNull();
  });

  it("rejects out-of-range hour (legacy monotonic ≥ 24 must NOT poison)", () => {
    expect(parseSuffix("24")).toBeNull();
    expect(parseSuffix("25")).toBeNull();
    expect(parseSuffix("99")).toBeNull();
  });

  it("rejects multi-letter / non [b-z] / non-letter suffixes", () => {
    expect(parseSuffix("16ab")).toBeNull();
    expect(parseSuffix("16BB")).toBeNull(); // case-sensitive
    expect(parseSuffix("16-rc")).toBeNull();
    expect(parseSuffix("16.0")).toBeNull();
    expect(parseSuffix("16.b")).toBeNull();
    expect(parseSuffix("foo")).toBeNull();
    expect(parseSuffix("")).toBeNull();
  });
});

describe("calver renderSuffix", () => {
  it("letterIndex 0 → plain hour", () => {
    expect(renderSuffix(0, 0)).toBe("0");
    expect(renderSuffix(16, 0)).toBe("16");
  });

  it("letterIndex 1 → 'b', 2 → 'c', ..., 25 → 'z'", () => {
    expect(renderSuffix(16, 1)).toBe("16b");
    expect(renderSuffix(16, 2)).toBe("16c");
    expect(renderSuffix(16, 25)).toBe("16z");
  });

  it("throws on overflow (cap is letterIndex 25)", () => {
    expect(() => renderSuffix(16, 26)).toThrow(/overflow/i);
    expect(() => renderSuffix(16, -1)).toThrow(/overflow/i);
  });

  it("round-trip: parseSuffix(renderSuffix(h, n)) === { h, n }", () => {
    for (const h of [0, 5, 16, 23]) {
      for (const n of [0, 1, 12, 25]) {
        expect(parseSuffix(renderSuffix(h, n))).toEqual({ hour: h, letterIndex: n });
      }
    }
  });
});

describe("calver maxLetterInHour", () => {
  it("returns -1 when no matching tags for the hour", () => {
    expect(maxLetterInHour("26.4.29", "alpha", 16, [])).toBe(-1);
    expect(
      maxLetterInHour("26.4.29", "alpha", 16, ["v26.4.29-alpha.10", "v26.4.28-alpha.16"]),
    ).toBe(-1);
  });

  it("plain hour bucket → letterIndex 0", () => {
    expect(maxLetterInHour("26.4.29", "alpha", 16, ["v26.4.29-alpha.16"])).toBe(0);
  });

  it("walks letter sequence and returns max", () => {
    const tags = ["v26.4.29-alpha.16", "v26.4.29-alpha.16b", "v26.4.29-alpha.16c"];
    expect(maxLetterInHour("26.4.29", "alpha", 16, tags)).toBe(2);
  });

  it("non-monotonic tag order doesn't matter", () => {
    const tags = ["v26.4.29-alpha.16c", "v26.4.29-alpha.16", "v26.4.29-alpha.16b"];
    expect(maxLetterInHour("26.4.29", "alpha", 16, tags)).toBe(2);
  });

  it("isolates by hour — other-hour tags don't count", () => {
    const tags = ["v26.4.29-alpha.16", "v26.4.29-alpha.17", "v26.4.29-alpha.17b"];
    expect(maxLetterInHour("26.4.29", "alpha", 16, tags)).toBe(0);
    expect(maxLetterInHour("26.4.29", "alpha", 17, tags)).toBe(1);
  });

  it("isolates alpha and beta", () => {
    const tags = ["v26.4.29-alpha.16b", "v26.4.29-beta.16"];
    expect(maxLetterInHour("26.4.29", "alpha", 16, tags)).toBe(1);
    expect(maxLetterInHour("26.4.29", "beta", 16, tags)).toBe(0);
  });

  it("legacy monotonic tags ≥ 24 are rejected (don't poison)", () => {
    // From the pre-#858 monotonic counter: v26.4.29-alpha.24 etc. could exist.
    // parseSuffix rejects hour=24+, so these don't claim any bucket.
    const tags = ["v26.4.29-alpha.24", "v26.4.29-alpha.99"];
    for (let h = 0; h < 24; h++) {
      expect(maxLetterInHour("26.4.29", "alpha", h, tags)).toBe(-1);
    }
  });

  it("legacy monotonic tag ≤ 23 coexists as a same-hour collision", () => {
    // A tag like v26.4.29-alpha.21 from monotonic-era IS legitimately the
    // 21:xx hour bucket today. Treat it as a collision when bumping in 21.
    const tags = ["v26.4.29-alpha.21"];
    expect(maxLetterInHour("26.4.29", "alpha", 21, tags)).toBe(0); // claim plain
    expect(maxLetterInHour("26.4.29", "alpha", 18, tags)).toBe(-1); // hour 18 free
  });

  it("rejects two-tier or malformed suffixes", () => {
    const tags = ["v26.4.29-alpha.16.0", "v26.4.29-alpha.16-rc", "v26.4.29-alpha.16ab"];
    expect(maxLetterInHour("26.4.29", "alpha", 16, tags)).toBe(-1);
  });

  it("ignores tags from other dates", () => {
    const tags = ["v26.4.28-alpha.16z"];
    expect(maxLetterInHour("26.4.29", "alpha", 16, tags)).toBe(-1);
  });
});

describe("calver maxLetterInHourFromPackageJson", () => {
  it("returns letterIndex for matching base/channel/hour", () => {
    expect(maxLetterInHourFromPackageJson("26.4.29", "alpha", 16, "26.4.29-alpha.16")).toBe(0);
    expect(maxLetterInHourFromPackageJson("26.4.29", "alpha", 16, "26.4.29-alpha.16b")).toBe(1);
    expect(maxLetterInHourFromPackageJson("26.4.29", "alpha", 16, "v26.4.29-alpha.16c")).toBe(2);
  });

  it("returns -1 when hour does not match", () => {
    expect(maxLetterInHourFromPackageJson("26.4.29", "alpha", 17, "26.4.29-alpha.16")).toBe(-1);
    expect(maxLetterInHourFromPackageJson("26.4.29", "alpha", 16, "26.4.29-alpha.17b")).toBe(-1);
  });

  it("returns -1 when channel does not match", () => {
    expect(maxLetterInHourFromPackageJson("26.4.29", "alpha", 16, "26.4.29-beta.16")).toBe(-1);
    expect(maxLetterInHourFromPackageJson("26.4.29", "beta", 16, "26.4.29-alpha.16")).toBe(-1);
  });

  it("returns -1 when base does not match", () => {
    expect(maxLetterInHourFromPackageJson("26.4.29", "alpha", 16, "26.4.28-alpha.16")).toBe(-1);
  });

  it("returns -1 for empty / stable / malformed", () => {
    expect(maxLetterInHourFromPackageJson("26.4.29", "alpha", 16, "")).toBe(-1);
    expect(maxLetterInHourFromPackageJson("26.4.29", "alpha", 16, "26.4.29")).toBe(-1);
    expect(maxLetterInHourFromPackageJson("26.4.29", "alpha", 16, "26.4.29-alpha.")).toBe(-1);
    expect(maxLetterInHourFromPackageJson("26.4.29", "alpha", 16, "26.4.29-alpha.bogus")).toBe(-1);
  });

  it("rejects legacy monotonic ≥ 24 (for hour-mismatch reason)", () => {
    // alpha.99 cannot match any hour bucket — parseSuffix returns null.
    for (let h = 0; h < 24; h++) {
      expect(maxLetterInHourFromPackageJson("26.4.29", "alpha", h, "26.4.29-alpha.99")).toBe(-1);
    }
  });
});

describe("calver computeVersion (hour-bucket)", () => {
  // Date constructor uses 0-indexed months. (2026, 3, 29, 16, 0) = April 29, 16:00.
  const apr29_1600 = new Date(2026, 3, 29, 16, 0);
  const apr29_0900 = new Date(2026, 3, 29, 9, 0);
  const jan1_0005 = new Date(2027, 0, 1, 0, 5);

  it("stable: yy.m.d (ignores tags + hour)", () => {
    expect(computeVersion({ stable: true, check: false, now: apr29_1600 })).toBe("26.4.29");
    expect(computeVersion({ stable: true, check: false, now: jan1_0005 })).toBe("27.1.1");
  });

  it("alpha: plain hour when no tags exist for current hour", () => {
    expect(computeVersion({ stable: false, check: false, now: apr29_1600 }, [])).toBe(
      "26.4.29-alpha.16",
    );
    expect(computeVersion({ stable: false, check: false, now: apr29_0900 }, [])).toBe(
      "26.4.29-alpha.9",
    );
  });

  it("alpha: collision adds 'b'", () => {
    const tags = ["v26.4.29-alpha.16"];
    expect(computeVersion({ stable: false, check: false, now: apr29_1600 }, tags)).toBe(
      "26.4.29-alpha.16b",
    );
  });

  it("alpha: 'b' + 'c' + ... up to 'z'", () => {
    const baseTag = "v26.4.29-alpha.";
    const tags = [
      baseTag + "16",
      baseTag + "16b",
      baseTag + "16c",
      baseTag + "16d",
    ];
    expect(computeVersion({ stable: false, check: false, now: apr29_1600 }, tags)).toBe(
      "26.4.29-alpha.16e",
    );
  });

  it("alpha: 26-release-per-hour cap throws", () => {
    const tags: string[] = ["v26.4.29-alpha.16"];
    for (let i = 1; i <= 25; i++) {
      const letter = String.fromCharCode("a".charCodeAt(0) + i); // b..z
      tags.push("v26.4.29-alpha.16" + letter);
    }
    expect(() => computeVersion({ stable: false, check: false, now: apr29_1600 }, tags)).toThrow(
      /overflow/i,
    );
  });

  it("alpha: other-hour tags don't affect current hour", () => {
    const tags = ["v26.4.29-alpha.0", "v26.4.29-alpha.0b", "v26.4.29-alpha.17"];
    expect(computeVersion({ stable: false, check: false, now: apr29_1600 }, tags)).toBe(
      "26.4.29-alpha.16",
    );
  });

  it("alpha: ignores tags from other dates", () => {
    const tags = ["v26.4.28-alpha.16z", "v26.4.30-alpha.16"];
    expect(computeVersion({ stable: false, check: false, now: apr29_1600 }, tags)).toBe(
      "26.4.29-alpha.16",
    );
  });

  it("--hour override picks bucket explicitly", () => {
    expect(
      computeVersion({ stable: false, hour: 14, check: false, now: apr29_1600 }, []),
    ).toBe("26.4.29-alpha.14");
    expect(
      computeVersion(
        { stable: false, hour: 14, check: false, now: apr29_1600 },
        ["v26.4.29-alpha.14"],
      ),
    ).toBe("26.4.29-alpha.14b");
  });

  it("--stable ignores tags + hour entirely", () => {
    const tags = ["v26.4.29-alpha.16z"];
    expect(
      computeVersion({ stable: true, channel: "alpha", check: false, now: apr29_1600 }, tags),
    ).toBe("26.4.29");
  });
});

describe("calver beta channel (#754) under hour-bucket", () => {
  const apr29_1600 = new Date(2026, 3, 29, 16, 0);

  it("alpha and beta hour-buckets are independent", () => {
    const tags = ["v26.4.29-alpha.16", "v26.4.29-alpha.16b"];
    const alpha = computeVersion(
      { stable: false, channel: "alpha", check: false, now: apr29_1600 },
      tags,
    );
    const beta = computeVersion(
      { stable: false, channel: "beta", check: false, now: apr29_1600 },
      tags,
    );
    expect(alpha).toBe("26.4.29-alpha.16c");
    expect(beta).toBe("26.4.29-beta.16"); // beta space is empty
  });

  it("--beta with prior beta tags collides correctly", () => {
    const tags = ["v26.4.29-alpha.16z", "v26.4.29-beta.16", "v26.4.29-beta.16b"];
    expect(
      computeVersion({ stable: false, channel: "beta", check: false, now: apr29_1600 }, tags),
    ).toBe("26.4.29-beta.16c");
  });
});

describe("calver computeVersion package.json walk (hour-bucket)", () => {
  const apr29_1600 = new Date(2026, 3, 29, 16, 0);
  const apr30_0500 = new Date(2026, 3, 30, 5, 0);

  it("package.json sets the only collision in this hour", () => {
    expect(
      computeVersion({ stable: false, check: false, now: apr29_1600 }, [], "26.4.29-alpha.16"),
    ).toBe("26.4.29-alpha.16b");
  });

  it("tags + package.json: take the max collision", () => {
    const tags = ["v26.4.29-alpha.16b"];
    expect(
      computeVersion({ stable: false, check: false, now: apr29_1600 }, tags, "26.4.29-alpha.16"),
    ).toBe("26.4.29-alpha.16c");
  });

  it("date roll: clock advances → fresh hour-bucket starts at plain hh", () => {
    expect(
      computeVersion({ stable: false, check: false, now: apr30_0500 }, [], "26.4.29-alpha.18z"),
    ).toBe("26.4.30-alpha.5");
  });

  it("post-stable bare YY.M.D in package.json: fresh bucket on that date", () => {
    expect(
      computeVersion({ stable: false, check: false, now: apr29_1600 }, [], "26.4.29"),
    ).toBe("26.4.29-alpha.16");
  });

  it("legacy monotonic in package.json (alpha.23 from #766 era) does not poison", () => {
    // hour=23 → that legacy tag IS a hour-23 plain-bucket claim, so a 23:xx
    // bump becomes 23b. But for any non-23 hour the legacy tag is irrelevant.
    expect(
      computeVersion({ stable: false, check: false, now: apr29_1600 }, [], "26.4.29-alpha.23"),
    ).toBe("26.4.29-alpha.16");
    // And during the 23:00 hour:
    const apr29_2300 = new Date(2026, 3, 29, 23, 0);
    expect(
      computeVersion({ stable: false, check: false, now: apr29_2300 }, [], "26.4.29-alpha.23"),
    ).toBe("26.4.29-alpha.23b");
  });
});

describe("calver future-dated package.json (#819 still applies)", () => {
  const apr28_1200 = new Date(2026, 3, 28, 12, 0);

  it("future-dated alpha continues on package.json's date", () => {
    // package.json at 26.4.29-alpha.5, clock at 2026-04-28 12:00.
    // effectiveBase picks 26.4.29; bump should claim hour=12 on that date.
    expect(
      computeVersion({ stable: false, check: false, now: apr28_1200 }, [], "26.4.29-alpha.5"),
    ).toBe("26.4.29-alpha.12");
  });

  it("--stable always uses today's clock", () => {
    expect(
      computeVersion({ stable: true, check: false, now: apr28_1200 }, [], "26.4.29-alpha.5"),
    ).toBe("26.4.28");
  });
});

describe("calver extractBaseFromVersion + compareBases + effectiveBase (#819 unchanged)", () => {
  it("strips hour-bucket suffix variants too", () => {
    expect(extractBaseFromVersion("26.4.29-alpha.16")).toBe("26.4.29");
    expect(extractBaseFromVersion("26.4.29-alpha.16b")).toBe("26.4.29");
    expect(extractBaseFromVersion("26.4.29-alpha.16z")).toBe("26.4.29");
    expect(extractBaseFromVersion("v26.4.29")).toBe("26.4.29");
  });

  it("compareBases by integer segment (regression coverage)", () => {
    expect(compareBases("26.4.30", "26.4.4")).toBeGreaterThan(0);
    expect(compareBases("26.4.4", "26.4.30")).toBeLessThan(0);
    expect(compareBases("27.1.1", "26.12.31")).toBeGreaterThan(0);
  });

  it("effectiveBase picks future package.json over today's clock", () => {
    expect(effectiveBase("26.4.28", "26.4.29-alpha.16b")).toBe("26.4.29");
    expect(effectiveBase("26.4.30", "26.4.28-alpha.16b")).toBe("26.4.30");
    expect(effectiveBase("26.4.28", "")).toBe("26.4.28");
  });
});
